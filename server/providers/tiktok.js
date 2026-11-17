/** TikTok with two sources: Apify (clockworks/tiktok-scraper, public data) or TikTok's official Research API. */
import { fetchJson, qs, ApiError } from '../http.js';
import { runActor, whoAmI, pick, num, when } from '../apify.js';

const API = 'https://open.tiktokapis.com/v2';
const tokenCache = new Map(); // clientKey -> { token, expiresAt }

export function parseHandle(input) {
  const h = String(input).trim();
  const m = h.match(/tiktok\.com\/@([A-Za-z0-9_.]+)/i);
  return (m ? m[1] : h.replace(/^@/, '')).toLowerCase();
}

const yyyymmdd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');

/* ---------- Apify source ---------- */
/** Map one clockworks/tiktok-scraper item to our post shape. */
export function mapApifyPost(v, username) {
  const id = pick(v, 'id', 'videoId');
  if (!id) return null;
  const author = pick(v, 'authorMeta.name', 'author.uniqueId', 'authorName') || username;
  return {
    externalId: String(id),
    publishedAt: when(pick(v, 'createTimeISO', 'createTime', 'timestamp')),
    type: pick(v, 'isSlideshow') ? 'carousel' : 'video',
    url: pick(v, 'webVideoUrl', 'url') || `https://www.tiktok.com/@${author}/video/${id}`,
    caption: pick(v, 'text', 'desc', 'description') || '',
    thumbnailUrl: pick(v, 'videoMeta.coverUrl', 'covers.default', 'cover') || null,
    views: num(pick(v, 'playCount', 'viewCount', 'stats.playCount')) ?? 0,
    likes: num(pick(v, 'diggCount', 'likeCount', 'stats.diggCount')) ?? 0,
    comments: num(pick(v, 'commentCount', 'stats.commentCount')) ?? 0,
    shares: num(pick(v, 'shareCount', 'stats.shareCount')) ?? 0,
    saves: num(pick(v, 'collectCount', 'stats.collectCount')) ?? 0,
  };
}
export function mapApifyProfile(items, username) {
  const a = pick(items[0] || {}, 'authorMeta', 'author') || {};
  return {
    externalId: String(pick(a, 'id') || username),
    displayName: pick(a, 'nickName', 'nickname', 'name') || username,
    avatarUrl: pick(a, 'avatar', 'avatarLarger', 'avatarThumb') || null,
    profileUrl: `https://www.tiktok.com/@${pick(a, 'name', 'uniqueId') || username}`,
    followers: num(pick(a, 'fans', 'followerCount', 'followers')),
    following: num(pick(a, 'following', 'followingCount')),
    postsCount: num(pick(a, 'video', 'videoCount')),
    totalViews: null,
    totalLikes: num(pick(a, 'heart', 'heartCount', 'likes')),
  };
}

async function fetchViaApify(username, creds, { since, maxPosts }) {
  const items = await runActor(creds.apifyToken, creds.actor || 'clockworks/tiktok-scraper', {
    profiles: [username],
    resultsPerPage: Math.min(maxPosts, 200),
    oldestPostDate: since ? since.slice(0, 10) : undefined,
    shouldDownloadVideos: false,
    shouldDownloadCovers: false,
    shouldDownloadSubtitles: false,
    shouldDownloadSlideshowImages: false,
  }, { timeoutSecs: 300 });
  if (items[0]?.error) throw new ApiError(`Apify: ${items[0].errorDescription || items[0].error}`, { status: 404 });
  const posts = items.map((v) => mapApifyPost(v, username)).filter((p) => p && p.publishedAt && (!since || p.publishedAt >= since));
  if (!items.length) throw new ApiError(`TikTok account "@${username}" returned no videos (private, misspelled, or the actor failed)`, { status: 404 });
  return { profile: mapApifyProfile(items, username), posts };
}

