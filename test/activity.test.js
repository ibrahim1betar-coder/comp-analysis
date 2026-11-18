import './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stmt } from '../server/db.js';
import { storeAccountData } from '../server/collector.js';
import { overview, competitorDetail, listPosts, invalidate } from '../server/analysis.js';

const DAY = 86400_000;
const ago = (d) => new Date(Date.now() - d * DAY).toISOString();
const dayAgo = (d) => ago(d).slice(0, 10);

const comp = Number(stmt('INSERT INTO competitors (name, color_slot) VALUES (?, ?)').run('Gamma', 3).lastInsertRowid);
const acc = Number(stmt('INSERT INTO accounts (competitor_id, platform, handle) VALUES (?, ?, ?)').run(comp, 'youtube', '@gamma').lastInsertRowid);
// An old video synced three times: 20 days ago, 10 days ago and today. Counters keep growing.
const old = (views, likes, capturedOn) => ({ externalId: 'old', publishedAt: ago(60), type: 'video', views, likes, comments: 5, shares: 0, saves: 0, capturedOn });
storeAccountData(acc, 'youtube', { profile: { followers: 500, capturedOn: dayAgo(20) }, posts: [old(1000, 100, dayAgo(20))] });
storeAccountData(acc, 'youtube', { profile: { followers: 520, capturedOn: dayAgo(10) }, posts: [old(1500, 130, dayAgo(10))] });
// Today: the old video grew again and a new video was published 3 days ago.
storeAccountData(acc, 'youtube', { profile: { followers: 540 }, posts: [old(1800, 150, dayAgo(0)), { externalId: 'new', publishedAt: ago(3), type: 'short', views: 100, likes: 10, comments: 1, shares: 0, saves: 0 }] });
invalidate();
const q = (extra = {}) => ({ competitors: String(comp), ...extra });

test('activity mode counts what posts gained inside the period, even with nothing published', () => {
  const o30 = overview(q({ range: '30d' }));
  const g = o30.competitors.find((c) => c.name === 'Gamma');
  // old video: +500 views / +30 likes (day -10) and +300 / +20 (today); new video: 100 views, 10 likes, 1 comment
  assert.equal(g.views, 500 + 300 + 100);
  assert.equal(g.likes, 30 + 20 + 10);
  assert.equal(g.interactions, 30 + 20 + 10 + 1);
  assert.equal(g.posts, 1); // only the new one was published in the period
  const o7 = overview(q({ range: '7d' }));
  const g7 = o7.competitors.find((c) => c.name === 'Gamma');
  assert.equal(g7.views, 300 + 100); // only today's growth of the old video, plus the new video
  assert.equal(g7.likes, 20 + 10);
  // published mode for the same 7 days sees only the new video, with lifetime counters
  const p7 = overview(q({ range: '7d', mode: 'published' })).competitors.find((c) => c.name === 'Gamma');
  assert.equal(p7.views, 100);
  assert.equal(p7.posts, 1);
  // a period with no publications still shows the old video's activity
  const custom = overview(q({ from: dayAgo(12), to: dayAgo(8) }));
  const gc = custom.competitors.find((c) => c.name === 'Gamma');
  assert.equal(gc.views, 500);
  assert.equal(gc.likes, 30);
  assert.equal(gc.posts, 0);
  assert.equal(overview(q({ from: dayAgo(12), to: dayAgo(8), mode: 'published' })).totals.posts, 0);
});

test('lifetime totals, tracking start and per-post period values are exposed', () => {
  const o = overview(q({ range: '7d' }));
  assert.equal(o.lifetime.views, 1900);
  assert.equal(o.lifetime.posts, 2);
  assert.equal(o.lifetime.trackingSince, dayAgo(20));
  const top = o.topPosts.find((p) => p.id === 'youtube:old');
  assert.equal(top.views, 300);
  assert.equal(top.lifetime_views, 1800);
  const list = listPosts(q({ range: '7d', sort: 'views' }));
  assert.equal(list.total, 2);
  assert.equal(list.sums.views, 400);
  const d = competitorDetail(comp, { range: '30d' });
  assert.equal(d.totals.views, 900);
  assert.equal(d.series.total.views.reduce((a, b) => a + b, 0), 900);
  assert.equal(d.lifetime.trackingSince, dayAgo(20));
});
