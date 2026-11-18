/** Meta Graph API fetchers (official): Instagram Business Discovery and Facebook Page posts. */
import { fetchJson, qs, ApiError } from '../http.js';

export const GRAPH_VERSION = 'v21.0';
export const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;
/** Facebook's built-in redirect for manual / desktop login flows: accepted without whitelisting. */
export const MANUAL_REDIRECT = 'https://www.facebook.com/connect/login_success.html';
export const META_SCOPES = ['pages_show_list', 'pages_read_engagement', 'instagram_basic', 'instagram_manage_insights', 'business_management'];

const igType = (m) => {
  if (m.media_product_type === 'REELS') return 'reel';
  if (m.media_type === 'VIDEO') return 'video';
  if (m.media_type === 'CAROUSEL_ALBUM') return 'carousel';
  return 'image';
};

export async function instagramTest(creds) {
  const me = await fetchJson(`${GRAPH}/${encodeURIComponent(creds.igUserId)}?${qs({ fields: 'id,username,followers_count', access_token: creds.accessToken })}`);
  return `Connected to Meta as @${me.username} (${me.followers_count ?? '?'} followers). Business Discovery is available for competitors' business/creator accounts.`;
}

export async function instagramFetch(username, creds, { since, maxPosts }) {
  let after = null;
  let profile = null;
  const posts = [];
  let stop = false;
  while (!stop && posts.length < maxPosts) {
    const mediaArgs = `.limit(50)${after ? `.after(${after})` : ''}`;
    const fields = `business_discovery.username(${username}){id,username,name,profile_picture_url,followers_count,follows_count,media_count,media${mediaArgs}{id,caption,like_count,comments_count,media_type,media_product_type,permalink,timestamp,thumbnail_url,media_url}}`;
    const data = await fetchJson(`${GRAPH}/${encodeURIComponent(creds.igUserId)}?${qs({ fields, access_token: creds.accessToken })}`);
    const bd = data.business_discovery;
    if (!bd) throw new ApiError(`Instagram account "${username}" was not found or is not a business/creator account`, { status: 404 });
    profile ??= {
      externalId: bd.id, displayName: bd.name || bd.username, avatarUrl: bd.profile_picture_url || null, profileUrl: `https://www.instagram.com/${bd.username}/`,
      followers: bd.followers_count ?? null, following: bd.follows_count ?? null, postsCount: bd.media_count ?? null, totalViews: null, totalLikes: null,
    };
    for (const m of bd.media?.data || []) {
      const publishedAt = new Date(m.timestamp).toISOString();
      if (since && publishedAt < since) { stop = true; break; }
      posts.push({
        externalId: m.id, publishedAt, type: igType(m), url: m.permalink, caption: m.caption || '',
        thumbnailUrl: m.thumbnail_url || (m.media_type === 'IMAGE' ? m.media_url : null),
        views: null, // Meta does not expose play counts of accounts you do not own
        likes: m.like_count ?? 0, comments: m.comments_count ?? 0, shares: 0, saves: 0,
      });
      if (posts.length >= maxPosts) break;
    }
    after = bd.media?.paging?.cursors?.after;
    if (!after || !bd.media?.paging?.next) break;
  }
  const diagnostics = [];
  if (!posts.length && profile?.postsCount) diagnostics.push(`Meta reports ${profile.postsCount} posts for @${username} but Business Discovery returned none. Check that the token was generated with instagram_basic and instagram_manage_insights, that your own Instagram account is a professional account linked to your Facebook Page, and that the competitor is a business/creator account. The Apify source has no such requirement.`);
  return { profile, posts, diagnostics };
}

const fbType = (p) => {
  const t = p.attachments?.data?.[0]?.media_type;
  if (t === 'video') return 'video';
  if (t === 'photo') return 'image';
  if (t === 'album') return 'carousel';
  if (t === 'link') return 'link';
  return 'text';
};

export async function facebookTest(creds) {
  const data = await fetchJson(`${GRAPH}/me?${qs({ fields: 'id,name', access_token: creds.accessToken })}`);
  return `Meta token is valid (${data.name || data.id}). Reading Pages you do not manage needs the "Page Public Content Access" feature approved on your app.`;
}

