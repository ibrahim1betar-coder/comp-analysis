import { db, stmt } from './db.js';
import { PLATFORMS, providers } from './providers/index.js';

/* ---------- caching -------------------------------------------------------- */
let version = 0;
const cache = new Map();
const CACHE_MAX = 200;
/** Call after any write so cached analysis is dropped. */
export function invalidate() {
  version++;
  cache.clear();
}
function memo(key, fn) {
  const k = `${version}|${key}`;
  if (cache.has(k)) return cache.get(k);
  const value = fn();
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(k, value);
  return value;
}

/* ---------- filters -------------------------------------------------------- */
const DAY = 86400_000;
const isoDay = (d) => new Date(d).toISOString().slice(0, 10);
const startOfDay = (d) => new Date(isoDay(d) + 'T00:00:00.000Z');
const parseIds = (v) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : []);

export function resolveFilters(query = {}) {
  const todayStart = startOfDay(new Date());
  const to = query.to ? new Date(startOfDay(query.to).getTime() + DAY) : new Date(todayStart.getTime() + DAY);
  let from;
  const range = query.range || (query.from ? 'custom' : '30d');
  if (query.from) from = startOfDay(query.from);
  else if (range === 'all') {
    const row = stmt('SELECT MIN(published_at) AS m FROM posts').get();
    from = row?.m ? startOfDay(row.m) : new Date(todayStart.getTime() - 364 * DAY);
  } else {
    const days = { '7d': 7, '30d': 30, '90d': 90, '180d': 180, '365d': 365 }[range] || 30;
    from = new Date(to.getTime() - days * DAY);
  }
  if (from >= to) from = new Date(to.getTime() - DAY);
  const days = Math.round((to - from) / DAY);
  const prevFrom = new Date(from.getTime() - days * DAY);
  const competitorIds = parseIds(query.competitors).map(Number).filter(Number.isInteger);
  const platforms = parseIds(query.platforms).filter((p) => PLATFORMS.includes(p));
  return {
    range,
    from: from.toISOString(),
    to: to.toISOString(),
    prevFrom: prevFrom.toISOString(),
    prevTo: from.toISOString(),
    days,
    bucket: days <= 45 ? 'day' : days <= 400 ? 'week' : 'month',
    competitorIds,
    platforms,
  };
}

function where(f, { from = f.from, to = f.to } = {}) {
  const clauses = ['p.published_at >= ?', 'p.published_at < ?'];
  const params = [from, to];
  if (f.competitorIds.length) {
    clauses.push(`a.competitor_id IN (${f.competitorIds.map(() => '?').join(',')})`);
    params.push(...f.competitorIds);
  }
  if (f.platforms.length) {
    clauses.push(`a.platform IN (${f.platforms.map(() => '?').join(',')})`);
    params.push(...f.platforms);
  }
  return { sql: clauses.join(' AND '), params };
}

const AGG = `COUNT(p.id) AS posts, SUM(p.views) AS views, SUM(p.interactions) AS interactions, SUM(p.likes) AS likes,
  SUM(p.comments) AS comments, SUM(p.shares) AS shares, SUM(p.saves) AS saves,
  SUM(CASE WHEN p.views IS NOT NULL THEN 1 ELSE 0 END) AS posts_with_views`;

// Aggregate columns where SQL NULL means "nothing counted" and should read as 0. `views` stays NULL (= not available).
const ZERO_WHEN_NULL = new Set(['posts', 'interactions', 'likes', 'comments', 'shares', 'saves', 'posts_with_views']);
const toNum = (row) => {
  const out = {};
  for (const [k, v] of Object.entries(row)) out[k] = v === null ? (ZERO_WHEN_NULL.has(k) ? 0 : null) : typeof v === 'bigint' ? Number(v) : v;
  return out;
};

/* ---------- building blocks ------------------------------------------------ */
function totals(f, window) {
  const w = where(f, window);
  return toNum(stmt(`SELECT ${AGG} FROM posts p JOIN accounts a ON a.id = p.account_id WHERE ${w.sql}`).get(...w.params));
}

function groupBy(f, expr, alias) {
  const w = where(f);
  return stmt(`SELECT ${expr} AS ${alias}, ${AGG} FROM posts p JOIN accounts a ON a.id = p.account_id WHERE ${w.sql} GROUP BY ${alias}`).all(...w.params).map(toNum);
}

