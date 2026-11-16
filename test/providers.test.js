import './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHandle as yt, durationSeconds } from '../server/providers/youtube.js';
import { parseHandle as ig } from '../server/providers/instagram.js';
import { parseHandle as tt } from '../server/providers/tiktok.js';
import { parseHandle as x } from '../server/providers/x.js';
import { parseHandle as fb } from '../server/providers/facebook.js';
import { normaliseHandle } from '../server/providers/index.js';
import { parseCsv, toCsv } from '../server/csv.js';
import { encryptJson, decryptJson, mask } from '../server/crypto.js';
import { extractApiMessage } from '../server/http.js';
import youtube from '../server/providers/youtube.js';

test('handles are parsed from URLs, @names and ids', () => {
  assert.deepEqual(yt('https://www.youtube.com/@MrBeast/videos'), { forHandle: 'MrBeast' });
  assert.deepEqual(yt('https://youtube.com/channel/UCX6OQ3DkcsbYNE6H8uQQuVA'), { id: 'UCX6OQ3DkcsbYNE6H8uQQuVA' });
  assert.deepEqual(yt('UCX6OQ3DkcsbYNE6H8uQQuVA'), { id: 'UCX6OQ3DkcsbYNE6H8uQQuVA' });
  assert.deepEqual(yt('@veritasium'), { forHandle: 'veritasium' });
  assert.deepEqual(yt('https://www.youtube.com/user/oldschool'), { forUsername: 'oldschool' });
  assert.equal(ig('https://www.instagram.com/Nike/?hl=en'), 'nike');
  assert.equal(tt('https://www.tiktok.com/@khaby.lame?lang=en'), 'khaby.lame');
  assert.equal(x('https://twitter.com/elonmusk/status/1'), 'elonmusk');
  assert.equal(x('@jack'), 'jack');
  assert.equal(fb('https://www.facebook.com/profile.php?id=12345'), '12345');
  assert.equal(fb('https://www.facebook.com/CocaCola/'), 'CocaCola');
  assert.equal(normaliseHandle('youtube', 'https://www.youtube.com/@MrBeast'), '@MrBeast');
});

test('ISO durations classify shorts', () => {
  assert.equal(durationSeconds('PT59S'), 59);
  assert.equal(durationSeconds('PT1M'), 60);
  assert.equal(durationSeconds('PT1H2M3S'), 3723);
  assert.equal(durationSeconds('garbage'), 0);
});

test('YouTube provider maps channel and video payloads (mocked fetch)', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const u = new URL(url);
    const body = u.pathname.endsWith('/channels')
      ? { items: [{ id: 'UC1', snippet: { title: 'Chan', customUrl: '@chan', thumbnails: { default: { url: 'a.png' } } }, statistics: { subscriberCount: '1200', viewCount: '99', videoCount: '2' }, contentDetails: { relatedPlaylists: { uploads: 'UU1' } } }] }
      : u.pathname.endsWith('/playlistItems')
        ? { items: [{ contentDetails: { videoId: 'v1', videoPublishedAt: '2026-11-10T00:00:00Z' } }, { contentDetails: { videoId: 'v2', videoPublishedAt: '2026-11-01T00:00:00Z' } }, { contentDetails: { videoId: 'old', videoPublishedAt: '2020-01-01T00:00:00Z' } }] }
        : { items: [
          { id: 'v1', snippet: { title: 'One', publishedAt: '2026-11-10T00:00:00Z', thumbnails: {}, liveBroadcastContent: 'none' }, statistics: { viewCount: '10', likeCount: '2', commentCount: '1' }, contentDetails: { duration: 'PT45S' } },
          { id: 'v2', snippet: { title: 'Two', publishedAt: '2026-11-01T00:00:00Z', thumbnails: {}, liveBroadcastContent: 'none' }, statistics: { viewCount: '20', likeCount: '3' }, contentDetails: { duration: 'PT10M' } },
        ] };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const r = await youtube.fetchAccount('@chan', { apiKey: 'k' }, { since: '2026-10-01T00:00:00Z', maxPosts: 50 });
    assert.equal(r.profile.followers, 1200);
    assert.equal(r.profile.profileUrl, 'https://www.youtube.com/@chan');
    assert.equal(r.posts.length, 2); // the 2020 video is older than `since`
    assert.equal(r.posts[0].type, 'short');
    assert.equal(r.posts[1].type, 'video');
    assert.equal(r.posts[1].comments, 0);
    assert.ok(calls.some((c) => c.includes('id=v1%2Cv2')));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('HTTP errors turn into readable messages and retry on 429', async () => {
  assert.equal(extractApiMessage({ error: { message: 'quotaExceeded' } }, 403), 'quotaExceeded');
  assert.equal(extractApiMessage({ detail: 'Unauthorized' }, 401), 'Unauthorized');
  assert.equal(extractApiMessage(null, 500), 'HTTP 500');
  const { fetchJson } = await import('../server/http.js');
  const realFetch = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async () => (++n < 3 ? new Response('{}', { status: 429, headers: { 'retry-after': '0' } }) : new Response('{"ok":true}', { status: 200 }));
  try {
    const r = await fetchJson('https://example.test/x', { retries: 3 });
    assert.equal(r.ok, true);
    assert.equal(n, 3);
  } finally { globalThis.fetch = realFetch; }
});

test('CSV round-trips quotes and newlines', () => {
  const rows = parseCsv('a,b\r\n1,"x, ""y""\nz"\r\n2,plain\n');
  assert.deepEqual(rows, [{ a: '1', b: 'x, "y"\nz' }, { a: '2', b: 'plain' }]);
  assert.equal(toCsv(rows), 'a,b\r\n1,"x, ""y""\nz"\r\n2,plain');
  assert.deepEqual(parseCsv('﻿Competitor Name,x\nfoo,1'), [{ competitor_name: 'foo', x: '1' }]);
});

test('credentials encrypt and mask', () => {
  const payload = encryptJson({ token: 'secret-value' });
  assert.ok(!payload.includes('secret'));
  assert.deepEqual(decryptJson(payload), { token: 'secret-value' });
  assert.equal(mask('abcdefgh'), '••••••efgh');
  assert.equal(mask('abc'), '••••');
});
