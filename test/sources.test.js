import './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { instagramFetch, facebookFetch, oauthUrl, exchangeCode, discoverAccounts, parsePastedRedirect, MANUAL_REDIRECT, extendToken } from '../server/providers/graph.js';
import youtube, { mapApifyVideo } from '../server/providers/youtube.js';
import x, { mapApifyTweet } from '../server/providers/x.js';
import instagram from '../server/providers/instagram.js';
import { saveCredentials, getCredentials, configuredPlatforms, saveApifyToken, saveMetaApp, getMetaApp, effectiveCapabilities } from '../server/credentials.js';

const withFetch = async (handler, fn) => {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => { const body = handler(String(url), init); return new Response(JSON.stringify(body), { status: 200 }); };
  try { return await fn(); } finally { globalThis.fetch = real; }
};

test('Meta Graph API: Instagram business discovery and Facebook page posts', async () => {
  await withFetch((url) => {
    if (url.includes('business_discovery')) return { business_discovery: { id: '178', username: 'rival', name: 'Rival', followers_count: 5000, follows_count: 10, media_count: 2,
      media: { data: [
        { id: 'm1', caption: 'Reel', like_count: 100, comments_count: 5, media_type: 'VIDEO', media_product_type: 'REELS', permalink: 'https://www.instagram.com/reel/m1/', timestamp: '2026-11-10T10:00:00+0000' },
        { id: 'm2', caption: 'Pic', like_count: 50, comments_count: 2, media_type: 'IMAGE', media_product_type: 'FEED', permalink: 'https://www.instagram.com/p/m2/', timestamp: '2026-11-01T10:00:00+0000', media_url: 'https://x/img.jpg' },
      ], paging: {} } } };
    if (/\/posts\?/.test(url)) return { data: [{ id: 'p1', message: 'Hi', created_time: '2026-11-12T00:00:00+0000', permalink_url: 'https://fb/p1', shares: { count: 3 }, reactions: { summary: { total_count: 40 } }, comments: { summary: { total_count: 4 } }, attachments: { data: [{ media_type: 'video' }] } }], paging: {} };
    return { id: '100', name: 'Rival Page', username: 'rival', fan_count: 900, followers_count: 1000, picture: { data: { url: 'https://x/a.jpg' } } };
  }, async () => {
    const ig = await instagramFetch('rival', { accessToken: 't', igUserId: '1' }, { since: null, maxPosts: 50 });
    assert.equal(ig.profile.followers, 5000);
    assert.equal(ig.posts.length, 2);
    assert.equal(ig.posts[0].type, 'reel');
    assert.equal(ig.posts[0].views, null); // Meta does not expose competitors' plays
    assert.equal(ig.posts[1].thumbnailUrl, 'https://x/img.jpg');
    const empty = await facebookFetch('rival', { accessToken: 't' }, { since: null, maxPosts: 0 });
    assert.match(empty.diagnostics[0], /Page Public Content Access/);
    const fb = await facebookFetch('rival', { accessToken: 't' }, { since: null, maxPosts: 50 });
    assert.equal(fb.diagnostics.length, 0);
    assert.equal(fb.profile.followers, 1000);
    assert.deepEqual({ l: fb.posts[0].likes, c: fb.posts[0].comments, s: fb.posts[0].shares, t: fb.posts[0].type }, { l: 40, c: 4, s: 3, t: 'video' });
  });
});