/** Followers per account from the newest snapshot on or before the calendar day of `before` (ISO date-time). */
function followersBefore(before) {
  const rows = stmt(`
    SELECT a.id AS account_id, a.competitor_id, a.platform, s.followers, s.total_views, s.posts_count
    FROM accounts a JOIN snapshots s ON s.account_id = a.id
    WHERE s.captured_on = (SELECT MAX(captured_on) FROM snapshots WHERE account_id = a.id AND captured_on <= ?)
  `).all(before.slice(0, 10));
  return rows.map(toNum);
}
const sumBy = (rows, keyFn, field) => {
  const m = new Map();
  for (const r of rows) if (r[field] !== null && r[field] !== undefined) m.set(keyFn(r), (m.get(keyFn(r)) || 0) + r[field]);
  return m;
};

function bucketKeys(f) {
  const keys = [];
  const from = new Date(f.from);
  const to = new Date(f.to);
  const toKey = (d) => {
    if (f.bucket === 'day') return isoDay(d);
    if (f.bucket === 'month') return isoDay(d).slice(0, 7) + '-01';
    const dt = new Date(d);
    dt.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7)); // Monday
    return isoDay(dt);
  };
  const seen = new Set();
  for (let d = new Date(from); d < to; d = new Date(d.getTime() + DAY)) {
    const k = toKey(d);
    if (!seen.has(k)) {
      seen.add(k);
      keys.push(k);
    }
  }
  return { keys, toKey };
}

function series(f, groupExpr) {
  const w = where(f);
  const rows = stmt(`
    SELECT substr(p.published_at, 1, 10) AS day, ${groupExpr} AS grp, COUNT(p.id) AS posts, SUM(p.views) AS views, SUM(p.interactions) AS interactions
    FROM posts p JOIN accounts a ON a.id = p.account_id WHERE ${w.sql} GROUP BY day, grp
  `).all(...w.params).map(toNum);
  const { keys, toKey } = bucketKeys(f);
  const index = new Map(keys.map((k, i) => [k, i]));
  const groups = new Map();
  const total = { posts: new Array(keys.length).fill(0), views: new Array(keys.length).fill(0), interactions: new Array(keys.length).fill(0) };
  for (const r of rows) {
    const i = index.get(toKey(new Date(r.day)));
    if (i === undefined) continue;
    let g = groups.get(r.grp);
    if (!g) groups.set(r.grp, (g = { key: r.grp, posts: new Array(keys.length).fill(0), views: new Array(keys.length).fill(0), interactions: new Array(keys.length).fill(0) }));
    g.posts[i] += r.posts;
    g.views[i] += r.views || 0;
    g.interactions[i] += r.interactions;
    total.posts[i] += r.posts;
    total.views[i] += r.views || 0;
    total.interactions[i] += r.interactions;
  }
  return { bucket: f.bucket, keys, total, groups: [...groups.values()] };
}

// engagement = interactions per 100 views (NULL when the post has no view count)
const POST_SELECT = `p.id, p.account_id, p.published_at, p.type, p.url, p.caption, p.thumbnail_url, p.views, p.likes, p.comments, p.shares, p.saves, p.interactions,
  CASE WHEN p.views > 0 THEN 100.0 * p.interactions / p.views END AS engagement,
  a.platform, a.handle, a.display_name, a.competitor_id, c.name AS competitor, c.color_slot`;

function topPosts(f, { by = 'interactions', limit = 10 } = {}) {
  const w = where(f);
  const order = by === 'views' ? 'p.views DESC NULLS LAST, p.interactions DESC' : 'p.interactions DESC, p.views DESC';
  return stmt(`SELECT ${POST_SELECT} FROM posts p JOIN accounts a ON a.id = p.account_id JOIN competitors c ON c.id = a.competitor_id
    WHERE ${w.sql} ORDER BY ${order} LIMIT ?`).all(...w.params, limit).map(toNum);
}

const rate = (interactions, posts, followers) => (posts && followers ? (interactions / posts / followers) * 100 : null);
const pct = (part, whole) => (whole ? (part / whole) * 100 : 0);

