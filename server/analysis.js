import { db, stmt } from './db.js';
import { PLATFORMS, providers } from './providers/index.js';
import { effectiveCapabilities } from './credentials.js';

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
    // 'activity': views/likes/comments/shares gained during the period on any post (needs the per-post history).
    // 'published': lifetime counters of the posts published inside the period.
    mode: query.mode === 'published' ? 'published' : 'activity',
  };
}

function scope(f, alias = 'a') {
  const clauses = [];
  const params = [];
  if (f.competitorIds.length) { clauses.push(`${alias}.competitor_id IN (${f.competitorIds.map(() => '?').join(',')})`); params.push(...f.competitorIds); }
  if (f.platforms.length) { clauses.push(`${alias}.platform IN (${f.platforms.map(() => '?').join(',')})`); params.push(...f.platforms); }
  return { sql: clauses.length ? ' AND ' + clauses.join(' AND ') : '', params };
}

const DAYS_BEFORE = 30; // how far before the period we look for a post's previous snapshot
const dayShift = (iso, days) => new Date(new Date(iso).getTime() + days * DAY).toISOString().slice(0, 10);

/**
 * Metric source: a CTE named `m` with one row per (post, day) and the columns
 * post_id, day, published_at, account_id, competitor_id, platform, type, posts, views, likes, comments, shares, saves, interactions.
 *  - published mode: one row per post published in the window, carrying its lifetime counters.
 *  - activity mode : one row per post snapshot inside the window, carrying the counters gained since the previous snapshot
 *                    (a post published inside the window contributes its full counters on its first snapshot).
 */
function source(f, { from = f.from, to = f.to } = {}) {
  const sc = scope(f);
  if (f.mode === 'published') {
    return {
      sql: `WITH m AS (
        SELECT p.id AS post_id, substr(p.published_at, 1, 10) AS day, p.published_at, p.account_id, a.competitor_id, a.platform, p.type,
               1 AS posts, p.views, p.likes, p.comments, p.shares, p.saves, p.interactions
        FROM posts p JOIN accounts a ON a.id = p.account_id
        WHERE p.published_at >= ? AND p.published_at < ?${sc.sql})`,
      params: [from, to, ...sc.params],
    };
  }
  const fromDay = from.slice(0, 10);
  const toDay = to.slice(0, 10);
  const gain = (col, prev) => `CASE WHEN pl IS NULL THEN CASE WHEN published_at >= ? THEN ${col} ELSE ${col === 'views' ? 'NULL' : '0'} END ELSE MAX(0, ${col} - ${prev}) END AS ${col}`;
  return {
    sql: `WITH snap AS (
        SELECT s.post_id, s.captured_on, p.published_at, p.account_id, a.competitor_id, a.platform, p.type,
               s.views, s.likes, s.comments, s.shares, s.saves,
               LAG(s.views) OVER w AS pv, LAG(s.likes) OVER w AS pl, LAG(s.comments) OVER w AS pc, LAG(s.shares) OVER w AS ps, LAG(s.saves) OVER w AS px
        FROM post_snapshots s JOIN posts p ON p.id = s.post_id JOIN accounts a ON a.id = p.account_id
        WHERE s.captured_on >= ? AND s.captured_on < ? AND p.published_at < ?${sc.sql}
        WINDOW w AS (PARTITION BY s.post_id ORDER BY s.captured_on)
      ), g AS (
        SELECT post_id, captured_on AS day, published_at, account_id, competitor_id, platform, type,
               CASE WHEN pl IS NULL AND published_at >= ? THEN 1 ELSE 0 END AS posts,
               ${gain('views', 'pv')}, ${gain('likes', 'pl')}, ${gain('comments', 'pc')}, ${gain('shares', 'ps')}, ${gain('saves', 'px')}
        FROM snap WHERE captured_on >= ?
      ), m AS (SELECT *, (likes + comments + shares + saves) AS interactions FROM g)`,
    params: [dayShift(from, -DAYS_BEFORE), toDay, to, ...sc.params, from, from, from, from, from, from, fromDay],
  };
}

