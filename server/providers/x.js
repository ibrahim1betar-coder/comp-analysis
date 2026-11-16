import { fetchJson, qs, ApiError } from '../http.js';

const API = 'https://api.x.com/2';

export function parseHandle(input) {
  const h = String(input).trim();
  const m = h.match(/(?:x|twitter)\.com\/([A-Za-z0-9_]+)/i);
  return m ? m[1] : h.replace(/^@/, '');
}

export default {
  id: 'x',
  name: 'X (Twitter)',
  capabilities: { views: true, interactions: true, followers: true, shares: true, saves: true },
  credentialFields: [{ key: 'bearerToken', label: 'App bearer token (Basic tier or higher)', secret: true, placeholder: 'AAAA…' }],
  handlePlaceholder: '@username or profile URL',

  headers(creds) {
    return { Authorization: `Bearer ${creds.bearerToken}` };
  },

  async test(creds) {
    const data = await fetchJson(`${API}/users/by/username/X?${qs({ 'user.fields': 'public_metrics' })}`, { headers: this.headers(creds) });
    if (!data.data) throw new ApiError('Token accepted but the lookup returned nothing');
    return 'Bearer token is valid. Reading other users\' posts requires the Basic tier or higher.';
  },

  async fetchAccount(handle, creds, { since, maxPosts }) {
    const username = parseHandle(handle);
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