/* ---------- public API ----------------------------------------------------- */
export function overview(query) {
  const f = resolveFilters(query);
  return memo('overview:' + JSON.stringify(f), () => {
    const competitors = stmt(`SELECT id, name, color_slot, is_self FROM competitors ${f.competitorIds.length ? `WHERE id IN (${f.competitorIds.map(() => '?').join(',')})` : ''} ORDER BY id`).all(...f.competitorIds);
    const inScopeAccount = (a) => (!f.competitorIds.length || f.competitorIds.includes(a.competitor_id)) && (!f.platforms.length || f.platforms.includes(a.platform));
    const accounts = stmt('SELECT id, competitor_id, platform, handle, display_name, status, last_synced_at, last_error FROM accounts').all().filter(inScopeAccount);

    const current = totals(f);
    const previous = totals(f, { from: f.prevFrom, to: f.prevTo });
    const byCompetitor = new Map(groupBy(f, 'a.competitor_id', 'grp').map((r) => [r.grp, r]));
    const byCompetitorPrev = (() => {
      const w = where(f, { from: f.prevFrom, to: f.prevTo });
      return new Map(stmt(`SELECT a.competitor_id AS grp, ${AGG} FROM posts p JOIN accounts a ON a.id = p.account_id WHERE ${w.sql} GROUP BY grp`).all(...w.params).map(toNum).map((r) => [r.grp, r]));
    })();
    const byPlatform = new Map(groupBy(f, 'a.platform', 'grp').map((r) => [r.grp, r]));
    const matrix = groupBy(f, "a.competitor_id || ':' || a.platform", 'grp').map((r) => {
      const [cid, platform] = r.grp.split(':');
      return { competitorId: Number(cid), platform, posts: r.posts, views: r.views, interactions: r.interactions };
    });

    const inScope = (r) => (!f.competitorIds.length || f.competitorIds.includes(r.competitor_id)) && (!f.platforms.length || f.platforms.includes(r.platform));
    const followersNow = followersBefore(f.to).filter(inScope);
    const followersStart = followersBefore(f.from).filter(inScope);
    const fNowByComp = sumBy(followersNow, (r) => r.competitor_id, 'followers');
    const fStartByComp = sumBy(followersStart, (r) => r.competitor_id, 'followers');
    const fNowByPlatform = sumBy(followersNow, (r) => r.platform, 'followers');

    const competitorRows = competitors.map((c) => {
      const agg = byCompetitor.get(c.id) || { posts: 0, views: null, interactions: 0, likes: 0, comments: 0, shares: 0, saves: 0, posts_with_views: 0 };
      const prev = byCompetitorPrev.get(c.id) || { posts: 0, views: null, interactions: 0 };
      const followers = fNowByComp.get(c.id) ?? null;
      const followersAtStart = fStartByComp.get(c.id) ?? null;
      const compAccounts = accounts.filter((a) => a.competitor_id === c.id);
      return {
        id: c.id, name: c.name, slot: c.color_slot, isSelf: Boolean(c.is_self),
        accounts: compAccounts.length,
        platforms: [...new Set(compAccounts.map((a) => a.platform))],
        posts: agg.posts, views: agg.views, interactions: agg.interactions, likes: agg.likes, comments: agg.comments, shares: agg.shares, saves: agg.saves,
        postsWithViews: agg.posts_with_views,
        prevPosts: prev.posts, prevViews: prev.views, prevInteractions: prev.interactions,
        followers, followersAtStart,
        followerGrowth: followers !== null && followersAtStart !== null ? followers - followersAtStart : null,
        avgInteractions: agg.posts ? agg.interactions / agg.posts : 0,
        avgViews: agg.posts_with_views ? (agg.views || 0) / agg.posts_with_views : null,
        engagementRate: rate(agg.interactions, agg.posts, followers),
        shareOfVoice: pct(agg.interactions, current.interactions),
        shareOfViews: pct(agg.views || 0, current.views || 0),
      };
    }).sort((a, b) => b.interactions - a.interactions);

    const platformRows = PLATFORMS.filter((p) => !f.platforms.length || f.platforms.includes(p)).map((p) => {
      const agg = byPlatform.get(p) || { posts: 0, views: null, interactions: 0, likes: 0, comments: 0, shares: 0, saves: 0, posts_with_views: 0 };
      return {
        platform: p, name: providers[p].name, capabilities: providers[p].capabilities,
        accounts: accounts.filter((a) => a.platform === p).length,
        followers: fNowByPlatform.get(p) ?? null,
        posts: agg.posts, views: agg.views, interactions: agg.interactions, likes: agg.likes, comments: agg.comments, shares: agg.shares, saves: agg.saves,
        postsWithViews: agg.posts_with_views,
        avgInteractions: agg.posts ? agg.interactions / agg.posts : 0,
        shareOfVoice: pct(agg.interactions, current.interactions),
      };
    }).filter((r) => r.accounts || r.posts).sort((a, b) => b.interactions - a.interactions);

    const s = series(f, 'a.competitor_id');
    const nameOf = new Map(competitors.map((c) => [c.id, c]));
    s.groups = s.groups.map((g) => ({ ...g, id: g.key, name: nameOf.get(g.key)?.name || `#${g.key}`, slot: nameOf.get(g.key)?.color_slot || 1 }));

    const lastSync = stmt(`SELECT MAX(finished_at) AS t FROM sync_runs WHERE ok = 1`).get()?.t || null;
    return {
      filters: f,
      totals: {
        ...current,
        competitors: competitors.length,
        accounts: accounts.length,
        followers: [...fNowByComp.values()].reduce((a, b) => a + b, 0),
        prev: previous,
      },
      competitors: competitorRows,
      platforms: platformRows,
      matrix,
      series: s,
      topPosts: topPosts(f, { by: 'interactions', limit: 10 }),
      topViewed: topPosts(f, { by: 'views', limit: 10 }),
      accountIssues: accounts.filter((a) => a.status === 'error').map((a) => ({ id: a.id, platform: a.platform, handle: a.handle, error: a.last_error })),
      hasDemoData: Boolean(stmt(`SELECT 1 FROM accounts WHERE status = 'demo' LIMIT 1`).get()),
      lastSync,
    };
  });
}