const AGG = `SUM(m.posts) AS posts, SUM(m.views) AS views, SUM(m.interactions) AS interactions, SUM(m.likes) AS likes,
  SUM(m.comments) AS comments, SUM(m.shares) AS shares, SUM(m.saves) AS saves,
  COUNT(DISTINCT CASE WHEN m.views IS NOT NULL THEN m.post_id END) AS posts_with_views`;

// Aggregate columns where SQL NULL means "nothing counted" and should read as 0. `views` stays NULL (= not available).
const ZERO_WHEN_NULL = new Set(['posts', 'interactions', 'likes', 'comments', 'shares', 'saves', 'posts_with_views']);
const toNum = (row) => {
  const out = {};
  for (const [k, v] of Object.entries(row)) out[k] = v === null ? (ZERO_WHEN_NULL.has(k) ? 0 : null) : typeof v === 'bigint' ? Number(v) : v;
  return out;
};

/* ---------- building blocks ------------------------------------------------ */
function totals(f, window) {
  const src = source(f, window);
  return toNum(stmt(`${src.sql} SELECT ${AGG} FROM m`).get(...src.params));
}

function groupBy(f, expr, alias) {
  const src = source(f);
  return stmt(`${src.sql} SELECT ${expr} AS ${alias}, ${AGG} FROM m GROUP BY ${alias}`).all(...src.params).map(toNum);
}