/* ---------- official Research API source ---------- */
async function getToken(creds) {
  const cached = tokenCache.get(creds.clientKey);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
  const data = await fetchJson(`${API}/oauth/token/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: qs({ client_key: creds.clientKey, client_secret: creds.clientSecret, grant_type: 'client_credentials' }),
  });
  if (!data.access_token) throw new ApiError(data.error_description || data.error || 'TikTok did not return an access token', { status: 401 });
  tokenCache.set(creds.clientKey, { token: data.access_token, expiresAt: Date.now() + (data.expires_in || 7200) * 1000 });
  return data.access_token;
}

async function fetchViaResearchApi(username, creds, { since, maxPosts }) {
  const token = await getToken(creds);
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const info = await fetchJson(`${API}/research/user/info/?fields=display_name,avatar_url,follower_count,following_count,likes_count,video_count`, { method: 'POST', headers, body: JSON.stringify({ username }) });
  if (info.error && info.error.code && info.error.code !== 'ok') throw new ApiError(info.error.message || 'TikTok user lookup failed', { status: 400 });
  const u = info.data || {};
  const profile = {
    externalId: username, displayName: u.display_name || username, avatarUrl: u.avatar_url || null, profileUrl: `https://www.tiktok.com/@${username}`,
    followers: u.follower_count ?? null, following: u.following_count ?? null, postsCount: u.video_count ?? null, totalViews: null, totalLikes: u.likes_count ?? null,
  };
  // The Research API accepts at most 30 days per query, so walk back in 30-day windows.
  const posts = [];
  const floor = since ? new Date(since) : new Date(Date.now() - 90 * 86400_000);
  let windowEnd = new Date();
  while (windowEnd > floor && posts.length < maxPosts) {
    const windowStart = new Date(Math.max(floor.getTime(), windowEnd.getTime() - 29 * 86400_000));
    let cursor = 0; let searchId; let hasMore = true;
    while (hasMore && posts.length < maxPosts) {
      const res = await fetchJson(`${API}/research/video/query/?fields=id,create_time,username,like_count,comment_count,share_count,view_count,video_description`, {
        method: 'POST', headers,
        body: JSON.stringify({ query: { and: [{ operation: 'EQ', field_name: 'username', field_values: [username] }] }, start_date: yyyymmdd(windowStart), end_date: yyyymmdd(windowEnd), max_count: 100, cursor, search_id: searchId }),
      });
      const d = res.data || {};
      for (const v of d.videos || []) posts.push({
        externalId: String(v.id), publishedAt: new Date((v.create_time || 0) * 1000).toISOString(), type: 'video',
        url: `https://www.tiktok.com/@${username}/video/${v.id}`, caption: v.video_description || '', thumbnailUrl: null,
        views: v.view_count ?? 0, likes: v.like_count ?? 0, comments: v.comment_count ?? 0, shares: v.share_count ?? 0, saves: 0,
      });
      hasMore = Boolean(d.has_more); cursor = d.cursor ?? cursor + 100; searchId = d.search_id ?? searchId;
    }
    windowEnd = new Date(windowStart.getTime() - 86400_000);
  }
  return { profile, posts };
}

export default {
  id: 'tiktok',
  name: 'TikTok',
  source: 'Apify or TikTok Research API',
  capabilities: { views: true, interactions: true, followers: true, shares: true, saves: true },
  credentialFields: [
    { key: 'source', label: 'Data source', type: 'select', options: [['apify', 'Apify (clockworks/tiktok-scraper)'], ['research', 'TikTok Research API (official, approval required)']], secret: false },
    { key: 'apifyToken', label: 'Apify API token', secret: true, placeholder: 'apify_api_…', shared: 'apify', showWhen: { source: 'apify' } },
    { key: 'actor', label: 'Apify actor', secret: false, placeholder: 'clockworks/tiktok-scraper', optional: true, showWhen: { source: 'apify' }, hint: 'Leave empty for the default actor.' },
    { key: 'clientKey', label: 'Research API client key', secret: false, placeholder: 'aw…', showWhen: { source: 'research' } },
    { key: 'clientSecret', label: 'Research API client secret', secret: true, placeholder: '…', showWhen: { source: 'research' } },
  ],
  handlePlaceholder: '@username or profile URL',

  async test(creds) {
    if ((creds.source || 'apify') === 'research') {
      await getToken(creds);
      return 'Research API credentials accepted. Your app needs approved access to the TikTok Research API.';
    }
    const me = await whoAmI(creds.apifyToken);
    return `Apify token works (account: ${me.username || me.id}). TikTok videos, views, likes, comments, shares and saves will be collected with ${creds.actor || 'clockworks/tiktok-scraper'}.`;
  },

  async fetchAccount(handle, creds, opts) {
    const username = parseHandle(handle);
    return (creds.source || 'apify') === 'research' ? fetchViaResearchApi(username, creds, opts) : fetchViaApify(username, creds, opts);
  },
};
