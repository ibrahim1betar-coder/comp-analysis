import { config } from './config.js';
import { sign, safeEqual } from './crypto.js';

const COOKIE = 'cp_session';
const PUBLIC = new Set(['/api/health', '/api/session', '/api/login', '/api/logout']);

export const authEnabled = () => Boolean(config.password);
const token = () => sign(`session:${config.password}`);

export function isAuthenticated(request) {
  if (!authEnabled()) return true;
  const c = request.cookies?.[COOKIE];
  return Boolean(c) && safeEqual(c, token());
}

export function login(reply, password) {
  if (!authEnabled() || !safeEqual(password || '', config.password)) return false;
  reply.setCookie(COOKIE, token(), { path: '/', httpOnly: true, sameSite: 'lax', secure: config.isProduction, maxAge: 60 * 60 * 24 * 30 });
  return true;
}

export function logout(reply) {
  reply.clearCookie(COOKIE, { path: '/' });
}

/** Fastify onRequest hook: every /api route except the public ones needs a session when a password is set. */
export function requireAuth(request, reply, done) {
  if (!request.url.startsWith('/api/') || PUBLIC.has(request.url.split('?')[0]) || isAuthenticated(request)) return done();
  if (request.url.startsWith('/api/import') && config.allowAnonImport) return done();
  reply.code(401).send({ error: 'Authentication required' });
}
