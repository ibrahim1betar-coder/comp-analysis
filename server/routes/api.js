import { createHash } from 'node:crypto';
import { db, stmt, transaction, nowIso, today, getSetting, setSetting } from '../db.js';
import { config } from '../config.js';
import { providers, PLATFORMS, getProvider, normaliseHandle, describeProviders } from '../providers/index.js';
import { getCredentials, saveCredentials, deleteCredentials, configuredPlatforms, describeCredentials, getShared } from '../credentials.js';
import { syncAll, syncAccount, syncState, storeAccountData } from '../collector.js';
import * as analysis from '../analysis.js';
import { overviewInsights, competitorInsights } from '../insights.js';
import { authEnabled, userFromRequest, login, logout, publicUser, listUsers, createUser, setPassword, deleteUser, getUser, countAdmins, verifyUser, refreshCookie } from '../auth.js';
import { parseCsv, toCsv, IMPORT_TEMPLATE } from '../csv.js';

const bad = (reply, message, code = 400) => reply.code(code).send({ error: message });

/** Send JSON with an ETag so unchanged dashboards get a 304 and no body. */
function cached(request, reply, payload) {
  const body = JSON.stringify(payload);
  const etag = `W/"${createHash('sha1').update(body).digest('base64url').slice(0, 20)}"`;
  if (request.headers['if-none-match'] === etag) return reply.code(304).send();
  return reply.header('ETag', etag).header('Cache-Control', 'private, no-cache').type('application/json').send(body);
}

function nextColorSlot() {
  const used = new Set(db.prepare('SELECT color_slot FROM competitors').all().map((r) => r.color_slot));
  for (let i = 1; i <= 8; i++) if (!used.has(i)) return i;
  return (db.prepare('SELECT COUNT(*) AS n FROM competitors').get().n % 8) + 1;
}

