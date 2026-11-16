import { h, replace, icon, $ } from './dom.js';
import { get, post } from './api.js';
import { relTime } from './format.js';
import { destroyAll } from './charts.js';
import { PLATFORM_NAMES } from './components.js';
import * as overview from './views/overview.js';
import * as competitors from './views/competitors.js';
import * as posts from './views/posts.js';
import * as connect from './views/connect.js';

/* ---------- theme ---------- */
const THEME_KEY = 'cp-theme';
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem(THEME_KEY, t); } catch {}
  const btn = $('#theme-toggle');
  if (btn) replace(btn, icon(t === 'dark' ? 'sun' : 'moon'), h('span', { class: 'meta-text' }, t === 'dark' ? 'Light mode' : 'Dark mode'));
}
(() => {
  let t = null;
  try { t = localStorage.getItem(THEME_KEY); } catch {}
  applyTheme(t || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
})();

/* ---------- state & routing ---------- */
const state = {
  route: 'overview',
  param: null,
  filters: { range: '30d', from: '', to: '', platforms: [], competitors: [] },
  meta: null,
  user: null,
  competitorList: [],
};

function parseHash() {
  const hash = location.hash.replace(/^#\/?/, '') || 'overview';
  const [path, qs = ''] = hash.split('?');
  const [route, param] = path.split('/');
  const q = new URLSearchParams(qs);
  state.route = ['overview', 'competitors', 'posts', 'connect'].includes(route) ? route : 'overview';
  state.param = param || null;
  state.filters = {
    range: q.get('range') || (q.get('from') ? 'custom' : '30d'),
    from: q.get('from') || '',
    to: q.get('to') || '',
    platforms: (q.get('platforms') || '').split(',').filter(Boolean),
    competitors: (q.get('competitors') || '').split(',').filter(Boolean),
  };
}
function filterQuery() {
  const f = state.filters;
  const q = new URLSearchParams();
  if (f.range === 'custom') { if (f.from) q.set('from', f.from); if (f.to) q.set('to', f.to); } else q.set('range', f.range);
  if (f.platforms.length) q.set('platforms', f.platforms.join(','));
  if (f.competitors.length) q.set('competitors', f.competitors.join(','));
  return q.toString();
}
function navigate(route, param, { keepFilters = true } = {}) {
  const qs = keepFilters ? filterQuery() : '';
  location.hash = `#/${route}${param ? `/${param}` : ''}${qs ? `?${qs}` : ''}`;
}
function setFilters(patch) {
  Object.assign(state.filters, patch);
  const qs = filterQuery();
  const path = location.hash.replace(/^#\/?/, '').split('?')[0] || 'overview';
  history.replaceState(null, '', `#/${path}${qs ? `?${qs}` : ''}`);
  currentView?.update().catch(showError);
  renderFilters();
}

/* ---------- toasts ---------- */
const toasts = h('div', { class: 'toasts' });
document.body.append(toasts);
function toast(message, kind = 'ok') {
  const t = h('div', { class: `toast ${kind}` }, message);
  toasts.append(t);
  setTimeout(() => t.remove(), kind === 'bad' ? 7000 : 3500);
}
const showError = (err) => { console.error(err); if (err?.status !== 401) toast(err.message || String(err), 'bad'); };

/* ---------- sync status ---------- */
let syncTimer = null;
let wasRunning = false;
async function pollSync() {
  clearTimeout(syncTimer);
  try {
    const s = await get('/api/sync/status');
    const btn = $('#sync-btn');
    const text = $('#sync-text');
    if (s.running) {
      btn.disabled = true;
      btn.querySelector('.icon').classList.add('spin');
      text.textContent = `Collecting ${s.done}/${s.total}…`;
      wasRunning = true;
      syncTimer = setTimeout(pollSync, 1500);
    } else {
      btn.disabled = false;
      btn.querySelector('.icon').classList.remove('spin');
      text.textContent = s.finishedAt ? `Last sync ${relTime(s.finishedAt)}` : (s.scheduler === 'disabled' ? 'Scheduler off' : `Auto-sync ${s.scheduler}`);
      if (wasRunning) {
        wasRunning = false;
        const r = s.lastResult;
        if (r) toast(`Sync finished: ${r.ok} ok, ${r.failed} failed, ${r.posts} posts${r.errors?.[0] ? ` · ${r.errors[0].account}: ${r.errors[0].error}` : ''}`, r.failed ? 'bad' : 'ok');
        await refreshMeta();
        currentView?.update().catch(showError);
      }
      syncTimer = setTimeout(pollSync, 30000);
    }
  } catch (err) { if (err.status !== 401) syncTimer = setTimeout(pollSync, 10000); }
}
async function startSync({ full = false, accountIds } = {}) {
  try {
    if (accountIds?.length) { await Promise.all(accountIds.map((id) => post(`/api/accounts/${id}/sync`))); currentView?.update().catch(showError); return; }
    const configured = state.meta?.providers.filter((p) => p.configured) || [];
    if (!configured.length) { toast('Connect at least one platform first (Connect page).', 'bad'); navigate('connect'); return; }
    await post('/api/sync', { full });
    toast(full ? 'Full re-sync started' : 'Sync started');
    pollSync();
  } catch (err) { showError(err); }
}

async function refreshMeta() {
  [state.meta, state.competitorList] = await Promise.all([get('/api/meta'), get('/api/competitors')]);
  renderFilters();
}
async function clearDemo() {
  if (!confirm('Remove all demo competitors and their data?')) return;
  await post('/api/maintenance/clear-demo');
  toast('Demo data removed');
  await refreshMeta();
  currentView?.update().catch(showError);
}

/* ---------- filter row ---------- */
const filtersEl = $('#filters');
function renderFilters() {
  if (state.route === 'connect') { filtersEl.hidden = true; return; }
  filtersEl.hidden = false;
  const f = state.filters;
  const range = h('select', { class: 'select', 'aria-label': 'Date range', onChange: (e) => setFilters({ range: e.target.value }) },
    [['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['90d', 'Last 90 days'], ['180d', 'Last 6 months'], ['365d', 'Last 12 months'], ['all', 'All time'], ['custom', 'Custom range…']].map(([v, l]) => h('option', { value: v, selected: f.range === v ? true : null }, l)));
  const custom = f.range === 'custom' ? h('span', { class: 'actions' },
    h('input', { class: 'input', type: 'date', value: f.from, 'aria-label': 'From', onChange: (e) => setFilters({ from: e.target.value }) }),
    h('span', { class: 'muted' }, 'to'),
    h('input', { class: 'input', type: 'date', value: f.to, 'aria-label': 'To', onChange: (e) => setFilters({ to: e.target.value }) }),
  ) : null;
  const platformChips = h('div', { class: 'chipset', role: 'group', 'aria-label': 'Platforms' }, (state.meta?.providers || []).map((p) => {
    const on = f.platforms.includes(p.id);
    return h('button', { class: `chip ${on ? 'on' : ''}`, 'aria-pressed': String(on), onClick: () => setFilters({ platforms: on ? f.platforms.filter((x) => x !== p.id) : [...f.platforms, p.id] }) }, icon(p.id), PLATFORM_NAMES[p.id] || p.name);
  }));
  const compSel = state.competitorList.length > 1 && state.route !== 'competitors' || (state.route === 'competitors' && !state.param) ? h('select', { class: 'select', 'aria-label': 'Competitors', onChange: (e) => setFilters({ competitors: e.target.value ? [e.target.value] : [] }) },
    h('option', { value: '' }, 'All competitors'),
    state.competitorList.map((c) => h('option', { value: String(c.id), selected: f.competitors.length === 1 && f.competitors[0] === String(c.id) ? true : null }, c.name))) : null;
  replace(filtersEl, range, custom, platformChips, state.route === 'competitors' && state.param ? null : compSel, h('span', { class: 'spacer' }),
    f.platforms.length || f.competitors.length || f.range !== '30d' ? h('button', { class: 'btn ghost sm', onClick: () => setFilters({ range: '30d', from: '', to: '', platforms: [], competitors: [] }) }, 'Reset filters') : null);
}

/* ---------- views ---------- */
const ctx = {
  query: filterQuery,
  get filters() { return state.filters; },
  get meta() { return state.meta; },
  get user() { return state.user; },
  get isAdmin() { return !state.user || state.user.role === 'admin'; },
  navigate, toast, startSync, pollSync, refreshMeta, clearDemo,
  setTitle(title, sub) { $('#page-title').textContent = title; $('#page-sub').textContent = sub || ''; document.title = `${title} · Competitor Pulse`; },
};
let currentView = null;
let currentKey = null;
const content = $('#content');

async function route() {
  parseHash();
  const key = `${state.route}/${state.param || ''}`;
  for (const a of document.querySelectorAll('.nav a')) a.classList.toggle('active', a.dataset.route === state.route);
  renderFilters();
  if (key !== currentKey) {
    currentView?.destroy();
    destroyAll();
    currentKey = key;
    currentView = state.route === 'overview' ? overview.create(ctx)
      : state.route === 'competitors' ? (state.param ? competitors.createDetail(ctx, Number(state.param)) : competitors.createList(ctx))
      : state.route === 'posts' ? posts.create(ctx)
      : connect.create(ctx);
    replace(content, currentView.el);
    window.scrollTo(0, 0);
  }
  await currentView.update().catch(showError);
}

/* ---------- auth ---------- */
function showLogin(message) {
  const user = h('input', { class: 'input', type: 'text', placeholder: 'Username', autofocus: true, autocomplete: 'username', autocapitalize: 'off', spellcheck: 'false' });
  const pw = h('input', { class: 'input', type: 'password', placeholder: 'Password', autocomplete: 'current-password' });
  const msg = h('div', { class: 'status-msg bad', hidden: true });
  const form = h('form', { class: 'card', onSubmit: async (e) => {
    e.preventDefault();
    try { await post('/api/login', { username: user.value.trim(), password: pw.value }); location.reload(); }
    catch (err) { msg.hidden = false; msg.textContent = err.message; }
  } },
    h('div', { class: 'brand', style: { padding: 0 } }, h('div', { class: 'brand-mark' }, 'CP'), h('div', null, h('div', { class: 'brand-name' }, 'Competitor Pulse'), h('div', { class: 'brand-sub' }, 'Sign in to continue'))),
    message ? h('p', { class: 'small secondary' }, message) : null,
    h('label', { class: 'field' }, 'Username', user),
    h('label', { class: 'field' }, 'Password', pw),
    msg,
    h('button', { class: 'btn primary', type: 'submit' }, icon('lock'), 'Sign in'),
  );
  document.body.replaceChildren(h('div', { class: 'login' }, form));
}
window.addEventListener('auth:required', () => showLogin('Your session expired.'));

/* ---------- boot ---------- */
async function boot() {
  const session = await get('/api/session');
  if (session.authRequired && !session.authenticated) return showLogin();
  $('#theme-toggle').addEventListener('click', () => { applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'); currentView?.update().catch(showError); });
  $('#sync-btn').addEventListener('click', () => startSync());
  state.user = session.user;
  if (session.authRequired) {
    const lo = $('#logout-btn'); lo.hidden = false;
    lo.textContent = `Sign out (${session.user.username})`;
    lo.addEventListener('click', async () => { await post('/api/logout'); location.reload(); });
    if (session.user.mustChange) {
      $('#page-head-banner').append(h('div', { class: 'banner warn' }, h('p', null, 'You are signed in with the default password. ', h('a', { href: '#/connect?users=1' }, 'Change it now'), ' under Users & access.')));
    }
  }
  await refreshMeta();
  window.addEventListener('hashchange', route);
  await route();
  pollSync();
}
boot().catch((err) => { console.error(err); document.body.append(h('div', { class: 'banner bad', style: { margin: '20px' } }, `Failed to start: ${err.message}`)); });
