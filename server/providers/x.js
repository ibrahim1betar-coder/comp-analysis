import { fetchJson, qs, ApiError } from '../http.js';
import { runActor, whoAmI, pick, num, when } from '../apify.js';

const API = 'https://api.x.com/2';

export function parseHandle(input) {
  const h = String(input).trim();
  const m = h.match(/(?:x|twitter)\.com\/([A-Za-z0-9_]+)/i);
  return m ? m[1] : h.replace(/^@/, '');
}

/** Map one apidojo/tweet-scraper item to our post shape. */
export function mapApifyTweet(t, username) {
  const id = pick(t, 'id', 'id_str', 'tweetId');
  if (!id) return null;
  const media = pick(t, 'extendedEntities.media', 'media') || [];
  const video = Array.isArray(media) && media.find((m) => m.type === 'video' || m.type === 'animated_gif');
  return {
    externalId: String(id),
    publishedAt: when(pick(t, 'createdAt', 'created_at', 'timestamp')),
    type: video ? 'video' : Array.isArray(media) && media.length ? 'image' : 'text',
    url: pick(t, 'url', 'twitterUrl') || `https://x.com/${username}/status/${id}`,
    caption: pick(t, 'text', 'fullText', 'full_text') || '',
    thumbnailUrl: video ? pick(video, 'media_url_https', 'mediaUrl') || null : null,
    views: num(pick(t, 'viewCount', 'views', 'impressions')) ?? null,
    likes: num(pick(t, 'likeCount', 'favorite_count', 'likes')) ?? 0,
    comments: num(pick(t, 'replyCount', 'reply_count', 'replies')) ?? 0,
    shares: (num(pick(t, 'retweetCount', 'retweet_count', 'retweets')) ?? 0) + (num(pick(t, 'quoteCount', 'quote_count', 'quotes')) ?? 0),
    saves: num(pick(t, 'bookmarkCount', 'bookmark_count', 'bookmarks')) ?? 0,
  };
}

async function fetchViaApify(username, creds, { since, maxPosts }) {
  const items = await runActor(creds.apifyToken, process.env.APIFY_X_ACTOR || 'apidojo/tweet-scraper', {
    twitterHandles: [username], maxItems: maxPosts, sort: 'Latest', onlyVerifiedUsers: false, includeSearchTerms: false,
    start: since ? since.slice(0, 10) : undefined,
  });
  if (items[0]?.error || items[0]?.noResults) throw new ApiError(`Apify: ${items[0].errorDescription || items[0].error || 'no results'}`, { status: 404 });
  const posts = items.map((t) => mapApifyTweet(t, username)).filter((p) => p && p.publishedAt && (!since || p.publishedAt >= since));
  const a = pick(items[0] || {}, 'author') || {};
  const profile = {
    externalId: String(pick(a, 'id', 'id_str') || username), displayName: pick(a, 'name') || username, avatarUrl: pick(a, 'profilePicture', 'profile_image_url_https') || null,
    profileUrl: `https://x.com/${pick(a, 'userName', 'screen_name') || username}`, followers: num(pick(a, 'followers', 'followers_count')), following: num(pick(a, 'following', 'friends_count')),
    postsCount: num(pick(a, 'statusesCount', 'statuses_count')), totalViews: null, totalLikes: null,
  };
  if (!posts.length && profile.followers === null) throw new ApiError(`X account "@${username}" returned no data from Apify`, { status: 404 });
  return { profile, posts };
}

export default {
  id: 'x',
  name: 'X (Twitter)',
  source: 'X API or Apify',
  capabilities: { views: true, interactions: true, followers: true, shares: true, saves: true },
  credentialFields: [
    { key: 'source', label: 'Data source', type: 'select', options: [['api', 'X API v2 (official, Basic tier or higher)'], ['apify', 'Apify (apidojo/tweet-scraper)']], secret: false },
    { key: 'bearerToken', label: 'App bearer token', secret: true, placeholder: 'AAAA…', showWhen: { source: 'api' } },
    { key: 'apifyToken', label: 'Apify API token', secret: true, placeholder: 'apify_api_…', shared: 'apify', showWhen: { source: 'apify' } },
  ],
  defaultSource: 'api',
  handlePlaceholder: '@username or profile URL',

  headers(creds) {
    return { Authorization: `Bearer ${creds.bearerToken}` };
  },

  async test(creds) {
    if (creds.source === 'apify') {
      const me = await whoAmI(creds.apifyToken);
      return `Apify token works (account: ${me.username || me.id}). X posts will be collected with ${process.env.APIFY_X_ACTOR || 'apidojo/tweet-scraper'}.`;
    }
    const data = await fetchJson(`${API}/users/by/username/X?${qs({ 'user.fields': 'public_metrics' })}`, { headers: this.headers(creds) });
    if (!data.data) throw new ApiError('Token accepted but the lookup returned nothing');
    return 'Bearer token is valid. Reading other users\' posts requires the Basic tier or higher.';
  },

  async fetchAccount(handle, creds, { since, maxPosts }) {
    const username = parseHandle(handle);
    if (creds.source === 'apify') return fetchViaApify(username, creds, { since, maxPosts });
    const headers = this.headers(creds);
    const ures = await fetchJson(`${API}/users/by/username/${encodeURIComponent(username)}?${qs({ 'user.fields': 'public_metrics,profile_image_url,name,username' })}`, { headers });
    const u = ures.data;
    if (!u) throw new ApiError(`X account "@${username}" was not found`, { status: 404 });
    const profile = {
      externalId: u.id,
      displayName: u.name,
      avatarUrl: u.profile_image_url || null,
      profileUrl: `https://x.com/${u.username}`,
      followers: u.public_metrics?.followers_count ?? null,
      following: u.public_metrics?.following_count ?? null,
      postsCount: u.public_metrics?.tweet_count ?? null,
      totalViews: null,
      totalLikes: null,
    };

    const posts = [];
    let paginationToken;
    while (posts.length < maxPosts) {
      const data = await fetchJson(`${API}/users/${u.id}/tweets?${qs({
        max_results: 100,
        exclude: 'retweets,replies',
        'tweet.fields': 'public_metrics,created_at,attachments',
        expansions: 'attachments.media_keys',
        'media.fields': 'public_metrics,type,preview_image_url',
        start_time: since || undefined,
        pagination_token: paginationToken,
      })}`, { headers });
      const media = new Map((data.includes?.media || []).map((m) => [m.media_key, m]));
      for (const t of data.data || []) {
        const pm = t.public_metrics || {};
        const attached = (t.attachments?.media_keys || []).map((k) => media.get(k)).filter(Boolean);
        const video = attached.find((m) => m.type === 'video' || m.type === 'animated_gif');
        const videoViews = attached.reduce((s, m) => s + (m.public_metrics?.view_count || 0), 0);
        posts.push({
          externalId: t.id,
          publishedAt: new Date(t.created_at).toISOString(),
          type: video ? 'video' : attached.length ? 'image' : 'text',
          url: `https://x.com/${u.username}/status/${t.id}`,
          caption: t.text || '',
          thumbnailUrl: video?.preview_image_url || null,
          // Video view count when the post has video, otherwise the post's impressions.
          views: video ? videoViews : pm.impression_count ?? null,
          likes: pm.like_count ?? 0,
          comments: pm.reply_count ?? 0,
          shares: (pm.retweet_count ?? 0) + (pm.quote_count ?? 0),
          saves: pm.bookmark_count ?? 0,
        });
        if (posts.length >= maxPosts) break;
      }
      paginationToken = data.meta?.next_token;
      if (!paginationToken) break;
    }
    return { profile, posts };
  },
};
