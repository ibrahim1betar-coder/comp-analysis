import { fetchJson, qs, ApiError } from '../http.js';

const API = 'https://graph.facebook.com/v21.0';

export function parseHandle(input) {
  const h = String(input).trim();
  const m = h.match(/facebook\.com\/(?:profile\.php\?id=(\d+)|([A-Za-z0-9_.-]+))/i);
  if (m) return m[1] || m[2];
  return h.replace(/^@/, '');
}

const typeOf = (p) => {
  const t = p.attachments?.data?.[0]?.media_type;
  if (t === 'video') return 'video';
  if (t === 'photo') return 'image';
  if (t === 'album') return 'carousel';
  if (t === 'link') return 'link';
  return 'text';
};

export default {
  id: 'facebook',
  name: 'Facebook',
  // Public pages you do not manage expose reactions, comments and shares; video views only on your own pages.
  capabilities: { views: false, interactions: true, followers: true, shares: true, saves: false },
  credentialFields: [{ key: 'accessToken', label: 'Access token (app or page token with Page Public Content Access)', secret: true, placeholder: 'EAAG…' }],
  handlePlaceholder: 'Page username, page ID or page URL',

  async test(creds) {
    const data = await fetchJson(`${API}/me?${qs({ fields: 'id,name', access_token: creds.accessToken })}`);
    return `Token is valid (${data.name || data.id}). Reading pages you do not manage requires the "Page Public Content Access" feature on your app.`;
  },

  async fetchAccount(handle, creds, { since, maxPosts }) {
    const page = parseHandle(handle);
    const token = creds.accessToken;
    const p = await fetchJson(`${API}/${encodeURIComponent(page)}?${qs({ fields: 'id,name,username,link,fan_count,followers_count,picture{url}', access_token: token })}`);
    if (!p.id) throw new ApiError(`Facebook page "${handle}" was not found`, { status: 404 });
    const profile = {
      externalId: p.id,
      displayName: p.name,
      avatarUrl: p.picture?.data?.url || null,
      profileUrl: p.link || `https://www.facebook.com/${p.username || p.id}`,
      followers: p.followers_count ?? p.fan_count ?? null,
      following: null,
      postsCount: null,
      totalViews: null,
      totalLikes: p.fan_count ?? null,
    };

    const posts = [];
    let url = `${API}/${p.id}/posts?${qs({
      fields: 'id,message,created_time,permalink_url,shares,reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0),attachments{media_type,media}',
      limit: 100,
      since: since ? Math.floor(new Date(since).getTime() / 1000) : undefined,
      access_token: token,
    })}`;
    while (url && posts.length < maxPosts) {
      const data = await fetchJson(url);
      for (const post of data.data || []) {
        posts.push({
          externalId: post.id,
          publishedAt: new Date(post.created_time).toISOString(),
          type: typeOf(post),
          url: post.permalink_url,
          caption: post.message || '',
          thumbnailUrl: post.attachments?.data?.[0]?.media?.image?.src || null,
          views: null,
          likes: post.reactions?.summary?.total_count ?? 0,
          comments: post.comments?.summary?.total_count ?? 0,
          shares: post.shares?.count ?? 0,
          saves: 0,
        });
        if (posts.length >= maxPosts) break;
      }
      url = data.paging?.next || null;
    }
    return { profile, posts };
  },
};
