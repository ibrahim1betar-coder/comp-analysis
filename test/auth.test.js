import './env-auth.js';
import './helpers.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from '../server/index.js';

const app = await build();
after(() => app.close());
const json = (res) => JSON.parse(res.body);
const cookieOf = (res) => res.headers['set-cookie'].split(';')[0];

test('API requires a login and the first admin can sign in', async () => {
  assert.equal(app.firstAdmin.username, 'admin');
  assert.equal((await app.inject({ method: 'GET', url: '/api/competitors' })).statusCode, 401);
  let res = await app.inject({ method: 'POST', url: '/api/login', payload: { username: 'admin', password: 'nope' } });
  assert.equal(res.statusCode, 401);
  res = await app.inject({ method: 'POST', url: '/api/login', payload: { username: 'ADMIN', password: 'first-admin-pw' } });
  assert.equal(res.statusCode, 200);
  const cookie = cookieOf(res);
  res = await app.inject({ method: 'GET', url: '/api/session', headers: { cookie } });
  assert.equal(json(res).user.role, 'admin');
  assert.equal(json(res).user.mustChange, false);
  assert.equal((await app.inject({ method: 'GET', url: '/api/competitors', headers: { cookie } })).statusCode, 200);
});

test('admins manage users, viewers are read-only, password change logs sessions out', async () => {
  const admin = cookieOf(await app.inject({ method: 'POST', url: '/api/login', payload: { username: 'admin', password: 'first-admin-pw' } }));
  let res = await app.inject({ method: 'POST', url: '/api/users', payload: { username: 'ana', password: 'short' }, headers: { cookie: admin } });
  assert.equal(res.statusCode, 400);
  res = await app.inject({ method: 'POST', url: '/api/users', payload: { username: 'ana', password: 'viewer-pass-1', role: 'viewer' }, headers: { cookie: admin } });
  assert.equal(res.statusCode, 200);
  const viewer = cookieOf(await app.inject({ method: 'POST', url: '/api/login', payload: { username: 'ana', password: 'viewer-pass-1' } }));
  assert.equal((await app.inject({ method: 'GET', url: '/api/analysis/overview', headers: { cookie: viewer } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/api/competitors', payload: { name: 'X' }, headers: { cookie: viewer } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'GET', url: '/api/users', headers: { cookie: viewer } })).statusCode, 403);
  res = await app.inject({ method: 'PUT', url: '/api/me/password', payload: { currentPassword: 'wrong', password: 'viewer-pass-2' }, headers: { cookie: viewer } });
  assert.equal(res.statusCode, 401);
  res = await app.inject({ method: 'PUT', url: '/api/me/password', payload: { currentPassword: 'viewer-pass-1', password: 'viewer-pass-2' }, headers: { cookie: viewer } });
  assert.equal(res.statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/api/competitors', headers: { cookie: viewer } })).statusCode, 401); // old cookie is dead
  assert.equal((await app.inject({ method: 'POST', url: '/api/login', payload: { username: 'ana', password: 'viewer-pass-2' } })).statusCode, 200);
  const me = json(await app.inject({ method: 'GET', url: '/api/session', headers: { cookie: admin } })).user;
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/users/${me.id}`, headers: { cookie: admin } })).statusCode, 400); // cannot delete self / last admin
  const users = json(await app.inject({ method: 'GET', url: '/api/users', headers: { cookie: admin } }));
  const ana = users.find((u) => u.username === 'ana');
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/users/${ana.id}`, headers: { cookie: admin } })).statusCode, 200);
});
