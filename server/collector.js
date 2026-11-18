import { db, stmt, transaction, nowIso, today } from './db.js';
import { config } from './config.js';
import { getProvider } from './providers/index.js';
import { getCredentials } from './credentials.js';

/** In-memory progress that the UI polls. */
export const syncState = {
  running: false,
  startedAt: null,
  finishedAt: null,
  total: 0,
  done: 0,
  current: [],
  lastResult: null,
};

const upsertPost = () => stmt(`
  INSERT INTO posts (id, account_id, published_at, type, url, caption, thumbnail_url, views, likes, comments, shares, saves, fetched_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    published_at = excluded.published_at, type = excluded.type, url = excluded.url, caption = excluded.caption,
    thumbnail_url = COALESCE(excluded.thumbnail_url, posts.thumbnail_url),
    views = COALESCE(excluded.views, posts.views), likes = excluded.likes, comments = excluded.comments,
    shares = excluded.shares, saves = excluded.saves, fetched_at = excluded.fetched_at
`);

const upsertSnapshot = () => stmt(`
  INSERT INTO snapshots (account_id, captured_on, followers, following, posts_count, total_views, total_likes)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(account_id, captured_on) DO UPDATE SET
    followers = COALESCE(excluded.followers, snapshots.followers), following = COALESCE(excluded.following, snapshots.following),
    posts_count = COALESCE(excluded.posts_count, snapshots.posts_count), total_views = COALESCE(excluded.total_views, snapshots.total_views),
    total_likes = COALESCE(excluded.total_likes, snapshots.total_likes)
`);

const upsertPostSnapshot = () => stmt(`
  INSERT INTO post_snapshots (post_id, captured_on, views, likes, comments, shares, saves) VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(post_id, captured_on) DO UPDATE SET views = COALESCE(excluded.views, post_snapshots.views), likes = excluded.likes,
    comments = excluded.comments, shares = excluded.shares, saves = excluded.saves
`);

const clampInt = (v) => (v === null || v === undefined || Number.isNaN(Number(v)) ? null : Math.max(0, Math.round(Number(v))));

/** Store a provider result (or an import) for an account. Returns number of posts written. */
export function storeAccountData(accountId, platform, { profile, posts }, { markSynced = true } = {}) {
  const fetchedAt = nowIso();
  return transaction(() => {
    const ins = upsertPost();
    const snap = upsertPostSnapshot();
    const day = fetchedAt.slice(0, 10);
    let count = 0;
    for (const p of posts) {
      if (!p.externalId || !p.publishedAt) continue;
      const id = `${platform}:${p.externalId}`;
      const views = clampInt(p.views);
      const likes = clampInt(p.likes) ?? 0;
      const comments = clampInt(p.comments) ?? 0;
      const shares = clampInt(p.shares) ?? 0;
      const saves = clampInt(p.saves) ?? 0;
      ins.run(id, accountId, new Date(p.publishedAt).toISOString(), p.type || 'post', p.url || null,
        p.caption ? String(p.caption).slice(0, 2000) : null, p.thumbnailUrl || null, views, likes, comments, shares, saves, fetchedAt);
      snap.run(id, p.capturedOn ? String(p.capturedOn).slice(0, 10) : day, views, likes, comments, shares, saves);
      count++;
    }
    if (profile) {
      upsertSnapshot().run(accountId, profile.capturedOn || today(), clampInt(profile.followers), clampInt(profile.following), clampInt(profile.postsCount), clampInt(profile.totalViews), clampInt(profile.totalLikes));
      stmt(`UPDATE accounts SET external_id = COALESCE(?, external_id), display_name = COALESCE(?, display_name),
            avatar_url = COALESCE(?, avatar_url), profile_url = COALESCE(?, profile_url) WHERE id = ?`)
        .run(profile.externalId ?? null, profile.displayName ?? null, profile.avatarUrl ?? null, profile.profileUrl ?? null, accountId);
    }
    if (markSynced) stmt(`UPDATE accounts SET status = 'ok', last_synced_at = ?, last_error = NULL WHERE id = ?`).run(fetchedAt, accountId);
    return count;
  });
}

/**
 * Date floor for a collection, as ISO string or null (= no floor, newest POSTS_PER_ACCOUNT posts).
 * First sync and full re-sync: no floor, so accounts that post rarely still show their latest posts.
 * Incremental sync: re-read the last 14 days (counters keep updating) plus anything newer, never older than the look-back.
 */
