/** Instagram via Apify (public data, no Meta app needed). Default actor: apify/instagram-scraper. */
import { ApiError } from '../http.js';
import { runActor, whoAmI, pick, num, when } from '../apify.js';
import { instagramTest, instagramFetch } from './graph.js';

export function parseHandle(input) {
  const h = String(input).trim();
  const m = h.match(/instagram\.com\/([A-Za-z0-9_.]+)/i);
  return (m ? m[1] : h.replace(/^@/, '')).toLowerCase();
}

const typeOf = (p) => {
  const product = String(pick(p, 'productType') || '').toLowerCase();
  const t = String(pick(p, 'type', 'mediaType', '__typename') || '').toLowerCase();
  if (product === 'clips' || product === 'reels' || t.includes('reel')) return 'reel';
  if (t.includes('video') || pick(p, 'videoUrl')) return 'video';
  if (t.includes('sidecar') || t.includes('carousel') || t.includes('album')) return 'carousel';
  return 'image';
};

/** Map one Apify Instagram post item (several actor versions) to our post shape. */
export function mapPost(p) {
  const shortCode = pick(p, 'shortCode', 'shortcode', 'code');
  const id = pick(p, 'id', 'pk') || shortCode;
  if (!id) return null;
  const plays = num(pick(p, 'videoPlayCount', 'playCount', 'videoViewCount', 'viewCount', 'video_view_count'));
  return {
    externalId: String(id),
    publishedAt: when(pick(p, 'timestamp', 'takenAtTimestamp', 'taken_at', 'takenAt', 'createdAt')),
    type: typeOf(p),
    url: pick(p, 'url', 'postUrl') || (shortCode ? `https://www.instagram.com/p/${shortCode}/` : null),
    caption: pick(p, 'caption', 'text') || '',
    thumbnailUrl: pick(p, 'displayUrl', 'thumbnailUrl', 'imageUrl', 'display_url') || null,
    views: plays, // null for images: no view count
    likes: num(pick(p, 'likesCount', 'likeCount', 'likes', 'like_count')) ?? 0,
    comments: num(pick(p, 'commentsCount', 'commentCount', 'comments', 'comment_count')) ?? 0,
    shares: num(pick(p, 'sharesCount', 'shareCount', 'reshareCount')) ?? 0,
    saves: 0,
  };
}

export default {
  id: 'instagram',
  name: 'Instagram',
  source: 'Apify or Meta Graph API',
  capabilities: { views: true, interactions: true, followers: true, shares: false, saves: false },
  capabilitiesFor: (creds) => (creds?.source === 'graph' ? { views: false, interactions: true, followers: true, shares: false, saves: false } : undefined),
  credentialFields: [
    { key: 'source', label: 'Data source', type: 'select', options: [['apify', 'Apify (public data incl. reel views)'], ['graph', 'Meta Graph API (official, your own Meta app)']], secret: false },
    { key: 'apifyToken', label: 'Apify API token', secret: true, placeholder: 'apify_api_…', shared: 'apify', showWhen: { source: 'apify' } },
    { key: 'accessToken', label: 'Meta access token (long-lived)', secret: true, placeholder: 'EAAG…', showWhen: { source: 'graph' }, hint: 'Filled automatically by "Connect with Facebook" on the Meta card.' },
    { key: 'igUserId', label: 'Your Instagram professional account ID', secret: false, placeholder: '1784…', showWhen: { source: 'graph' } },
  ],
  handlePlaceholder: '@username or profile URL (any public account)',

  async test(creds) {
    if (creds.source === 'graph') return instagramTest(creds);
    const me = await whoAmI(creds.apifyToken);
    return `Apify token works (account: ${me.username || me.id}). Instagram posts and reels views will be collected with ${process.env.APIFY_INSTAGRAM_ACTOR || 'apify/instagram-scraper'}.`;
  },

  async fetchAccount(handle, creds, { since, maxPosts }) {
    const username = parseHandle(handle);
    if (creds.source === 'graph') return instagramFetch(username, creds, { since, maxPosts });
    const token = creds.apifyToken;
    const limit = maxPosts;

    // 1) Posts (one actor run). resultsType "posts" walks the profile feed newest-first.
    const items = await runActor(token, process.env.APIFY_INSTAGRAM_ACTOR || 'apify/instagram-scraper', {
      directUrls: [`https://www.instagram.com/${username}/`],
      resultsType: 'posts',
      resultsLimit: limit,
      addParentData: false,
      onlyPostsNewerThan: since ? since.slice(0, 10) : undefined,
    });
    const first = items[0];
    if (first && first.error) throw new ApiError(`Apify: ${first.errorDescription || first.error}`, { status: 404 });
    const posts = [];
    for (const it of items) {
      const p = mapPost(it);
      if (!p || !p.publishedAt) continue;
      if (since && p.publishedAt < since) continue;
      posts.push(p);
    }

    // 2) Profile (followers). A separate small actor run; failures here do not lose the posts.
    let profile = { externalId: username, displayName: username, profileUrl: `https://www.instagram.com/${username}/`, avatarUrl: null, followers: null, following: null, postsCount: null, totalViews: null, totalLikes: null };
    try {
      const [pr] = await runActor(token, process.env.APIFY_INSTAGRAM_PROFILE_ACTOR || 'apify/instagram-profile-scraper', { usernames: [username] }, { timeoutSecs: 120 });
      if (pr) profile = {
        externalId: String(pick(pr, 'id', 'pk') || username),
        displayName: pick(pr, 'fullName', 'full_name', 'name') || username,
        avatarUrl: pick(pr, 'profilePicUrlHD', 'profilePicUrl', 'profile_pic_url') || null,
        profileUrl: `https://www.instagram.com/${username}/`,
        followers: num(pick(pr, 'followersCount', 'followers', 'follower_count', 'edge_followed_by.count')),
        following: num(pick(pr, 'followsCount', 'following', 'following_count')),
        postsCount: num(pick(pr, 'postsCount', 'mediaCount', 'media_count')),
        totalViews: null,
        totalLikes: null,
      };
      // Profile scrapers return the latest posts too; use them if the posts run came back empty.
      if (!posts.length && Array.isArray(pr?.latestPosts)) for (const it of pr.latestPosts) { const p = mapPost(it); if (p && p.publishedAt && (!since || p.publishedAt >= since)) posts.push(p); }
    } catch (err) {
      if (!posts.length) throw err;
    }
    if (!posts.length && profile.followers === null) throw new ApiError(`Instagram account "${username}" returned no data (private, misspelled, or the actor failed)`, { status: 404 });
    return { profile, posts };
  },
};
