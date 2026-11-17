import './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import instagram, { mapPost as igPost } from '../server/providers/instagram.js';
import facebook, { mapPost as fbPost } from '../server/providers/facebook.js';
import tiktok, { mapApifyPost, mapApifyProfile } from '../server/providers/tiktok.js';
import { pick, num, when } from '../server/apify.js';
import { saveCredentials, getCredentials, configuredPlatforms, saveApifyToken, deleteApifyToken } from '../server/credentials.js';
import { computeSince } from '../server/collector.js';

const fx = JSON.parse(readFileSync(new URL('./fixtures/apify-samples.json', import.meta.url), 'utf8'));

test('apify helpers pick nested fields and normalise numbers/dates', () => {
  assert.equal(pick({ a: { b: 1 } }, 'x', 'a.b'), 1);
  assert.equal(pick({ a: '' }, 'a', 'b'), undefined);
  assert.equal(num('12'), 12);
  assert.equal(num('abc'), null);
  assert.equal(when(1794863881), '2026-11-16T21:18:01.000Z');
  assert.equal(when('2026-11-16T21:18:01.000Z'), '2026-11-16T21:18:01.000Z');
  assert.equal(when('nope'), null);
});

test('Instagram actor items map to posts with reel views (real sample)', () => {
  const posts = fx.instagramPosts.map(igPost);
  const reel = posts.find((p) => p.type === 'reel');
  const image = posts.find((p) => p.type === 'image');
  assert.ok(reel && image);
  assert.ok(reel.views > 1000);
  assert.equal(image.views, null);
  assert.ok(image.likes > 0 && image.comments > 0);
  assert.match(reel.url, /instagram\.com\/p\//);
  assert.ok(posts.every((p) => p.publishedAt.endsWith('Z')));
});

test('Facebook actor items map to posts with reactions, comments and shares (real sample)', () => {
  const posts = fx.facebookPosts.map(fbPost);
  assert.equal(posts.length, 3);
  assert.ok(posts.every((p) => p.likes > 0 && p.comments > 0 && p.shares > 0));
  assert.ok(posts.every((p) => p.type === 'image'));
  assert.equal(posts[0].publishedAt, '2026-11-16T21:18:01.000Z');
});

test('TikTok Apify items map to posts and profile', () => {
  const [p] = fx.tiktokApify.map((v) => mapApifyPost(v, 'acme'));
  assert.deepEqual({ views: p.views, likes: p.likes, comments: p.comments, shares: p.shares, saves: p.saves, type: p.type }, { views: 221000, likes: 15400, comments: 410, shares: 980, saves: 1200, type: 'video' });
  const pr = mapApifyProfile(fx.tiktokApify, 'acme');
  assert.equal(pr.followers, 410000);
  assert.equal(pr.postsCount, 120);
  assert.equal(pr.profileUrl, 'https://www.tiktok.com/@acme');
});

test('providers run end-to-end against a mocked Apify API', async () => {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    const u = String(url);
    const body = u.includes('users/me') ? { data: { username: 'tester' } }
      : u.includes('instagram-profile-scraper') ? [fx.instagramProfile]
      : u.includes('instagram-scraper') ? fx.instagramPosts
      : u.includes('facebook-pages-scraper') ? [fx.facebookPage]
      : u.includes('facebook-posts-scraper') ? fx.facebookPosts
      : u.includes('tiktok-scraper') ? fx.tiktokApify : [];
    assert.equal(init?.headers?.Authorization, 'Bearer tok');
    return new Response(JSON.stringify(body), { status: 200 });
  };
  try {
    const ig = await instagram.fetchAccount('https://www.instagram.com/NASA/', { apifyToken: 'tok' }, { since: '2026-01-01T00:00:00.000Z', maxPosts: 50 });
    assert.equal(ig.posts.length, 3);
    assert.ok(ig.profile.followers > 1e6);
    const fb = await facebook.fetchAccount('NASA', { apifyToken: 'tok' }, { since: '2026-01-01T00:00:00.000Z', maxPosts: 50 });
    assert.equal(fb.posts.length, 3);
    assert.ok(fb.profile.followers > 1e6);
    assert.equal(fb.profile.displayName, fx.facebookPage.title);
    const tt = await tiktok.fetchAccount('@acme', { apifyToken: 'tok', source: 'apify' }, { since: null, maxPosts: 50 });
    assert.equal(tt.posts.length, 1);
    assert.equal(tt.profile.followers, 410000);
    assert.match(await instagram.test({ apifyToken: 'tok' }), /tester/);
    assert.ok(calls.every((c) => !c.includes('token=')), 'token never goes in the URL');
  } finally { globalThis.fetch = realFetch; }
});

test('the Apify token is shared across Instagram, Facebook and TikTok', () => {
  assert.deepEqual([...configuredPlatforms()], []);
  saveCredentials('instagram', { apifyToken: 'apify_api_shared' });
  assert.equal(getCredentials('facebook').apifyToken, 'apify_api_shared');
  assert.equal(getCredentials('tiktok').apifyToken, 'apify_api_shared');
  assert.ok(configuredPlatforms().has('facebook'));
  assert.ok(configuredPlatforms().has('tiktok'));
  // Research API mode needs its own keys, and hides the Apify ones.
  assert.throws(() => saveCredentials('tiktok', { source: 'research' }), /client key/i);
  saveCredentials('tiktok', { source: 'research', clientKey: 'k', clientSecret: 's' });
  assert.equal(getCredentials('tiktok').source, 'research');
  // Saving Facebook with an empty token keeps using the shared one.
  saveCredentials('facebook', { apifyToken: '' });
  assert.equal(getCredentials('facebook').apifyToken, 'apify_api_shared');
});

test('one Apify token links Instagram, Facebook and TikTok; Research API TikTok is left alone', () => {
  deleteApifyToken();
  saveCredentials('tiktok', { source: 'research', clientKey: 'k', clientSecret: 's' });
  saveApifyToken('apify_api_one');
  assert.equal(getCredentials('instagram').apifyToken, 'apify_api_one');
  assert.equal(getCredentials('facebook').apifyToken, 'apify_api_one');
  assert.equal(getCredentials('tiktok').source, 'research');
  assert.throws(() => { deleteApifyToken(); saveApifyToken(''); }, /required/);
  saveApifyToken('apify_api_two');
  assert.equal(getCredentials('facebook').apifyToken, 'apify_api_two');
  deleteApifyToken();
  assert.equal(getCredentials('facebook'), null);
  assert.equal(getCredentials('tiktok').source, 'research'); // kept
});

test('first sync has no date floor; later syncs re-read 14 days within the look-back', () => {
  const now = Date.parse('2026-11-17T00:00:00Z');
  assert.equal(computeSince({ last_synced_at: null, has_posts: 0 }, { now }), null);
  assert.equal(computeSince({ last_synced_at: '2026-11-10T00:00:00Z', has_posts: 0 }, { now }), null); // synced but got nothing yet
  assert.equal(computeSince({ last_synced_at: '2026-11-10T00:00:00Z', has_posts: 1 }, { full: true, now }), null);
  assert.equal(computeSince({ last_synced_at: '2026-11-10T00:00:00Z', has_posts: 1 }, { now }), '2026-10-27T00:00:00.000Z');
  assert.equal(computeSince({ last_synced_at: '2020-01-01T00:00:00Z', has_posts: 1 }, { now }), '2026-08-19T00:00:00.000Z'); // capped by LOOKBACK_DAYS=90
});
