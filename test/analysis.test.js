import './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, stmt } from '../server/db.js';
import { storeAccountData } from '../server/collector.js';
import { overview, competitorDetail, listPosts, resolveFilters, invalidate } from '../server/analysis.js';
import { overviewInsights } from '../server/insights.js';

const DAY = 86400_000;
const iso = (daysAgo, hour = 12) => new Date(Date.now() - daysAgo * DAY).toISOString().slice(0, 10) + `T${String(hour).padStart(2, '0')}:00:00.000Z`;

function seed() {
  const a = Number(stmt('INSERT INTO competitors (name, color_slot) VALUES (?, ?)').run('Alpha', 1).lastInsertRowid);
  const b = Number(stmt('INSERT INTO competitors (name, color_slot, is_self) VALUES (?, ?, 1)').run('Beta', 2).lastInsertRowid);
  const aYt = Number(stmt('INSERT INTO accounts (competitor_id, platform, handle) VALUES (?, ?, ?)').run(a, 'youtube', '@alpha').lastInsertRowid);
  const aIg = Number(stmt('INSERT INTO accounts (competitor_id, platform, handle) VALUES (?, ?, ?)').run(a, 'instagram', 'alpha').lastInsertRowid);
  const bTt = Number(stmt('INSERT INTO accounts (competitor_id, platform, handle) VALUES (?, ?, ?)').run(b, 'tiktok', 'beta').lastInsertRowid);
  storeAccountData(aYt, 'youtube', {
    profile: { followers: 1000, capturedOn: iso(0).slice(0, 10) },
    posts: [
      { externalId: 'v1', publishedAt: iso(2), type: 'video', views: 1000, likes: 100, comments: 10, shares: 0, saves: 0 },
      { externalId: 'v2', publishedAt: iso(5), type: 'short', views: 500, likes: 50, comments: 5, shares: 0, saves: 0 },
      { externalId: 'old', publishedAt: iso(40), type: 'video', views: 9999, likes: 999, comments: 0, shares: 0, saves: 0 }, // previous period
    ],
  });
  storeAccountData(aIg, 'instagram', {
    profile: { followers: 4000 },
    posts: [{ externalId: 'm1', publishedAt: iso(3), type: 'reel', views: null, likes: 200, comments: 20, shares: 0, saves: 0 }],
  });
  storeAccountData(bTt, 'tiktok', {
    profile: { followers: 10000 },
    posts: [{ externalId: 't1', publishedAt: iso(1), type: 'video', views: 20000, likes: 1500, comments: 100, shares: 400, saves: 0 }],
  });
  // older follower snapshot to test growth
  stmt('INSERT INTO snapshots (account_id, captured_on, followers) VALUES (?, ?, ?)').run(bTt, iso(35).slice(0, 10), 9000);
  invalidate();
  return { a, b, aYt, aIg, bTt };
}
const ids = seed();

test('resolveFilters builds a window with a matching previous period', () => {
  const f = resolveFilters({ range: '7d' });
  assert.equal(f.days, 7);
  assert.equal(f.bucket, 'day');
  assert.equal(new Date(f.prevTo).getTime(), new Date(f.from).getTime());
  assert.equal(new Date(f.from).getTime() - new Date(f.prevFrom).getTime(), 7 * DAY);
  assert.equal(resolveFilters({ range: '365d' }).bucket, 'week');
  assert.deepEqual(resolveFilters({ platforms: 'youtube,bogus' }).platforms, ['youtube']);
});