export function competitorDetail(id, query) {
  const competitor = stmt('SELECT id, name, color_slot, is_self, notes, created_at FROM competitors WHERE id = ?').get(id);
  if (!competitor) return null;
  const f = resolveFilters({ ...query, competitors: String(id) });
  return memo('competitor:' + JSON.stringify(f), () => {
    const accounts = stmt('SELECT * FROM accounts WHERE competitor_id = ? ORDER BY platform').all(id);
    const byAccount = new Map(groupBy(f, 'a.id', 'grp').map((r) => [r.grp, r]));
    const fNow = new Map(followersBefore(f.to).map((r) => [r.account_id, r]));
    const fStart = new Map(followersBefore(f.from).map((r) => [r.account_id, r]));
    const accountRows = accounts.map((a) => {
      const agg = byAccount.get(a.id) || { posts: 0, views: null, interactions: 0, likes: 0, comments: 0, shares: 0, saves: 0, posts_with_views: 0 };
      const followers = fNow.get(a.id)?.followers ?? null;
      const startF = fStart.get(a.id)?.followers ?? null;
      return {
        id: a.id, platform: a.platform, platformName: providers[a.platform]?.name || a.platform, handle: a.handle, displayName: a.display_name,
        avatarUrl: a.avatar_url, profileUrl: a.profile_url, status: a.status, lastSyncedAt: a.last_synced_at, lastError: a.last_error,
        followers, followerGrowth: followers !== null && startF !== null ? followers - startF : null,
        totalViews: fNow.get(a.id)?.total_views ?? null,
        posts: agg.posts, views: agg.views, interactions: agg.interactions, likes: agg.likes, comments: agg.comments, shares: agg.shares, saves: agg.saves,
        avgInteractions: agg.posts ? agg.interactions / agg.posts : 0,
        avgViews: agg.posts_with_views ? (agg.views || 0) / agg.posts_with_views : null,
        engagementRate: rate(agg.interactions, agg.posts, followers),
        capabilities: providers[a.platform]?.capabilities,
      };
    });
    const current = totals(f);
    const previous = totals(f, { from: f.prevFrom, to: f.prevTo });
    const followers = accountRows.reduce((s, a) => s + (a.followers || 0), 0);

    const types = groupBy(f, 'p.type', 'grp').map((r) => ({ type: r.grp, ...r })).sort((a, b) => b.interactions - a.interactions);
    const weekdays = groupBy(f, "CAST(strftime('%w', p.published_at) AS INTEGER)", 'grp');
    const hours = groupBy(f, "CAST(strftime('%H', p.published_at) AS INTEGER)", 'grp');
    const s = series(f, 'a.platform');
    s.groups = s.groups.map((g) => ({ ...g, name: providers[g.key]?.name || g.key }));

    const followerSeries = stmt(`
      SELECT s.captured_on AS day, SUM(s.followers) AS followers FROM snapshots s JOIN accounts a ON a.id = s.account_id
      WHERE a.competitor_id = ? AND s.captured_on >= ? AND s.captured_on < ? ${f.platforms.length ? `AND a.platform IN (${f.platforms.map(() => '?').join(',')})` : ''}
      GROUP BY day ORDER BY day`).all(id, f.from.slice(0, 10), f.to.slice(0, 10), ...f.platforms).map(toNum);

    return {
      filters: f,
      competitor: { id: competitor.id, name: competitor.name, slot: competitor.color_slot, isSelf: Boolean(competitor.is_self), notes: competitor.notes },
      totals: { ...current, followers, prev: previous, engagementRate: rate(current.interactions, current.posts, followers) },
      accounts: accountRows,
      types,
      weekdays: Array.from({ length: 7 }, (_, d) => weekdays.find((r) => r.grp === d) || { grp: d, posts: 0, views: null, interactions: 0 }),
      hours: Array.from({ length: 24 }, (_, h) => hours.find((r) => r.grp === h) || { grp: h, posts: 0, views: null, interactions: 0 }),
      series: s,
      followerSeries,
      topPosts: topPosts(f, { by: 'interactions', limit: 12 }),
      topViewed: topPosts(f, { by: 'views', limit: 12 }),
    };
  });
}

