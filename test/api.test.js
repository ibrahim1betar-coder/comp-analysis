import './helpers.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from '../server/index.js';

const app = await build();
after(() => app.close());
const json = (res) => JSON.parse(res.body);

test('competitor and account CRUD with handle normalisation', async () => {
  let res = await app.inject({ method: 'POST', url: '/api/competitors', payload: { name: 'Acme', accounts: [{ platform: 'youtube', handle: 'https://www.youtube.com/@AcmeTV' }, { platform: 'x', handle: 'https://x.com/acme' }] } });
  assert.equal(res.statusCode, 200);
  const created = json(res);
  assert.deepEqual(created.accounts.map((a) => a.handle), ['@AcmeTV', 'acme']);
  res = await app.inject({ method: 'POST', url: `/api/competitors/${created.id}/accounts`, payload: { platform: 'x', handle: '@acme' } });
  assert.equal(res.statusCode, 409); // duplicate after normalisation
  res = await app.inject({ method: 'POST', url: '/api/competitors', payload: { name: 'acme' } });
  assert.equal(res.statusCode, 409); // case-insensitive duplicate name
  res = await app.inject({ method: 'GET', url: '/api/competitors' });
  assert.equal(json(res).length, 1);
  assert.equal(json(res)[0].accounts.length, 2);
  res = await app.inject({ method: 'PUT', url: `/api/competitors/${created.id}`, payload: { name: 'Acme Corp', isSelf: true } });
  assert.equal(res.statusCode, 200);
  res = await app.inject({ method: 'GET', url: '/api/analysis/overview?range=30d' });
  assert.equal(json(res).competitors[0].name, 'Acme Corp');
  assert.equal(json(res).competitors[0].isSelf, true);
});

test('sync of an unconnected platform records a clear error', async () => {
  const comps = json(await app.inject({ method: 'GET', url: '/api/competitors' }));
  const acc = comps[0].accounts[0];
  const res = await app.inject({ method: 'POST', url: `/api/accounts/${acc.id}/sync` });
  assert.equal(json(res).ok, false);
  assert.match(json(res).error, /not connected/i);
  const runs = json(await app.inject({ method: 'GET', url: '/api/sync/runs' }));
  assert.equal(runs[0].ok, 0);
});

test('credentials are stored encrypted and read back masked', async () => {
  let res = await app.inject({ method: 'PUT', url: '/api/credentials/youtube', payload: { apiKey: 'AIzaSyFAKEKEY1234', test: false } });
  assert.equal(res.statusCode, 200);
  res = await app.inject({ method: 'GET', url: '/api/credentials' });
  assert.equal(json(res)[0].fields.apiKey, '••••••1234');
  const { db } = await import('../server/db.js');
  const raw = db.prepare('SELECT payload FROM credentials').get().payload;
  assert.ok(!raw.includes('AIzaSy'));
  // Sending the masked value back keeps the stored secret.
  res = await app.inject({ method: 'PUT', url: '/api/credentials/youtube', payload: { apiKey: '••••••1234', test: false } });
  assert.equal(res.statusCode, 200);
  const { getCredentials } = await import('../server/credentials.js');
  assert.equal(getCredentials('youtube').apiKey, 'AIzaSyFAKEKEY1234');
  res = await app.inject({ method: 'GET', url: '/api/meta' });
  assert.equal(json(res).providers.find((p) => p.id === 'youtube').configured, true);
});

test('CSV import creates competitors, accounts, posts and follower snapshots', async () => {
  const csv = [
    'competitor,platform,handle,post_id,published_at,type,url,views,likes,comments,shares,saves,followers,caption',
    'Zed,tiktok,@zed,1,2026-11-01T10:00:00Z,video,https://t/1,5000,300,20,40,,12000,"Hello, ""world"""',
    'Zed,tiktok,zed,2,2026-11-03T10:00:00Z,video,,8000,500,30,60,,,',
    'Zed,instagram,zed,3,2026-11-04T10:00:00Z,reel,,,900,40,0,10,,',
    'Zed,myspace,zed,4,2026-11-04T10:00:00Z,post,,,1,1,1,1,,',
  ].join('\n');
  let res = await app.inject({ method: 'POST', url: '/api/import', payload: csv, headers: { 'content-type': 'text/csv' } });
  assert.equal(res.statusCode, 200);
  const r = json(res);
  assert.equal(r.posts, 3);
  assert.equal(r.accounts, 2);
  assert.equal(r.competitors, 1);
  assert.equal(r.errors.length, 1);
  res = await app.inject({ method: 'GET', url: '/api/analysis/overview?from=2026-10-25' });
  const zed = json(res).competitors.find((c) => c.name === 'Zed');
  assert.equal(zed.posts, 3);
  assert.equal(zed.views, 13000);
  assert.equal(zed.interactions, 360 + 590 + 950);
  assert.equal(zed.followers, 12000);
  res = await app.inject({ method: 'GET', url: '/api/analysis/posts?from=2026-10-25&sort=views' });
  assert.equal(json(res).rows[0].caption, null); // empty caption stays null, not 0
  assert.equal(json(res).rows[1].caption, 'Hello, "world"');
  res = await app.inject({ method: 'GET', url: '/api/export/posts.csv?range=all' });
  assert.match(res.headers['content-type'], /text\/csv/);
  assert.ok(res.body.split('\r\n').length >= 4);
});

test('analysis responses carry ETags and answer 304 when unchanged', async () => {
  const first = await app.inject({ method: 'GET', url: '/api/analysis/overview?range=7d' });
  const etag = first.headers.etag;
  assert.ok(etag);
  const second = await app.inject({ method: 'GET', url: '/api/analysis/overview?range=7d', headers: { 'if-none-match': etag } });
  assert.equal(second.statusCode, 304);
});

test('static shell is served with a CSP and unknown API routes 404', async () => {
  const page = await app.inject({ method: 'GET', url: '/' });
  assert.equal(page.statusCode, 200);
  assert.match(page.headers['content-security-policy'], /script-src 'self'/);
  assert.equal((await app.inject({ method: 'GET', url: '/api/nope' })).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: '/some/deep/link' })).statusCode, 200); // SPA fallback
});