export default async function routes(app) {
  /* ---- session & users ---- */
  app.get('/api/health', async () => ({ ok: true, time: nowIso() }));
  app.get('/api/session', async (req) => {
    const u = authEnabled() ? userFromRequest(req) : { id: 0, username: 'local', role: 'admin' };
    return { authRequired: authEnabled(), authenticated: Boolean(u), user: publicUser(u) };
  });
  app.post('/api/login', async (req, reply) => {
    if (!authEnabled()) return { ok: true };
    const u = login(reply, req.body?.username, req.body?.password);
    if (!u) return bad(reply, 'Wrong username or password', 401);
    return { ok: true, user: publicUser(u) };
  });
  app.post('/api/logout', async (req, reply) => { logout(reply); return { ok: true }; });

  app.get('/api/users', async (req, reply) => (req.user?.role === 'admin' ? listUsers() : bad(reply, 'Admins only', 403)));
  app.post('/api/users', async (req, reply) => {
    if (req.user?.role !== 'admin') return bad(reply, 'Admins only', 403);
    try { return { id: createUser({ username: req.body?.username, password: req.body?.password, role: req.body?.role || 'viewer' }) }; }
    catch (e) { return bad(reply, e.message); }
  });
  app.put('/api/users/:id/password', async (req, reply) => {
    if (req.user?.role !== 'admin') return bad(reply, 'Admins only', 403);
    const u = getUser(Number(req.params.id));
    if (!u) return bad(reply, 'Not found', 404);
    try { setPassword(u.id, req.body?.password); if (u.id === req.user.id) refreshCookie(reply, getUser(u.id)); return { ok: true }; }
    catch (e) { return bad(reply, e.message); }
  });
  app.delete('/api/users/:id', async (req, reply) => {
    if (req.user?.role !== 'admin') return bad(reply, 'Admins only', 403);
    const u = getUser(Number(req.params.id));
    if (!u) return bad(reply, 'Not found', 404);
    if (u.role === 'admin' && countAdmins() <= 1) return bad(reply, 'Cannot delete the last admin');
    if (u.id === req.user.id) return bad(reply, 'You cannot delete your own account while signed in');
    deleteUser(u.id);
    return { ok: true };
  });
  /** Any signed-in user may change their own password by proving the current one. */
  app.put('/api/me/password', async (req, reply) => {
    if (!authEnabled()) return bad(reply, 'Authentication is disabled (AUTH_DISABLED=1)');
    if (!verifyUser(req.user.username, req.body?.currentPassword)) return bad(reply, 'Current password is wrong', 401);
    try { setPassword(req.user.id, req.body?.password); refreshCookie(reply, getUser(req.user.id)); return { ok: true }; }
    catch (e) { return bad(reply, e.message); }
  });

  /* ---- meta ---- */
  app.get('/api/meta', async (req) => ({
    providers: describeProviders(configuredPlatforms()),
    sharedApifyToken: Boolean(getShared('apify')),
    sync: { intervalMinutes: config.syncIntervalMinutes, lookbackDays: config.lookbackDays, postsPerAccount: config.postsPerAccount, concurrency: config.syncConcurrency },
    stats: analysis.stats(),
    importTemplate: IMPORT_TEMPLATE,
    authRequired: authEnabled(),
    user: publicUser(authEnabled() ? userFromRequest(req) : { id: 0, username: 'local', role: 'admin' }),
  }));

  /* ---- competitors & accounts ---- */
  app.get('/api/competitors', async () => {
    const competitors = db.prepare('SELECT id, name, color_slot AS slot, is_self AS isSelf, notes, created_at AS createdAt FROM competitors ORDER BY id').all();
    const accounts = db.prepare('SELECT id, competitor_id, platform, handle, display_name, avatar_url, profile_url, status, last_synced_at, last_error FROM accounts ORDER BY platform').all();
    return competitors.map((c) => ({ ...c, isSelf: Boolean(c.isSelf), accounts: accounts.filter((a) => a.competitor_id === c.id) }));
  });

  app.post('/api/competitors', async (req, reply) => {
    const name = String(req.body?.name || '').trim();
    if (!name) return bad(reply, 'Name is required');
    if (db.prepare('SELECT 1 FROM competitors WHERE name = ? COLLATE NOCASE').get(name)) return bad(reply, 'A competitor with that name already exists', 409);
    const info = stmt('INSERT INTO competitors (name, color_slot, is_self, notes) VALUES (?, ?, ?, ?)').run(name, nextColorSlot(), req.body?.isSelf ? 1 : 0, req.body?.notes || null);
    const id = Number(info.lastInsertRowid);
    const accounts = Array.isArray(req.body?.accounts) ? req.body.accounts : [];
    const created = [];
    const errors = [];
    for (const acc of accounts) {
      try { created.push(addAccount(id, acc.platform, acc.handle)); } catch (e) { errors.push(`${acc.platform} ${acc.handle}: ${e.message}`); }
    }
    analysis.invalidate();
    return { id, name, accounts: created, errors };
  });

  app.put('/api/competitors/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const row = stmt('SELECT * FROM competitors WHERE id = ?').get(id);
    if (!row) return bad(reply, 'Not found', 404);
    const name = req.body?.name !== undefined ? String(req.body.name).trim() : row.name;
    if (!name) return bad(reply, 'Name is required');
    const slot = req.body?.slot !== undefined ? Math.min(8, Math.max(1, Number(req.body.slot) || 1)) : row.color_slot;
    stmt('UPDATE competitors SET name = ?, color_slot = ?, is_self = ?, notes = ? WHERE id = ?')
      .run(name, slot, req.body?.isSelf !== undefined ? (req.body.isSelf ? 1 : 0) : row.is_self, req.body?.notes !== undefined ? req.body.notes : row.notes, id);
    analysis.invalidate();
    return { ok: true };
  });

  app.delete('/api/competitors/:id', async (req, reply) => {
    const r = stmt('DELETE FROM competitors WHERE id = ?').run(Number(req.params.id));
    analysis.invalidate();
    return r.changes ? { ok: true } : bad(reply, 'Not found', 404);
  });

  function addAccount(competitorId, platform, handle) {
    if (!PLATFORMS.includes(platform)) throw new Error(`Unknown platform "${platform}"`);
    const h = normaliseHandle(platform, handle);
    if (!h) throw new Error('Handle is required');
    const existing = stmt('SELECT id, competitor_id FROM accounts WHERE platform = ? AND handle = ?').get(platform, h);
    if (existing) throw new Error(`${providers[platform].name} account "${h}" is already tracked`);
    const info = stmt('INSERT INTO accounts (competitor_id, platform, handle, status) VALUES (?, ?, ?, ?)').run(competitorId, platform, h, 'pending');
    return { id: Number(info.lastInsertRowid), platform, handle: h, status: 'pending' };
  }

  app.post('/api/competitors/:id/accounts', async (req, reply) => {
    const id = Number(req.params.id);
    if (!stmt('SELECT 1 FROM competitors WHERE id = ?').get(id)) return bad(reply, 'Competitor not found', 404);
    try {
      const acc = addAccount(id, req.body?.platform, req.body?.handle);
      analysis.invalidate();
      // Collect straight away if the platform is connected; the UI polls /api/sync/status.
      if (getCredentials(acc.platform) && req.body?.sync !== false) syncAccount(acc.id).then(() => analysis.invalidate()).catch(() => {});
      return acc;
    } catch (e) { return bad(reply, e.message, 409); }
  });

  app.delete('/api/accounts/:id', async (req, reply) => {
    const r = stmt('DELETE FROM accounts WHERE id = ?').run(Number(req.params.id));
    analysis.invalidate();
    return r.changes ? { ok: true } : bad(reply, 'Not found', 404);
  });

  app.post('/api/accounts/:id/sync', async (req, reply) => {
    const id = Number(req.params.id);
    if (!stmt('SELECT 1 FROM accounts WHERE id = ?').get(id)) return bad(reply, 'Not found', 404);
    const res = await syncAccount(id, { full: Boolean(req.body?.full) });
    analysis.invalidate();
    return res;
  });

  /* ---- credentials ---- */
  app.get('/api/credentials', async () => describeCredentials());
  app.put('/api/credentials/:platform', async (req, reply) => {
    const { platform } = req.params;
    if (!PLATFORMS.includes(platform)) return bad(reply, 'Unknown platform', 404);
    try {
      const clean = saveCredentials(platform, req.body || {});
      let test = null;
      if (req.body?.test !== false) {
        try { test = { ok: true, message: await getProvider(platform).test(clean) }; }
        catch (e) { test = { ok: false, message: e.message }; }
      }
      return { ok: true, test };
    } catch (e) { return bad(reply, e.message); }
  });
  app.post('/api/credentials/:platform/test', async (req, reply) => {
    const { platform } = req.params;
    if (!PLATFORMS.includes(platform)) return bad(reply, 'Unknown platform', 404);
    const creds = getCredentials(platform);
    if (!creds) return bad(reply, 'No credentials saved for this platform');
    try { return { ok: true, message: await getProvider(platform).test(creds) }; }
    catch (e) { return { ok: false, message: e.message }; }
  });
  app.delete('/api/credentials/:platform', async (req) => { deleteCredentials(req.params.platform); return { ok: true }; });

  /* ---- sync ---- */
  app.post('/api/sync', async (req) => {
    const full = Boolean(req.body?.full);
    // Fire and forget; progress via /api/sync/status.
    syncAll({ full }).then(() => analysis.invalidate()).catch((e) => app.log.error(e));
    await new Promise((r) => setTimeout(r, 50));
    return { started: syncState.running, state: syncState };
  });
  app.get('/api/sync/status', async () => ({ ...syncState, scheduler: config.syncIntervalMinutes > 0 ? `every ${config.syncIntervalMinutes} min` : 'disabled' }));
  app.get('/api/sync/runs', async (req) => db.prepare(`
      SELECT r.id, r.account_id, a.platform, a.handle, c.name AS competitor, r.started_at, r.finished_at, r.ok, r.message, r.posts_upserted
      FROM sync_runs r LEFT JOIN accounts a ON a.id = r.account_id LEFT JOIN competitors c ON c.id = a.competitor_id
      ORDER BY r.id DESC LIMIT ?`).all(Math.min(200, Number(req.query.limit) || 50)));

  /* ---- analysis ---- */
  app.get('/api/analysis/overview', async (req, reply) => {
    const data = analysis.overview(req.query);
    return cached(req, reply, { ...data, insights: overviewInsights(data) });
  });
  app.get('/api/analysis/competitors/:id', async (req, reply) => {
    const data = analysis.competitorDetail(Number(req.params.id), req.query);
    if (!data) return bad(reply, 'Not found', 404);
    return cached(req, reply, { ...data, insights: competitorInsights(data) });
  });
  app.get('/api/analysis/posts', async (req, reply) => cached(req, reply, analysis.listPosts(req.query)));
  app.get('/api/export/posts.csv', async (req, reply) => {
    const rows = analysis.exportPosts(req.query);
    return reply.type('text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="competitor-posts-${today()}.csv"`).send(toCsv(rows));
  });

  /* ---- import (CSV or JSON rows) ---- */
  app.get('/api/import/template.csv', async (req, reply) => reply.type('text/csv; charset=utf-8').header('Content-Disposition', 'attachment; filename="import-template.csv"').send(toCsv(IMPORT_TEMPLATE.example, IMPORT_TEMPLATE.columns)));
  app.post('/api/import', async (req, reply) => {
    let rows;
    if (typeof req.body === 'string') rows = parseCsv(req.body);
    else if (Array.isArray(req.body?.rows)) rows = req.body.rows;
    else if (typeof req.body?.csv === 'string') rows = parseCsv(req.body.csv);
    else return bad(reply, 'Send CSV text (text/csv) or JSON {rows:[...]}');
    if (!rows.length) return bad(reply, 'No rows found');

    const result = { rows: rows.length, posts: 0, accounts: 0, competitors: 0, errors: [] };
    const grouped = new Map(); // competitor|platform|handle -> rows
    rows.forEach((r, i) => {
      const platform = String(r.platform || '').toLowerCase().trim();
      if (!PLATFORMS.includes(platform)) return result.errors.push(`Row ${i + 2}: unknown platform "${r.platform}"`);
      if (!r.competitor || !r.handle) return result.errors.push(`Row ${i + 2}: competitor and handle are required`);
      const key = `${r.competitor.trim()}|${platform}|${normaliseHandle(platform, r.handle)}`;
      (grouped.get(key) || grouped.set(key, []).get(key)).push(r);
    });

    transaction(() => {
      for (const [key, list] of grouped) {
        const [name, platform, handle] = key.split('|');
        let comp = stmt('SELECT id FROM competitors WHERE name = ? COLLATE NOCASE').get(name);
        if (!comp) { comp = { id: Number(stmt('INSERT INTO competitors (name, color_slot) VALUES (?, ?)').run(name, nextColorSlot()).lastInsertRowid) }; result.competitors++; }
        let acc = stmt('SELECT id FROM accounts WHERE platform = ? AND handle = ?').get(platform, handle);
        if (!acc) { acc = { id: Number(stmt('INSERT INTO accounts (competitor_id, platform, handle, status) VALUES (?, ?, ?, ?)').run(comp.id, platform, handle, 'manual').lastInsertRowid) }; result.accounts++; }
        const posts = list.filter((r) => r.post_id && r.published_at && !Number.isNaN(Date.parse(r.published_at))).map((r) => ({
          externalId: r.post_id, publishedAt: r.published_at, type: r.type || 'post', url: r.url || null, caption: r.caption || null,
          views: r.views === '' || r.views === undefined ? null : Number(r.views), likes: Number(r.likes) || 0, comments: Number(r.comments) || 0, shares: Number(r.shares) || 0, saves: Number(r.saves) || 0,
        }));
        const followersRow = list.find((r) => r.followers !== '' && r.followers !== undefined && !Number.isNaN(Number(r.followers)));
        const profile = followersRow ? { followers: Number(followersRow.followers), capturedOn: (followersRow.captured_on || today()).slice(0, 10) } : null;
        result.posts += storeAccountData(acc.id, platform, { profile, posts }, { markSynced: false });
        stmt(`UPDATE accounts SET status = CASE WHEN status = 'pending' THEN 'manual' ELSE status END, last_synced_at = ? WHERE id = ?`).run(nowIso(), acc.id);
      }
    });
    analysis.invalidate();
    return result;
  });

  /* ---- maintenance ---- */
  app.get('/api/settings', async () => ({ ...getSetting('ui', {}), sync: { intervalMinutes: config.syncIntervalMinutes } }));
  app.put('/api/settings', async (req) => { setSetting('ui', req.body || {}); return { ok: true }; });
  app.post('/api/maintenance/clear-demo', async () => {
    const r = transaction(() => {
      const ids = db.prepare(`SELECT DISTINCT competitor_id FROM accounts WHERE status = 'demo'`).all().map((x) => x.competitor_id);
      stmt(`DELETE FROM accounts WHERE status = 'demo'`).run();
      let removed = 0;
      for (const id of ids) if (!stmt('SELECT 1 FROM accounts WHERE competitor_id = ?').get(id)) { stmt('DELETE FROM competitors WHERE id = ?').run(id); removed++; }
      return removed;
    });
    analysis.invalidate();
    return { ok: true, competitorsRemoved: r };
  });
  app.post('/api/maintenance/reset', async (req, reply) => {
    if (req.body?.confirm !== 'DELETE') return bad(reply, 'Send {"confirm":"DELETE"}');
    transaction(() => { for (const t of ['sync_runs', 'posts', 'snapshots', 'accounts', 'competitors']) db.exec(`DELETE FROM ${t}`); });
    analysis.invalidate();
    return { ok: true };
  });
}