const SORTABLE = { published_at: 'p.published_at', views: 'p.views', interactions: 'p.interactions', likes: 'p.likes', comments: 'p.comments', shares: 'p.shares', engagement: 'engagement' };
export function listPosts(query) {
  const f = resolveFilters(query);
  const w = where(f);
  const params = [...w.params];
  let sql = w.sql;
  if (query.type) { sql += ' AND p.type = ?'; params.push(query.type); }
  if (query.q) { sql += ' AND p.caption LIKE ? ESCAPE \'\\\''; params.push(`%${String(query.q).replace(/[%_\\]/g, '\\$&')}%`); }
  const sort = SORTABLE[query.sort] || 'p.interactions';
  const dir = query.dir === 'asc' ? 'ASC' : 'DESC';
  const pageSize = Math.min(200, Math.max(10, Number(query.pageSize) || 50));
  const page = Math.max(1, Number(query.page) || 1);
  const sums = toNum(stmt(`SELECT ${AGG} FROM posts p JOIN accounts a ON a.id = p.account_id WHERE ${sql}`).get(...params));
  const total = sums.posts;
  const rows = stmt(`SELECT ${POST_SELECT} FROM posts p JOIN accounts a ON a.id = p.account_id JOIN competitors c ON c.id = a.competitor_id
    WHERE ${sql} ORDER BY ${sort} ${dir} NULLS LAST, p.published_at DESC LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize).map(toNum);
  return { filters: f, total: Number(total), page, pageSize, rows, sums };
}

export function exportPosts(query) {
  const f = resolveFilters(query);
  const w = where(f);
  return stmt(`SELECT c.name AS competitor, a.platform, a.handle, p.id, p.published_at, p.type, p.url, p.views, p.likes, p.comments, p.shares, p.saves, p.interactions, p.caption
    FROM posts p JOIN accounts a ON a.id = p.account_id JOIN competitors c ON c.id = a.competitor_id WHERE ${w.sql} ORDER BY p.published_at DESC`).all(...w.params).map(toNum);
}

export function stats() {
  const r = (sql) => Number(db.prepare(sql).get().n);
  return { competitors: r('SELECT COUNT(*) AS n FROM competitors'), accounts: r('SELECT COUNT(*) AS n FROM accounts'), posts: r('SELECT COUNT(*) AS n FROM posts'), snapshots: r('SELECT COUNT(*) AS n FROM snapshots') };
}