export async function facebookFetch(page, creds, { since, maxPosts }) {
  const token = creds.accessToken;
  const p = await fetchJson(`${GRAPH}/${encodeURIComponent(page)}?${qs({ fields: 'id,name,username,link,fan_count,followers_count,picture{url}', access_token: token })}`);
  if (!p.id) throw new ApiError(`Facebook page "${page}" was not found`, { status: 404 });
  const profile = {
    externalId: p.id, displayName: p.name, avatarUrl: p.picture?.data?.url || null, profileUrl: p.link || `https://www.facebook.com/${p.username || p.id}`,
    followers: p.followers_count ?? p.fan_count ?? null, following: null, postsCount: null, totalViews: null, totalLikes: p.fan_count ?? null,
  };
  const posts = [];
  let url = `${GRAPH}/${p.id}/posts?${qs({
    fields: 'id,message,created_time,permalink_url,shares,reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0),attachments{media_type,media}',
    limit: 100, since: since ? Math.floor(new Date(since).getTime() / 1000) : undefined, access_token: token,
  })}`;
  while (url && posts.length < maxPosts) {
    const data = await fetchJson(url);
    for (const post of data.data || []) {
      posts.push({
        externalId: post.id, publishedAt: new Date(post.created_time).toISOString(), type: fbType(post), url: post.permalink_url, caption: post.message || '',
        thumbnailUrl: post.attachments?.data?.[0]?.media?.image?.src || null, views: null,
        likes: post.reactions?.summary?.total_count ?? 0, comments: post.comments?.summary?.total_count ?? 0, shares: post.shares?.count ?? 0, saves: 0,
      });
      if (posts.length >= maxPosts) break;
    }
    url = data.paging?.next || null;
  }
  const diagnostics = [];
  if (!posts.length) diagnostics.push(`Meta returned no posts for the Page "${profile.displayName}". For Pages you do not manage, Meta only returns posts once your app has the "Page Public Content Access" feature approved (App Review). Until then, set Facebook's data source to Apify.`);
  return { profile, posts, diagnostics };
}

/** OAuth helpers for "Connect with Facebook". */
export function oauthUrl({ appId, redirectUri, state, configId }) {
  // "Facebook Login for Business" apps use a login configuration (config_id) instead of a scope list.
  const params = configId
    ? { client_id: appId, redirect_uri: redirectUri, state, config_id: configId, response_type: 'code', override_default_response_type: 'true' }
    : { client_id: appId, redirect_uri: redirectUri, state, scope: META_SCOPES.join(','), response_type: 'code' };
  return `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth?${qs(params)}`;
}
export async function exchangeCode({ appId, appSecret, redirectUri, code }) {
  const short = await fetchJson(`${GRAPH}/oauth/access_token?${qs({ client_id: appId, client_secret: appSecret, redirect_uri: redirectUri, code })}`);
  const long = await fetchJson(`${GRAPH}/oauth/access_token?${qs({ grant_type: 'fb_exchange_token', client_id: appId, client_secret: appSecret, fb_exchange_token: short.access_token })}`);
  return long.access_token || short.access_token;
}
/** Turn any user token of this app (e.g. from the Graph API Explorer, valid 1-2 h) into a long-lived one (about 60 days). */
export async function extendToken({ appId, appSecret, token }) {
  try {
    const long = await fetchJson(`${GRAPH}/oauth/access_token?${qs({ grant_type: 'fb_exchange_token', client_id: appId, client_secret: appSecret, fb_exchange_token: token })}`);
    return { token: long.access_token || token, extended: Boolean(long.access_token), expiresIn: long.expires_in || null };
  } catch (e) {
    return { token, extended: false, error: e.message };
  }
}

/** Pages the user manages and the Instagram professional accounts linked to them. */
export async function discoverAccounts(accessToken) {
  const me = await fetchJson(`${GRAPH}/me?${qs({ fields: 'id,name', access_token: accessToken })}`);
  const pages = await fetchJson(`${GRAPH}/me/accounts?${qs({ fields: 'id,name,instagram_business_account{id,username}', limit: 100, access_token: accessToken })}`);
  const list = (pages.data || []).map((p) => ({ pageId: p.id, pageName: p.name, igUserId: p.instagram_business_account?.id || null, igUsername: p.instagram_business_account?.username || null }));
  return { user: me, pages: list };
}

/** Pull the `code` (and `state`) out of the Success page address the user pasted. Accepts a bare code too. */
export function parsePastedRedirect(text) {
  const t = String(text || '').trim();
  if (!t) return {};
  try {
    const u = new URL(t);
    const code = u.searchParams.get('code') || new URLSearchParams(u.hash.replace(/^#/, '')).get('code');
    const state = u.searchParams.get('state') || new URLSearchParams(u.hash.replace(/^#/, '')).get('state');
    const error = u.searchParams.get('error_description') || u.searchParams.get('error');
    return { code, state, error };
  } catch {
    return /^[\w-]+$/.test(t) ? { code: t } : {};
  }
}