test('Connect with Facebook: oauth url, code exchange and account discovery', async () => {
  const u = new URL(oauthUrl({ appId: '123', redirectUri: 'http://localhost:3000/api/oauth/meta/callback', state: 's' }));
  assert.equal(u.searchParams.get('client_id'), '123');
  assert.match(u.searchParams.get('scope'), /instagram_basic/);
  const b = new URL(oauthUrl({ appId: '123', redirectUri: 'r', state: 's', configId: '777' }));
  assert.equal(b.searchParams.get('config_id'), '777');
  assert.equal(b.searchParams.get('scope'), null);
  assert.equal(b.searchParams.get('override_default_response_type'), 'true');
  await withFetch((url) => {
    if (url.includes('fb_exchange_token')) return { access_token: 'LONG' };
    if (url.includes('oauth/access_token')) return { access_token: 'SHORT' };
    if (url.includes('/me/accounts')) return { data: [{ id: 'pg1', name: 'My Page', instagram_business_account: { id: 'ig1', username: 'mybrand' } }, { id: 'pg2', name: 'Other' }] };
    return { id: 'u1', name: 'Me' };
  }, async () => {
    assert.equal(await exchangeCode({ appId: '1', appSecret: '2', redirectUri: 'r', code: 'c' }), 'LONG');
    const ext = await extendToken({ appId: '1', appSecret: '2', token: 'SHORT' });
    assert.deepEqual({ t: ext.token, e: ext.extended }, { t: 'LONG', e: true });
    const d = await discoverAccounts('LONG');
    assert.equal(d.user.name, 'Me');
    assert.equal(d.pages.find((p) => p.igUserId).igUsername, 'mybrand');
  });
  assert.deepEqual(parsePastedRedirect(`${MANUAL_REDIRECT}?code=AQBx-1&state=1.abc#_=_`), { code: 'AQBx-1', state: '1.abc', error: null });
  assert.equal(parsePastedRedirect('AQBx-1').code, 'AQBx-1');
  assert.equal(parsePastedRedirect(`${MANUAL_REDIRECT}?error=access_denied&error_description=Permissions+error`).error, 'Permissions error');
  assert.deepEqual(parsePastedRedirect('not a url with spaces'), {});
  assert.throws(() => saveMetaApp({ appId: '', appSecret: '' }), /required/);
  saveMetaApp({ appId: '123', appSecret: 'sec' });
  saveMetaApp({ appId: '123', appSecret: '••••••' }); // masked value keeps the secret
  assert.equal(getMetaApp().appSecret, 'sec');
});

test('every platform offers Apify and an official source; defaults respected', async () => {
  for (const id of ['youtube', 'instagram', 'facebook', 'tiktok', 'x']) {
    const p = (await import(`../server/providers/${id}.js`)).default;
    const options = p.credentialFields.find((f) => f.key === 'source').options.map((o) => o[0]);
    assert.ok(options.includes('apify'), id);
    assert.ok(options.some((o) => o !== 'apify' && o !== 'python'), id);
  }
  saveCredentials('youtube', { apiKey: 'AIzaKEY' });
  assert.equal(getCredentials('youtube').source, 'api');
  saveApifyToken('apify_api_x');
  assert.equal(getCredentials('youtube').source, 'api'); // official key kept
  assert.equal(getCredentials('x').source, 'apify'); // nothing official configured, so X links through Apify
  assert.ok(configuredPlatforms().has('x'));
  saveCredentials('instagram', { source: 'graph', accessToken: 'EAAG', igUserId: '1' });
  assert.equal(effectiveCapabilities('instagram').views, false);
  saveCredentials('instagram', { source: 'apify' });
  assert.equal(effectiveCapabilities('instagram').views, true);
  assert.match(await instagram.test({ source: 'apify', apifyToken: 'tok' }).catch((e) => e.message), /./);
});

test('Apify mappers for YouTube and X items', () => {
  const v = mapApifyVideo({ id: 'abc', title: 'T', date: '2026-11-10T00:00:00.000Z', viewCount: 500, likes: 20, commentsCount: 3, duration: '00:00:45', url: 'https://www.youtube.com/watch?v=abc' });
  assert.deepEqual({ id: v.externalId, views: v.views, likes: v.likes, comments: v.comments, type: v.type }, { id: 'abc', views: 500, likes: 20, comments: 3, type: 'video' });
  const t = mapApifyTweet({ id: '9', text: 'hi', createdAt: 'Mon Nov 10 10:00:00 +0000 2026', likeCount: 5, retweetCount: 2, quoteCount: 1, replyCount: 3, bookmarkCount: 4, viewCount: 1000, author: { userName: 'acme' } }, 'acme');
  assert.deepEqual({ shares: t.shares, saves: t.saves, views: t.views, type: t.type }, { shares: 3, saves: 4, views: 1000, type: 'text' });
  assert.ok(t.publishedAt.startsWith('2026-11-10'));
});