export function computeSince(account, { full = false, now = Date.now() } = {}) {
  if (full || !account.last_synced_at || !account.has_posts) return null;
  const lookback = now - config.lookbackDays * 86400_000;
  const recent = new Date(account.last_synced_at).getTime() - 14 * 86400_000;
  return new Date(Math.max(lookback, recent)).toISOString();
}

/** Sync one account. `full` re-collects everything instead of only recent posts. */
export async function syncAccount(accountId, { full = false } = {}) {
  const account = stmt('SELECT a.*, EXISTS(SELECT 1 FROM posts WHERE account_id = a.id) AS has_posts FROM accounts a WHERE a.id = ?').get(accountId);
  if (!account) throw new Error(`Account ${accountId} not found`);
  const startedAt = nowIso();
  const runId = stmt('INSERT INTO sync_runs (account_id, started_at) VALUES (?, ?)').run(accountId, startedAt).lastInsertRowid;
  try {
    const provider = getProvider(account.platform);
    const creds = getCredentials(account.platform);
    if (!creds) throw new Error(`${provider.name} is not connected. Add credentials on the Connect page.`);

    const since = computeSince(account, { full });
    const result = await provider.fetchAccount(account.handle, creds, { since, maxPosts: config.postsPerAccount });
    const count = storeAccountData(accountId, account.platform, result);
    stmt('UPDATE sync_runs SET finished_at = ?, ok = 1, message = ?, posts_upserted = ? WHERE id = ?').run(nowIso(), `${count} posts`, count, runId);
    return { ok: true, posts: count };
  } catch (err) {
    const message = err.message || String(err);
    stmt(`UPDATE accounts SET status = 'error', last_error = ? WHERE id = ?`).run(message.slice(0, 500), accountId);
    stmt('UPDATE sync_runs SET finished_at = ?, ok = 0, message = ? WHERE id = ?').run(nowIso(), message.slice(0, 500), runId);
    return { ok: false, error: message };
  }
}

/** Run `fn` over `items` with at most `limit` in flight. */
async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Sync every account (or the given ids). Accounts are interleaved by platform so one API's rate limit does not stall the rest. */
export async function syncAll({ accountIds = null, full = false, onlyStale = false } = {}) {
  if (syncState.running) return { skipped: true, reason: 'A sync is already running' };
  let rows = accountIds
    ? db.prepare(`SELECT id, platform, handle, last_synced_at FROM accounts WHERE id IN (${accountIds.map(() => '?').join(',')})`).all(...accountIds)
    : db.prepare(`SELECT id, platform, handle, last_synced_at FROM accounts WHERE status != 'demo' ORDER BY platform, id`).all();
  if (onlyStale && config.syncIntervalMinutes > 0) {
    const cutoff = Date.now() - config.syncIntervalMinutes * 60_000;
    rows = rows.filter((r) => !r.last_synced_at || new Date(r.last_synced_at).getTime() < cutoff);
  }
  // Round-robin interleave by platform.
  const byPlatform = new Map();
  for (const r of rows) (byPlatform.get(r.platform) || byPlatform.set(r.platform, []).get(r.platform)).push(r);
  const ordered = [];
  while (ordered.length < rows.length) for (const list of byPlatform.values()) if (list.length) ordered.push(list.shift());

  Object.assign(syncState, { running: true, startedAt: nowIso(), finishedAt: null, total: ordered.length, done: 0, current: [], lastResult: null });
  const summary = { total: ordered.length, ok: 0, failed: 0, posts: 0, errors: [] };
  try {
    await pool(ordered, config.syncConcurrency, async (acc) => {
      const label = `${acc.platform}:${acc.handle}`;
      syncState.current.push(label);
      const res = await syncAccount(acc.id, { full });
      syncState.current = syncState.current.filter((l) => l !== label);
      syncState.done++;
      if (res.ok) { summary.ok++; summary.posts += res.posts; } else { summary.failed++; summary.errors.push({ account: label, error: res.error }); }
    });
  } finally {
    Object.assign(syncState, { running: false, finishedAt: nowIso(), current: [], lastResult: summary });
  }
  return summary;
}

let timer = null;
export function startScheduler(log = console) {
  if (config.syncIntervalMinutes <= 0) return;
  const tick = async () => {
    try {
      const res = await syncAll({ onlyStale: true });
      if (!res.skipped && res.total) log.info(`Scheduled sync: ${res.ok} ok, ${res.failed} failed, ${res.posts} posts`);
    } catch (err) {
      log.error(err, 'Scheduled sync failed');
    }
  };
  setTimeout(tick, 15_000).unref();
  timer = setInterval(tick, Math.max(5, config.syncIntervalMinutes) * 60_000);
  timer.unref();
}