/** Lifetime counters of every post in scope (no date filter) and the day the per-post history starts. */
function lifetime(f) {
  const sc = scope(f);
  const row = toNum(stmt(`SELECT COUNT(p.id) AS posts, SUM(p.views) AS views, SUM(p.interactions) AS interactions, SUM(p.likes) AS likes, SUM(p.comments) AS comments,
    SUM(p.shares) AS shares, SUM(p.saves) AS saves, SUM(CASE WHEN p.views IS NOT NULL THEN 1 ELSE 0 END) AS posts_with_views
    FROM posts p JOIN accounts a ON a.id = p.account_id WHERE 1=1${sc.sql}`).get(...sc.params));
  const since = stmt(`SELECT MIN(s.captured_on) AS d FROM post_snapshots s JOIN posts p ON p.id = s.post_id JOIN accounts a ON a.id = p.account_id WHERE 1=1${sc.sql}`).get(...sc.params)?.d || null;
  return { ...row, trackingSince: since };
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
  const src = source(f);
  const rows = stmt(`${src.sql} SELECT m.day AS day, ${groupExpr} AS grp, SUM(m.posts) AS posts, SUM(m.views) AS views, SUM(m.interactions) AS interactions
    FROM m GROUP BY day, grp`).all(...src.params).map(toNum);
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

/** Per-post metrics for the window: `pm` (aggregated from m) joined to the post itself. Lifetime counters ride along. */
const POST_SELECT = `p.id, p.account_id, p.published_at, p.type, p.url, p.caption, p.thumbnail_url,
  pm.views, pm.likes, pm.comments, pm.shares, pm.saves, pm.interactions, pm.is_new,
  p.views AS lifetime_views, p.likes AS lifetime_likes, p.comments AS lifetime_comments, p.shares AS lifetime_shares, p.saves AS lifetime_saves, p.interactions AS lifetime_interactions,
  CASE WHEN pm.views > 0 THEN 100.0 * pm.interactions / pm.views END AS engagement,
  a.platform, a.handle, a.display_name, a.competitor_id, c.name AS competitor, c.color_slot`;
const POST_FROM = `, pm AS (SELECT post_id, MAX(posts) AS is_new, SUM(views) AS views, SUM(likes) AS likes, SUM(comments) AS comments, SUM(shares) AS shares, SUM(saves) AS saves, SUM(interactions) AS interactions FROM m GROUP BY post_id)
  SELECT ${POST_SELECT} FROM pm JOIN posts p ON p.id = pm.post_id JOIN accounts a ON a.id = p.account_id JOIN competitors c ON c.id = a.competitor_id`;

function topPosts(f, { by = 'interactions', limit = 10 } = {}) {
  const src = source(f);
  const order = by === 'views' ? 'pm.views DESC NULLS LAST, pm.interactions DESC' : 'pm.interactions DESC, pm.views DESC';
  return stmt(`${src.sql}${POST_FROM} WHERE (pm.interactions > 0 OR pm.views > 0 OR pm.is_new = 1) ORDER BY ${order} LIMIT ?`).all(...src.params, limit).map(toNum);
}

const rate = (interactions, posts, followers) => (posts && followers ? (interactions / posts / followers) * 100 : null);
const pct = (part, whole) => (whole ? (part / whole) * 100 : 0);

/**
 * Is the selected period fully covered by the stored posts of an account?
 * 'full'    : the oldest stored post is older than the period start, or every post the profile has is stored.
 * 'partial' : the account has more posts than we stored and the oldest stored post is inside the period,
 *             so older posts inside the period may be missing (raise POSTS_PER_ACCOUNT, run a full re-sync).
 * 'none'    : nothing stored yet.
 */
export function coverageOf({ postsTotal, oldestPostAt, profilePostsCount, status }, f) {
  if (!postsTotal) return status === 'pending' ? 'none' : 'none';
  if (profilePostsCount !== null && profilePostsCount !== undefined && postsTotal >= profilePostsCount) return 'full';
  if (oldestPostAt && oldestPostAt <= f.from) return 'full';
  return 'partial';
}

/* ---------- public API ----------------------------------------------------- */
export function overview(query) {
  const f = resolveFilters(query);
  return memo('overview:' + JSON.stringify(f), () => {
    const competitors = stmt(`SELECT id, name, color_slot, is_self FROM competitors ${f.competitorIds.length ? `WHERE id IN (${f.competitorIds.map(() => '?').join(',')})` : ''} ORDER BY id`).all(...f.competitorIds);
    const inScopeAccount = (a) => (!f.competitorIds.length || f.competitorIds.includes(a.competitor_id)) && (!f.platforms.length || f.platforms.includes(a.platform));
    const accounts = stmt('SELECT id, competitor_id, platform, handle, display_name, status, last_synced_at, last_error FROM accounts').all().filter(inScopeAccount);

    const current = totals(f);
    const previous = totals(f, { from: f.prevFrom, to: f.prevTo });
    const byCompetitor = new Map(groupBy(f, 'm.competitor_id', 'grp').map((r) => [r.grp, r]));
    const byCompetitorPrev = (() => {
      const src = source(f, { from: f.prevFrom, to: f.prevTo });
      return new Map(stmt(`${src.sql} SELECT m.competitor_id AS grp, ${AGG} FROM m GROUP BY grp`).all(...src.params).map(toNum).map((r) => [r.grp, r]));
    })();
    const byPlatform = new Map(groupBy(f, 'm.platform', 'grp').map((r) => [r.grp, r]));
    const matrix = groupBy(f, "m.competitor_id || ':' || m.platform", 'grp').map((r) => {
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
        platform: p, name: providers[p].name, capabilities: effectiveCapabilities(p),
        accounts: accounts.filter((a) => a.platform === p).length,
        followers: fNowByPlatform.get(p) ?? null,
        posts: agg.posts, views: agg.views, interactions: agg.interactions, likes: agg.likes, comments: agg.comments, shares: agg.shares, saves: agg.saves,
        postsWithViews: agg.posts_with_views,
        avgInteractions: agg.posts ? agg.interactions / agg.posts : 0,
        shareOfVoice: pct(agg.interactions, current.interactions),
      };
    }).filter((r) => r.accounts || r.posts).sort((a, b) => b.interactions - a.interactions);

    const s = series(f, 'm.competitor_id');
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
      lifetime: lifetime(f),
      competitors: competitorRows,
      platforms: platformRows,
      matrix,
      series: s,
      topPosts: topPosts(f, { by: 'interactions', limit: 10 }),
      topViewed: topPosts(f, { by: 'views', limit: 10 }),
      accountIssues: accounts.filter((a) => a.status === 'error').map((a) => ({ id: a.id, platform: a.platform, handle: a.handle, error: a.last_error })),
      coverageIssues: (() => {
        const ids = accounts.map((a) => a.id);
        if (!ids.length) return [];
        const rows = stmt(`SELECT a.id, a.platform, a.handle, COUNT(p.id) AS posts_total, MIN(p.published_at) AS oldest_post_at
          FROM accounts a LEFT JOIN posts p ON p.account_id = a.id WHERE a.id IN (${ids.map(() => '?').join(',')}) GROUP BY a.id`).all(...ids).map(toNum);
        const profileCounts = new Map(followersNow.map((r) => [r.account_id, r.posts_count]));
        return rows.filter((r) => r.posts_total && coverageOf({ postsTotal: r.posts_total, oldestPostAt: r.oldest_post_at, profilePostsCount: profileCounts.get(r.id) ?? null }, f) === 'partial')
          .map((r) => ({ id: r.id, platform: r.platform, handle: r.handle, postsTotal: r.posts_total, oldestPostAt: r.oldest_post_at, profilePostsCount: profileCounts.get(r.id) ?? null }));
      })(),
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
    const accounts = stmt(`SELECT a.*, (SELECT COUNT(*) FROM posts p WHERE p.account_id = a.id) AS posts_total,
      (SELECT MIN(published_at) FROM posts p WHERE p.account_id = a.id) AS oldest_post_at,
      (SELECT MAX(published_at) FROM posts p WHERE p.account_id = a.id) AS newest_post_at
      FROM accounts a WHERE a.competitor_id = ? ORDER BY a.platform`).all(id);
    const byAccount = new Map(groupBy(f, 'm.account_id', 'grp').map((r) => [r.grp, r]));
    const fNow = new Map(followersBefore(f.to).map((r) => [r.account_id, r]));
    const fStart = new Map(followersBefore(f.from).map((r) => [r.account_id, r]));
    const accountRows = accounts.map((a) => {
      const agg = byAccount.get(a.id) || { posts: 0, views: null, interactions: 0, likes: 0, comments: 0, shares: 0, saves: 0, posts_with_views: 0 };
      const followers = fNow.get(a.id)?.followers ?? null;
      const startF = fStart.get(a.id)?.followers ?? null;
      return {
        id: a.id, platform: a.platform, platformName: providers[a.platform]?.name || a.platform, handle: a.handle, displayName: a.display_name,
        avatarUrl: a.avatar_url, profileUrl: a.profile_url, status: a.status, lastSyncedAt: a.last_synced_at, lastError: a.last_error, postsTotal: Number(a.posts_total),
        oldestPostAt: a.oldest_post_at, newestPostAt: a.newest_post_at, profilePostsCount: fNow.get(a.id)?.posts_count ?? null,
        coverage: coverageOf({ postsTotal: Number(a.posts_total), oldestPostAt: a.oldest_post_at, profilePostsCount: fNow.get(a.id)?.posts_count ?? null, status: a.status }, f),
        followers, followerGrowth: followers !== null && startF !== null ? followers - startF : null,
        totalViews: fNow.get(a.id)?.total_views ?? null,
        posts: agg.posts, views: agg.views, interactions: agg.interactions, likes: agg.likes, comments: agg.comments, shares: agg.shares, saves: agg.saves,
        avgInteractions: agg.posts ? agg.interactions / agg.posts : 0,
        avgViews: agg.posts_with_views ? (agg.views || 0) / agg.posts_with_views : null,
        engagementRate: rate(agg.interactions, agg.posts, followers),
        capabilities: effectiveCapabilities(a.platform),
      };
    });
    const current = totals(f);
    const previous = totals(f, { from: f.prevFrom, to: f.prevTo });
    const followers = accountRows.reduce((s, a) => s + (a.followers || 0), 0);

    const types = groupBy(f, 'm.type', 'grp').map((r) => ({ type: r.grp, ...r })).sort((a, b) => b.interactions - a.interactions);
    const weekdays = groupBy(f, "CAST(strftime('%w', m.published_at) AS INTEGER)", 'grp');
    const hours = groupBy(f, "CAST(strftime('%H', m.published_at) AS INTEGER)", 'grp');
    const s = series(f, 'm.platform');
    s.groups = s.groups.map((g) => ({ ...g, name: providers[g.key]?.name || g.key }));

    const followerSeries = stmt(`
      SELECT s.captured_on AS day, SUM(s.followers) AS followers FROM snapshots s JOIN accounts a ON a.id = s.account_id
      WHERE a.competitor_id = ? AND s.captured_on >= ? AND s.captured_on < ? ${f.platforms.length ? `AND a.platform IN (${f.platforms.map(() => '?').join(',')})` : ''}
      GROUP BY day ORDER BY day`).all(id, f.from.slice(0, 10), f.to.slice(0, 10), ...f.platforms).map(toNum);

    return {
      filters: f,
      competitor: { id: competitor.id, name: competitor.name, slot: competitor.color_slot, isSelf: Boolean(competitor.is_self), notes: competitor.notes },
      totals: { ...current, followers, prev: previous, engagementRate: rate(current.interactions, current.posts, followers) },
      lifetime: lifetime(f),
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

const SORTABLE = { published_at: 'p.published_at', views: 'pm.views', interactions: 'pm.interactions', likes: 'pm.likes', comments: 'pm.comments', shares: 'pm.shares', engagement: 'engagement' };
export function listPosts(query) {
  const f = resolveFilters(query);
  const src = source(f);
  const extra = [];
  const params = [];
  if (query.type) { extra.push('p.type = ?'); params.push(query.type); }
  if (query.q) { extra.push("p.caption LIKE ? ESCAPE '\\'"); params.push(`%${String(query.q).replace(/[%_\\]/g, '\\$&')}%`); }
  if (f.mode === 'activity') extra.push('(pm.interactions > 0 OR pm.views > 0 OR pm.is_new = 1)');
  const whereSql = extra.length ? ` WHERE ${extra.join(' AND ')}` : '';
  const sort = SORTABLE[query.sort] || 'pm.interactions';
  const dir = query.dir === 'asc' ? 'ASC' : 'DESC';
  const pageSize = Math.min(200, Math.max(10, Number(query.pageSize) || 50));
  const page = Math.max(1, Number(query.page) || 1);
  const base = `${src.sql}${POST_FROM}${whereSql}`;
  const sums = toNum(stmt(`SELECT COUNT(*) AS posts, SUM(views) AS views, SUM(interactions) AS interactions, SUM(likes) AS likes, SUM(comments) AS comments, SUM(shares) AS shares, SUM(saves) AS saves,
    SUM(CASE WHEN views IS NOT NULL THEN 1 ELSE 0 END) AS posts_with_views FROM (${base})`).get(...src.params, ...params));
  const rows = stmt(`${base} ORDER BY ${sort} ${dir} NULLS LAST, p.published_at DESC LIMIT ? OFFSET ?`).all(...src.params, ...params, pageSize, (page - 1) * pageSize).map(toNum);
  return { filters: f, total: Number(sums.posts), page, pageSize, rows, sums };
}

export function exportPosts(query) {
  const f = resolveFilters(query);
  const src = source(f);
  return stmt(`${src.sql}${POST_FROM} ORDER BY p.published_at DESC`).all(...src.params).map(toNum)
    .map((r) => ({ competitor: r.competitor, platform: r.platform, handle: r.handle, id: r.id, published_at: r.published_at, type: r.type, url: r.url,
      [f.mode === 'activity' ? 'views_gained' : 'views']: r.views, [f.mode === 'activity' ? 'likes_gained' : 'likes']: r.likes, [f.mode === 'activity' ? 'comments_gained' : 'comments']: r.comments,
      [f.mode === 'activity' ? 'shares_gained' : 'shares']: r.shares, [f.mode === 'activity' ? 'saves_gained' : 'saves']: r.saves, [f.mode === 'activity' ? 'interactions_gained' : 'interactions']: r.interactions,
      lifetime_views: r.lifetime_views, lifetime_interactions: r.lifetime_interactions, caption: r.caption }));
}

export function stats() {
  const r = (sql) => Number(db.prepare(sql).get().n);
  return { competitors: r('SELECT COUNT(*) AS n FROM competitors'), accounts: r('SELECT COUNT(*) AS n FROM accounts'), posts: r('SELECT COUNT(*) AS n FROM posts'), snapshots: r('SELECT COUNT(*) AS n FROM snapshots') };
}
