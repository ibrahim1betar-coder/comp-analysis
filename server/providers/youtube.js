import { fetchJson, qs, ApiError } from '../http.js';
import { runActor, whoAmI, pick, num, when } from '../apify.js';

const API = 'https://www.googleapis.com/youtube/v3';

export function parseHandle(input) {
  const h = String(input).trim();
  const m = h.match(/youtube\.com\/(?:@([^/?#]+)|channel\/(UC[\w-]+)|c\/([^/?#]+)|user\/([^/?#]+))/i);
  if (m) {
    if (m[1]) return { forHandle: decodeURIComponent(m[1]) };
    if (m[2]) return { id: m[2] };
    if (m[3]) return { forHandle: m[3] };
    if (m[4]) return { forUsername: m[4] };
  }
  if (/^UC[\w-]{20,}$/.test(h)) return { id: h };
  return { forHandle: h.replace(/^@/, '') };
}

/** ISO-8601 duration (PT1H2M3S) to seconds. */
export function durationSeconds(iso) {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || '');
  if (!m) return 0;
  return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
}

const n = (v) => (v === undefined || v === null ? null : Number(v));

/** Map one streamers/youtube-scraper item to our post shape. */
export function mapApifyVideo(v) {
  const id = pick(v, 'id', 'videoId') || (pick(v, 'url') || '').match(/[?&]v=([\w-]+)/)?.[1];
  if (!id) return null;
  const secs = num(pick(v, 'duration')) ?? durationSeconds(pick(v, 'duration') || '') ?? 0;
  return {
    externalId: String(id),
    publishedAt: when(pick(v, 'date', 'publishedAt', 'uploadDate')),
    type: pick(v, 'isShort') || /shorts\//.test(pick(v, 'url') || '') || (secs > 0 && secs <= 60) ? 'short' : 'video',
    url: pick(v, 'url') || `https://www.youtube.com/watch?v=${id}`,
    caption: pick(v, 'title') || '',
    thumbnailUrl: pick(v, 'thumbnailUrl') || null,
    views: num(pick(v, 'viewCount', 'views')) ?? 0,
    likes: num(pick(v, 'likes', 'likeCount')) ?? 0,
    comments: num(pick(v, 'commentsCount', 'commentCount')) ?? 0,
    shares: 0,
    saves: 0,
  };
}

function channelUrl(handle) {
  const q = parseHandle(handle);
  if (q.id) return `https://www.youtube.com/channel/${q.id}/videos`;
  if (q.forUsername) return `https://www.youtube.com/user/${q.forUsername}/videos`;
  return `https://www.youtube.com/@${q.forHandle}/videos`;
}

async function fetchViaApify(handle, creds, { since, maxPosts }) {
  const items = await runActor(creds.apifyToken, process.env.APIFY_YOUTUBE_ACTOR || 'streamers/youtube-scraper', {
    startUrls: [{ url: channelUrl(handle) }], maxResults: maxPosts, maxResultsShorts: maxPosts, maxResultStreams: 0,
    oldestPostDate: since ? since.slice(0, 10) : undefined, sortVideosBy: 'NEWEST',
  });
  if (items[0]?.error) throw new ApiError(`Apify: ${items[0].errorDescription || items[0].error}`, { status: 404 });
  const posts = items.map(mapApifyVideo).filter((p) => p && p.publishedAt && (!since || p.publishedAt >= since));
  const first = items[0] || {};
  const profile = {
    externalId: pick(first, 'channelId') || handle, displayName: pick(first, 'channelName', 'channelUsername') || handle,
    avatarUrl: pick(first, 'channelAvatarUrl') || null, profileUrl: pick(first, 'channelUrl') || channelUrl(handle).replace(/\/videos$/, ''),
    followers: num(pick(first, 'numberOfSubscribers', 'subscriberCount')), following: null, postsCount: num(pick(first, 'channelTotalVideos')), totalViews: num(pick(first, 'channelTotalViews')), totalLikes: null,
  };
  if (!posts.length && profile.followers === null) throw new ApiError(`YouTube channel "${handle}" returned no data from Apify`, { status: 404 });
  return { profile, posts };
}

export default {
  id: 'youtube',
  name: 'YouTube',
  source: 'YouTube Data API or Apify',
  capabilities: { views: true, interactions: true, followers: true, shares: false, saves: false },
  credentialFields: [
    { key: 'source', label: 'Data source', type: 'select', options: [['api', 'YouTube Data API v3 (official, your own API key)'], ['apify', 'Apify (streamers/youtube-scraper)']], secret: false },
    { key: 'apiKey', label: 'YouTube Data API v3 key', secret: true, placeholder: 'AIza…', showWhen: { source: 'api' } },
    { key: 'apifyToken', label: 'Apify API token', secret: true, placeholder: 'apify_api_…', shared: 'apify', showWhen: { source: 'apify' } },
  ],
  defaultSource: 'api',
  handlePlaceholder: '@handle, channel URL or UC… channel ID',

  async test(creds) {
    if (creds.source === 'apify') {
      const me = await whoAmI(creds.apifyToken);
      return `Apify token works (account: ${me.username || me.id}). YouTube videos will be collected with ${process.env.APIFY_YOUTUBE_ACTOR || 'streamers/youtube-scraper'}.`;
    }
    const data = await fetchJson(`${API}/channels?${qs({ part: 'id', forHandle: 'YouTube', key: creds.apiKey })}`);
    if (!data.items?.length) throw new ApiError('Key accepted but the test lookup returned no channel');
    return 'API key is valid. Quota: 10,000 units/day; one sync of 300 videos costs about 15 units.';
  },

  async fetchAccount(handle, creds, { since, maxPosts }) {
    if (creds.source === 'apify') return fetchViaApify(handle, creds, { since, maxPosts });
    const key = creds.apiKey;
    const lookup = parseHandle(handle);
    const ch = await fetchJson(`${API}/channels?${qs({ part: 'snippet,statistics,contentDetails', ...lookup, key })}`);
    const c = ch.items?.[0];
    if (!c) throw new ApiError(`YouTube channel "${handle}" was not found`, { status: 404 });

    const profile = {
      externalId: c.id,
      displayName: c.snippet.title,
      avatarUrl: c.snippet.thumbnails?.default?.url || null,
      profileUrl: c.snippet.customUrl ? `https://www.youtube.com/${c.snippet.customUrl}` : `https://www.youtube.com/channel/${c.id}`,
      followers: n(c.statistics.subscriberCount),
      following: null,
      postsCount: n(c.statistics.videoCount),
      totalViews: n(c.statistics.viewCount),
      totalLikes: null,
    };

    // 1) Walk the uploads playlist newest-first until we are older than `since` or hit the cap.
    const uploads = c.contentDetails?.relatedPlaylists?.uploads;
    const ids = [];
    let pageToken;
    let stop = false;
    while (uploads && !stop && ids.length < maxPosts) {
      const pl = await fetchJson(`${API}/playlistItems?${qs({ part: 'contentDetails', playlistId: uploads, maxResults: 50, pageToken, key })}`);
      for (const it of pl.items || []) {
        const published = it.contentDetails?.videoPublishedAt;
        if (since && published && published < since) {
          stop = true;
          break;
        }
        ids.push(it.contentDetails.videoId);
        if (ids.length >= maxPosts) break;
      }
      pageToken = pl.nextPageToken;
      if (!pageToken) break;
    }

    // 2) Statistics in batches of 50 (one quota unit each).
    const posts = [];
    for (let i = 0; i < ids.length; i += 50) {
      const batch = ids.slice(i, i + 50);
      const vids = await fetchJson(`${API}/videos?${qs({ part: 'snippet,statistics,contentDetails', id: batch.join(','), key })}`);
      for (const v of vids.items || []) {
        const secs = durationSeconds(v.contentDetails?.duration);
        const live = v.snippet?.liveBroadcastContent && v.snippet.liveBroadcastContent !== 'none';
        posts.push({
          externalId: v.id,
          publishedAt: v.snippet.publishedAt,
          type: live ? 'live' : secs > 0 && secs <= 60 ? 'short' : 'video',
          url: `https://www.youtube.com/watch?v=${v.id}`,
          caption: v.snippet.title,
          thumbnailUrl: v.snippet.thumbnails?.medium?.url || null,
          views: n(v.statistics?.viewCount) ?? 0,
          likes: n(v.statistics?.likeCount) ?? 0,
          comments: n(v.statistics?.commentCount) ?? 0,
          shares: 0,
          saves: 0,
        });
      }
    }
    return { profile, posts };
  },
};
