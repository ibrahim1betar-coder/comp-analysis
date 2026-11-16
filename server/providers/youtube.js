import { fetchJson, qs, ApiError } from '../http.js';

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

export default {
  id: 'youtube',
  name: 'YouTube',
  capabilities: { views: true, interactions: true, followers: true, shares: false, saves: false },
  credentialFields: [{ key: 'apiKey', label: 'YouTube Data API v3 key', secret: true, placeholder: 'AIza…' }],
  handlePlaceholder: '@handle, channel URL or UC… channel ID',

  async test(creds) {
    const data = await fetchJson(`${API}/channels?${qs({ part: 'id', forHandle: 'YouTube', key: creds.apiKey })}`);
    if (!data.items?.length) throw new ApiError('Key accepted but the test lookup returned no channel');
    return 'API key is valid. Quota: 10,000 units/day; one sync of 300 videos costs about 15 units.';
  },

  async fetchAccount(handle, creds, { since, maxPosts }) {
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