test('overview aggregates interactions and views per competitor and platform', () => {
  const o = overview({ range: '30d' });
  assert.equal(o.totals.posts, 4);
  assert.equal(o.totals.interactions, 110 + 55 + 220 + 2000);
  assert.equal(o.totals.views, 1000 + 500 + 20000); // instagram views are NULL and ignored
  assert.equal(o.totals.prev.posts, 1);
  assert.equal(o.totals.prev.interactions, 999);
  const alpha = o.competitors.find((c) => c.name === 'Alpha');
  const beta = o.competitors.find((c) => c.name === 'Beta');
  assert.equal(alpha.posts, 3);
  assert.equal(alpha.interactions, 385);
  assert.equal(alpha.followers, 5000);
  assert.equal(beta.interactions, 2000);
  assert.equal(beta.followerGrowth, 1000);
  assert.ok(Math.abs(beta.engagementRate - 20) < 1e-9); // 2000 / 1 post / 10000 * 100
  assert.ok(Math.abs(beta.shareOfVoice - (2000 / 2385) * 100) < 1e-9);
  assert.equal(o.competitors[0].name, 'Beta'); // sorted by interactions
  const ig = o.platforms.find((p) => p.platform === 'instagram');
  assert.equal(ig.views, null); // the only IG post has no view count, so the platform total stays null
  assert.equal(ig.postsWithViews, 0);
  assert.equal(o.series.keys.length, 30);
  assert.equal(o.series.total.interactions.reduce((x, y) => x + y, 0), 2385);
  assert.equal(o.topPosts[0].id, 'tiktok:t1');
  assert.ok(o.matrix.find((m) => m.competitorId === ids.a && m.platform === 'youtube').interactions === 165);
});

test('platform and competitor filters scope every number', () => {
  const o = overview({ range: '30d', platforms: 'youtube' });
  assert.equal(o.totals.posts, 2);
  assert.equal(o.platforms.length, 1);
  const only = overview({ range: '30d', competitors: String(ids.b) });
  assert.equal(only.competitors.length, 1);
  assert.equal(only.totals.interactions, 2000);
});

test('competitor detail breaks down by account, type and weekday', () => {
  const d = competitorDetail(ids.a, { range: '30d' });
  assert.equal(d.accounts.length, 2);
  const yt = d.accounts.find((x) => x.platform === 'youtube');
  assert.equal(yt.posts, 2);
  assert.equal(yt.views, 1500);
  assert.equal(yt.avgViews, 750);
  assert.equal(d.types.find((t) => t.type === 'reel').interactions, 220);
  assert.equal(d.weekdays.length, 7);
  assert.equal(d.weekdays.reduce((s, w) => s + w.posts, 0), 3);
  assert.equal(d.hours[12].posts, 3);
  assert.equal(competitorDetail(9999, {}), null);
});

test('listPosts sorts, paginates, filters by type and searches captions', () => {
  const byViews = listPosts({ range: '30d', sort: 'views', dir: 'desc' });
  assert.equal(byViews.total, 4);
  assert.equal(byViews.rows[0].id, 'tiktok:t1');
  assert.ok(Math.abs(byViews.rows[0].engagement - 10) < 1e-9); // 2000 interactions / 20000 views
  assert.equal(listPosts({ range: '30d', sort: 'engagement' }).rows[0].id, 'youtube:v1'); // 110/1000 = 11%
  assert.equal(byViews.rows[byViews.rows.length - 1].views, null); // NULLS LAST
  assert.equal(listPosts({ range: '30d', type: 'short' }).total, 1);
  assert.equal(listPosts({ range: 'all' }).total, 5);
  assert.equal(listPosts({ range: 'all', pageSize: 10, page: 2 }).rows.length, 0);
  assert.equal(listPosts({ range: 'all', q: '%' }).total, 0); // LIKE wildcard is escaped
});

test('re-storing a post updates counters instead of duplicating', () => {
  storeAccountData(ids.bTt, 'tiktok', { profile: null, posts: [{ externalId: 't1', publishedAt: iso(1), type: 'video', views: 25000, likes: 1600, comments: 100, shares: 400, saves: 0 }] });
  invalidate();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM posts').get().n, 5);
  assert.equal(overview({ range: '30d' }).competitors.find((c) => c.name === 'Beta').interactions, 2100);
});

test('insights name the leaders and flag missing view data', () => {
  const o = overview({ range: '30d' });
  const titles = overviewInsights(o).map((i) => i.title);
  assert.ok(titles.includes('Beta leads on interactions'));
  assert.ok(titles.includes('Beta wins on video views'));
  assert.ok(!titles.includes('View counts not available everywhere')); // every tracked platform can report views now
});
