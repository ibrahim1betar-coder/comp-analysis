import { fetchJson, qs, ApiError } from '../http.js';

const VERSION = 'v21.0';

export function parseHandle(input) {
  const h = String(input).trim();
  const m = h.match(/instagram\.com\/([A-Za-z0-9_.]+)/i);
  return (m ? m[1] : h.replace(/^@/, '')).toLowerCase();
}

const typeOf = (m) => {
  if (m.media_product_type === 'REELS') return 'reel';
  if (m.media_type === 'VIDEO') return 'video';
  if (m.media_type === 'CAROUSEL_ALBUM') return 'carousel';
  return 'image';
};

export default {
  id: 'instagram',
  name: 'Instagram',
  // Business Discovery exposes likes and comments of other accounts, not their play counts.
  capabilities: { views: false, interactions: true, followers: true, shares: false, saves: false },
  credentialFields: [
    { key: 'accessToken', label: 'Long-lived access token', secret: true, placeholder: 'EAAG…' },
    { key: 'igUserId', label: 'Your Instagram professional account ID', secret: false, placeholder: '1784…' },
    { key: 'host', label: 'Graph host', secret: false, placeholder: 'graph.facebook.com', optional: true, hint: 'Use graph.instagram.com if your app uses "Instagram API with Instagram Login".' },
  ],
  handlePlaceholder: '@username or profile URL (business or creator accounts only)',

  base(creds) {
    return `https://${(creds.host || 'graph.facebook.com').replace(/^https?:\/\//, '').replace(/\/$/, '')}/${VERSION}`;
  },

  async test(creds) {
    const me = await fetchJson(`${this.base(creds)}/${encodeURIComponent(creds.igUserId)}?${qs({ fields: 'id,username,followers_count', access_token: creds.accessToken })}`);
    return `Connected as @${me.username} (${me.followers_count ?? '?'} followers). Business Discovery is available.`;
  },

  async fetchAccount(handle, creds, { since, maxPosts }) {
    const username = parseHandle(handle);
    let after = null;
    let profile = null;
    const posts = [];
    let stop = false;
    while (!stop && posts.length < maxPosts) {
      const mediaArgs = `.limit(50)${after ? `.after(${after})` : ''}`;
      const fields = `business_discovery.username(${username}){id,username,name,profile_picture_url,followers_count,follows_count,media_count,media${mediaArgs}{id,caption,like_count,comments_count,media_type,media_product_type,permalink,timestamp,thumbnail_url,media_url}}`;
      const data = await fetchJson(`${this.base(creds)}/${encodeURIComponent(creds.igUserId)}?${qs({ fields, access_token: creds.accessToken })}`);
      const bd = data.business_discovery;
      if (!bd) throw new ApiError(`Instagram account "${username}" was not found or is not a professional account`, { status: 404 });
      profile ??= {
        externalId: bd.id,
        displayName: bd.name || bd.username,
        avatarUrl: bd.profile_picture_url || null,
        profileUrl: `https://www.instagram.com/${bd.username}/`,
        followers: bd.followers_count ?? null,
        following: bd.follows_count ?? null,
        postsCount: bd.media_count ?? null,
        totalViews: null,
        totalLikes: null,
      };
      for (const m of bd.media?.data || []) {
        if (since && m.timestamp < since) {
          stop = true;
          break;
        }
        posts.push({
          externalId: m.id,
          publishedAt: new Date(m.timestamp).toISOString(),
          type: typeOf(m),
          url: m.permalink,
          caption: m.caption || '',
          thumbnailUrl: m.thumbnail_url || (m.media_type === 'IMAGE' ? m.media_url : null),
          views: null,
          likes: m.like_count ?? 0,
          comments: m.comments_count ?? 0,
          shares: 0,
          saves: 0,
        });
        if (posts.length >= maxPosts) break;
      }
      after = bd.media?.paging?.cursors?.after;
      if (!after || !bd.media?.paging?.next) break;
    }
    return { profile, posts };
  },
};
