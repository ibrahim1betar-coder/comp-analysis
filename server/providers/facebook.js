/** Facebook Pages via Apify (public data, no Meta app review needed). Default actors: apify/facebook-posts-scraper + apify/facebook-pages-scraper. */
import { ApiError } from '../http.js';
import { runActor, whoAmI, pick, num, when } from '../apify.js';

export function parseHandle(input) {
  const h = String(input).trim();
  const m = h.match(/facebook\.com\/(?:profile\.php\?id=(\d+)|([A-Za-z0-9_.-]+))/i);
  if (m) return m[1] || m[2];
  return h.replace(/^@/, '');
}
const pageUrl = (page) => (/^\d+$/.test(page) ? `https://www.facebook.com/profile.php?id=${page}` : `https://www.facebook.com/${page}`);

const typeOf = (p) => {
  const media = pick(p, 'media');
  const first = Array.isArray(media) ? media[0] : media;
  const t = String(pick(first || {}, 'type', '__typename') || pick(p, 'type', 'postType') || '').toLowerCase();
  if (t.includes('video') || t.includes('reel') || pick(p, 'videoUrl', 'video')) return 'video';
  if (Array.isArray(media) && media.length > 1) return 'carousel';
  if (t.includes('photo') || t.includes('image')) return 'image';
  if (pick(p, 'link')) return 'link';
  return 'text';
};

export function mapPost(p) {
  const id = pick(p, 'postId', 'post_id', 'id', 'legacyId');
  if (!id) return null;
  const media = pick(p, 'media');
  const first = Array.isArray(media) ? media[0] : media;
  return {
    externalId: String(id),
    publishedAt: when(pick(p, 'timestamp', 'time', 'publishedAt', 'date', 'createdAt')),
    type: typeOf(p),
    url: pick(p, 'url', 'postUrl', 'topLevelUrl') || null,
    caption: pick(p, 'text', 'message', 'caption') || '',
    thumbnailUrl: pick(first || {}, 'thumbnail', 'image.uri', 'photo_image.uri', 'url') || null,
    views: num(pick(p, 'viewsCount', 'videoViewCount', 'views', 'playCount')),
    likes: num(pick(p, 'likes', 'likesCount', 'reactionsCount', 'reactions', 'reactionCount')) ?? 0,
    comments: num(pick(p, 'comments', 'commentsCount', 'commentCount')) ?? 0,
    shares: num(pick(p, 'shares', 'sharesCount', 'shareCount')) ?? 0,
    saves: 0,
  };
}

export default {
  id: 'facebook',
  name: 'Facebook',
  source: 'Apify',
  capabilities: { views: true, interactions: true, followers: true, shares: true, saves: false },
  credentialFields: [
    { key: 'apifyToken', label: 'Apify API token', secret: true, placeholder: 'apify_api_…', shared: 'apify' },
    { key: 'actor', label: 'Posts actor', secret: false, placeholder: 'apify/facebook-posts-scraper', optional: true, hint: 'Leave empty for apify/facebook-posts-scraper.' },
    { key: 'pageActor', label: 'Page actor', secret: false, placeholder: 'apify/facebook-pages-scraper', optional: true, hint: 'Used for follower counts. Leave empty for the default.' },
  ],
  handlePlaceholder: 'Page username, page ID or page URL',

  async test(creds) {
    const me = await whoAmI(creds.apifyToken);
    return `Apify token works (account: ${me.username || me.id}). Facebook posts, reactions, comments, shares and video views will be collected with ${creds.actor || 'apify/facebook-posts-scraper'}.`;
  },

  async fetchAccount(handle, creds, { since, maxPosts }) {
    const page = parseHandle(handle);
    const token = creds.apifyToken;
    const url = pageUrl(page);
    const items = await runActor(token, creds.actor || 'apify/facebook-posts-scraper', {
      startUrls: [{ url }],
      resultsLimit: Math.min(maxPosts, 200),
      onlyPostsNewerThan: since ? since.slice(0, 10) : undefined,
      captionText: false,
    });
    if (items[0]?.error) throw new ApiError(`Apify: ${items[0].errorDescription || items[0].error}`, { status: 404 });
    const posts = [];
    for (const it of items) {
      const p = mapPost(it);
      if (!p || !p.publishedAt) continue;
      if (since && p.publishedAt < since) continue;
      posts.push(p);
    }
    const pageName = pick(items[0] || {}, 'pageName', 'user.name', 'pageTitle');
    let profile = { externalId: page, displayName: pageName || page, profileUrl: url, avatarUrl: null, followers: null, following: null, postsCount: null, totalViews: null, totalLikes: null };
    try {
      const [pg] = await runActor(token, creds.pageActor || 'apify/facebook-pages-scraper', { startUrls: [{ url }] }, { timeoutSecs: 120 });
      if (pg) profile = {
        externalId: String(pick(pg, 'pageId', 'facebookId', 'id') || page),
        displayName: pick(pg, 'title', 'name', 'pageName') || pageName || page,
        avatarUrl: pick(pg, 'profilePictureUrl', 'profilePhoto', 'pageProfilePicture', 'profilePic') || null,
        profileUrl: pick(pg, 'pageUrl', 'facebookUrl', 'url') || url,
        followers: num(pick(pg, 'followers', 'followersCount', 'followerCount')),
        following: null,
        postsCount: null,
        totalViews: null,
        totalLikes: num(pick(pg, 'likes', 'likesCount', 'pageLikes')),
      };
    } catch (err) {
      if (!posts.length) throw err;
    }
    if (!posts.length && profile.followers === null) throw new ApiError(`Facebook page "${page}" returned no data (misspelled, restricted, or the actor failed)`, { status: 404 });
    return { profile, posts };
  },
};
