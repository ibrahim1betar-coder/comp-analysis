import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { db, stmt, nowIso } from './db.js';
import { config } from './config.js';
import { sign, safeEqual } from './crypto.js';

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  salt          TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'admin',
  must_change   INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_login_at TEXT
);`);

const COOKIE = 'cp_session';
const PUBLIC = new Set(['/api/health', '/api/session', '/api/login', '/api/logout']);
export const DEFAULT_ADMIN = { username: 'admin', password: 'admin123' };

export const authEnabled = () => !config.authDisabled;

function hash(password, salt) {
  return scryptSync(String(password), salt, 64).toString('hex');
}
export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 8) throw new Error('Password must be at least 8 characters');
  if (password.length > 200) throw new Error('Password is too long');
}
export function validateUsername(username) {
  if (typeof username !== 'string' || !/^[a-zA-Z0-9._-]{2,40}$/.test(username)) throw new Error('Username must be 2-40 characters: letters, numbers, dot, dash or underscore');
}

export function createUser({ username, password, role = 'admin', mustChange = false }) {
  validateUsername(username);
  validatePassword(password);
  if (!['admin', 'viewer'].includes(role)) throw new Error('Role must be admin or viewer');
  if (stmt('SELECT 1 FROM users WHERE username = ?').get(username)) throw new Error('That username already exists');
  const salt = randomBytes(16).toString('hex');
  const info = stmt('INSERT INTO users (username, password_hash, salt, role, must_change) VALUES (?, ?, ?, ?, ?)').run(username, hash(password, salt), salt, role, mustChange ? 1 : 0);
  return Number(info.lastInsertRowid);
}

export function setPassword(userId, password) {
  validatePassword(password);
  const salt = randomBytes(16).toString('hex');
  stmt('UPDATE users SET password_hash = ?, salt = ?, must_change = 0 WHERE id = ?').run(hash(password, salt), salt, userId);
}

export function verifyUser(username, password) {
  const u = stmt('SELECT * FROM users WHERE username = ?').get(String(username || ''));
  if (!u) { hash(password || '', 'dummy-salt'); return null; } // constant-ish time
  const a = Buffer.from(hash(password || '', u.salt), 'hex');
  const b = Buffer.from(u.password_hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b) ? u : null;
}

export const publicUser = (u) => (u ? { id: u.id, username: u.username, role: u.role, mustChange: Boolean(u.must_change), createdAt: u.created_at, lastLoginAt: u.last_login_at } : null);
export const listUsers = () => stmt('SELECT * FROM users ORDER BY id').all().map(publicUser);
export const countAdmins = () => Number(stmt(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin'`).get().n);
export const deleteUser = (id) => stmt('DELETE FROM users WHERE id = ?').run(id).changes;
export const getUser = (id) => stmt('SELECT * FROM users WHERE id = ?').get(id);

/** Create the first admin account if the users table is empty. Returns what was created (for the console). */
export function ensureAdmin() {
  if (stmt('SELECT 1 FROM users LIMIT 1').get()) return null;
  const username = config.adminUsername || DEFAULT_ADMIN.username;
  const password = config.adminPassword || DEFAULT_ADMIN.password;
  createUser({ username, password, role: 'admin', mustChange: !config.adminPassword });
  return { username, password, isDefault: !config.adminPassword };
}

// Session cookie: "<userId>.<hmac(userId:password_hash)>" so changing the password logs every session out.
const token = (u) => `${u.id}.${sign(`session:${u.id}:${u.password_hash}`)}`;

export function userFromRequest(request) {
  const c = request.cookies?.[COOKIE];
  if (!c) return null;
  const id = Number(c.split('.')[0]);
  const u = id ? getUser(id) : null;
  return u && safeEqual(c, token(u)) ? u : null;
}

export function login(reply, username, password) {
  const u = verifyUser(username, password);
  if (!u) return null;
  stmt('UPDATE users SET last_login_at = ? WHERE id = ?').run(nowIso(), u.id);
  reply.setCookie(COOKIE, token(u), { path: '/', httpOnly: true, sameSite: 'lax', secure: config.isProduction, maxAge: 60 * 60 * 24 * 30 });
  return u;
}
export function refreshCookie(reply, u) {
  reply.setCookie(COOKIE, token(u), { path: '/', httpOnly: true, sameSite: 'lax', secure: config.isProduction, maxAge: 60 * 60 * 24 * 30 });
}
export function logout(reply) {
  reply.clearCookie(COOKIE, { path: '/' });
}

/** Fastify onRequest hook: every /api route except the public ones needs a signed-in user. Viewers may only read. */
export function requireAuth(request, reply, done) {
  if (!request.url.startsWith('/api/')) return done();
  const path = request.url.split('?')[0];
  if (PUBLIC.has(path)) return done();
  if (!authEnabled()) { request.user = { id: 0, username: 'local', role: 'admin' }; return done(); }
  const u = userFromRequest(request);
  if (!u) {
    if (path.startsWith('/api/import') && config.allowAnonImport) return done();
    return reply.code(401).send({ error: 'Authentication required' });
  }
  request.user = u;
  const readOnly = request.method === 'GET' || path === '/api/me/password';
  if (u.role === 'viewer' && !readOnly) return reply.code(403).send({ error: 'Viewers cannot change data. Ask an admin.' });
  done();
}
