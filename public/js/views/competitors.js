import { h, replace, icon } from '../dom.js';
import { get, post, put, del } from '../api.js';
import { compact, int, pct, relTime, title, WEEKDAYS } from '../format.js';
import { lineChart, barChart, stackedBarChart, slotColor, destroyAll } from '../charts.js';
import { statTile, insightCards, card, postsTable, platformBadge, statusBadge, empty, PLATFORM_NAMES } from '../components.js';

/* ---------------- list ---------------- */
export function createList(ctx) {
  const el = h('div', { class: 'view' });
  const grid = h('div', { class: 'grid cols-3' });
  const addBox = h('div');
  el.append(addBox, grid);

  async function update() {
    el.classList.add('loading');
    try {
      const [competitors, overview] = await Promise.all([get('/api/competitors'), get(`/api/analysis/overview?${ctx.query()}`)]);
      ctx.setTitle('Competitors', `${competitors.length} tracked · click a competitor for the full breakdown`);
      const metrics = new Map(overview.competitors.map((c) => [c.id, c]));
      replace(addBox, addForm());
      replace(grid, competitors.length ? competitors.map((c) => compCard(c, metrics.get(c.id))) : empty('No competitors yet. Add one above or import a CSV on the Connect page.'));
    } finally {
      el.classList.remove('loading');
    }
  }

  function addForm() {
    const name = h('input', { class: 'input', placeholder: 'Competitor name', required: true, style: { minWidth: '220px' } });
    const platform = h('select', { class: 'select' }, ctx.meta.providers.map((p) => h('option', { value: p.id }, p.name)));
    const handle = h('input', { class: 'input', placeholder: '@handle or profile URL (optional)', style: { minWidth: '260px' } });
    const self = h('input', { type: 'checkbox' });
    const form = h('form', { class: 'card', onSubmit: async (e) => {
      e.preventDefault();
      try {
        const accounts = handle.value.trim() ? [{ platform: platform.value, handle: handle.value.trim() }] : [];
        const res = await post('/api/competitors', { name: name.value.trim(), isSelf: self.checked, accounts });
        if (res.errors?.length) ctx.toast(res.errors.join('; '), 'bad');
        else ctx.toast(`Added ${res.name}`);
        if (accounts.length) ctx.startSync({ accountIds: res.accounts.map((a) => a.id) });
        await update();
      } catch (err) { ctx.toast(err.message, 'bad'); }
    } },
      h('div', { class: 'card-head' }, h('div', null, h('h2', null, 'Add a competitor'), h('div', { class: 'sub' }, 'Give it a name, then attach one account per platform. More accounts can be added on the card.'))),
      h('div', { class: 'actions' }, name, platform, handle, h('label', { class: 'toggle' }, self, 'This is my own brand'), h('button', { class: 'btn primary', type: 'submit' }, icon('plus'), 'Add')),
    );
    return form;
  }

  function compCard(c, m) {
    const accountsEl = h('div', { class: 'accounts' }, c.accounts.length ? c.accounts.map((a) => accountRow(a)) : h('div', { class: 'muted small' }, 'No accounts yet'));
    const addRow = h('div', { class: 'actions' });
    const platform = h('select', { class: 'select', 'aria-label': 'Platform' }, ctx.meta.providers.map((p) => h('option', { value: p.id }, p.name)));
    const handle = h('input', { class: 'input', placeholder: '@handle or URL', style: { flex: 1, minWidth: '120px' }, 'aria-label': 'Handle' });
    addRow.append(platform, handle, h('button', { class: 'btn sm', type: 'button', onClick: async () => {
      if (!handle.value.trim()) return;
      try {
        await post(`/api/competitors/${c.id}/accounts`, { platform: platform.value, handle: handle.value.trim() });
        ctx.toast('Account added. Collecting data…');
        ctx.pollSync();
        await update();
      } catch (err) { ctx.toast(err.message, 'bad'); }
    } }, icon('plus'), 'Account'));

    return h('div', { class: 'card comp-card' },
      h('div', { class: 'head' },
        h('a', { class: 'name', href: `#/competitors/${c.id}` }, h('span', { class: 'dot', style: { background: slotColor(c.slot), width: '12px', height: '12px' } }), c.name, c.isSelf ? h('span', { class: 'badge info' }, 'you') : null),
        h('div', { class: 'actions' },
          h('button', { class: 'btn ghost sm', title: 'Rename', onClick: async () => {
            const n = prompt('Rename competitor', c.name);
            if (n && n.trim() && n !== c.name) { try { await put(`/api/competitors/${c.id}`, { name: n.trim() }); await update(); } catch (err) { ctx.toast(err.message, 'bad'); } }
          } }, 'Rename'),
          h('button', { class: 'btn ghost sm danger', title: 'Delete competitor and all its data', onClick: async () => {
            if (!confirm(`Delete "${c.name}" and all collected posts? This cannot be undone.`)) return;
            try { await del(`/api/competitors/${c.id}`); ctx.toast('Deleted'); await update(); } catch (err) { ctx.toast(err.message, 'bad'); }
          } }, icon('trash')),
        ),
      ),
      h('div', { class: 'stats' },
        h('div', null, h('strong', null, compact(m?.interactions ?? 0)), 'interactions'),
        h('div', null, h('strong', null, m?.views === null || m?.views === undefined ? 'n/a' : compact(m.views)), 'video views'),
        h('div', null, h('strong', null, compact(m?.followers)), 'followers'),
      ),
      accountsEl,
      addRow,
    );
  }

  function accountRow(a) {
    return h('div', { class: 'account-row' },
      platformBadge(a.platform, { label: false }),
      h('span', { class: 'handle', title: a.last_error || '' }, a.profile_url ? h('a', { href: a.profile_url, target: '_blank', rel: 'noopener noreferrer' }, `@${a.handle}`) : `@${a.handle}`),
      statusBadge(a.status, a.last_error),
      h('span', { class: 'muted small nowrap' }, a.last_synced_at ? relTime(a.last_synced_at) : ''),
      a.status !== 'demo' && a.status !== 'manual' ? h('button', { class: 'btn ghost sm', title: 'Sync now', onClick: async (e) => {
        const btn = e.currentTarget; btn.disabled = true;
        try { const r = await post(`/api/accounts/${a.id}/sync`); ctx.toast(r.ok ? `Synced @${a.handle}: ${r.posts} posts` : r.error, r.ok ? 'ok' : 'bad'); await update(); } finally { btn.disabled = false; }
      } }, icon('sync')) : null,
      h('button', { class: 'btn ghost sm danger', title: 'Remove account', onClick: async () => {
        if (!confirm(`Remove @${a.handle} (${PLATFORM_NAMES[a.platform]}) and its posts?`)) return;
        try { await del(`/api/accounts/${a.id}`); await update(); } catch (err) { ctx.toast(err.message, 'bad'); }
      } }, icon('trash')),
    );
  }

  return { el, update, destroy: () => destroyAll(el) };
}

/* ---------------- detail ---------------- */
export function createDetail(ctx, id) {
  const el = h('div', { class: 'view' });
  const head = h('div');
  const insights = h('div');
  const kpis = h('div', { class: 'grid kpis' });
  const charts = h('div', { class: 'grid cols-2' });
  const charts2 = h('div', { class: 'grid cols-3' });
  const accountsBox = h('div');
  const top = h('div');
  el.append(head, insights, kpis, charts, charts2, accountsBox, top);

  const platformSeries = h('canvas', { role: 'img', 'aria-label': 'Interactions by platform over time' });
  const followersCanvas = h('canvas', { role: 'img', 'aria-label': 'Followers over time' });
  const typesCanvas = h('canvas', { role: 'img', 'aria-label': 'Average interactions per post by content type' });
  const weekdayCanvas = h('canvas', { role: 'img', 'aria-label': 'Posts by weekday' });
  const hourCanvas = h('canvas', { role: 'img', 'aria-label': 'Average interactions by posting hour' });
  charts.append(
    card('Interactions by platform over time', 'Stacked by platform', h('div', { class: 'chart-box' }, platformSeries)),
    card('Followers', 'Sum of daily snapshots across tracked accounts', h('div', { class: 'chart-box' }, followersCanvas)),
  );
  charts2.append(
    card('Content type performance', 'Average interactions per post', h('div', { class: 'chart-box short' }, typesCanvas)),
    card('Posting days', 'Posts published per weekday (UTC)', h('div', { class: 'chart-box short' }, weekdayCanvas)),
    card('Best posting hours', 'Average interactions by hour published (UTC)', h('div', { class: 'chart-box short' }, hourCanvas)),
  );
  let topTab = 'interactions';
  let data;

  async function update() {
    el.classList.add('loading');
    try {
      data = await get(`/api/analysis/competitors/${id}?${ctx.query()}`);
      render();
    } catch (err) {
      if (err.status === 404) { ctx.setTitle('Competitor not found', ''); replace(el, empty('This competitor no longer exists.')); return; }
      throw err;
    } finally {
      el.classList.remove('loading');
    }
  }

  function render() {
    const d = data;
    const c = d.competitor;
    const t = d.totals;
    ctx.setTitle(c.name, `${d.accounts.length} accounts · ${int(t.posts)} posts in the last ${d.filters.days} days`);
    replace(head, h('div', { class: 'detail-head' },
      h('a', { class: 'btn ghost sm', href: '#/competitors' }, '← All competitors'),
      h('div', { class: 'account-chips' }, d.accounts.map((a) => h('a', { class: 'chip', href: a.profileUrl || '#', target: a.profileUrl ? '_blank' : null, rel: 'noopener noreferrer' }, icon(a.platform), `@${a.handle}`))),
    ));
    replace(insights, insightCards(d.insights));
    const color = slotColor(c.slot);
    replace(kpis,
      statTile({ label: 'Interactions', value: t.interactions, prev: t.prev.interactions, series: d.series.total.interactions, color }),
      statTile({ label: 'Video views', value: t.views, prev: t.prev.views, series: d.series.total.views, color, note: t.views === null ? 'No platform with view data' : undefined }),
      statTile({ label: 'Posts', value: t.posts, prev: t.prev.posts, series: d.series.total.posts, color }),
      statTile({ label: 'Followers', value: t.followers, format: compact, note: d.followerSeries.length > 1 ? `${d.followerSeries[d.followerSeries.length - 1].followers - d.followerSeries[0].followers >= 0 ? '+' : ''}${compact(d.followerSeries[d.followerSeries.length - 1].followers - d.followerSeries[0].followers)} in period` : 'no snapshots yet' }),
      statTile({ label: 'Engagement rate', value: t.engagementRate, format: (v) => (v === null ? '—' : pct(v, 2)), note: 'interactions per post ÷ followers' }),
    );

    const platformColors = { youtube: slotColor(8), instagram: slotColor(5), tiktok: slotColor(3), x: slotColor(1), facebook: slotColor(7) };
    const s = d.series;
    const groups = s.groups.filter((g) => g.interactions.some((v) => v > 0));
    if (groups.length) stackedBarChart(platformSeries, { keys: s.keys, bucket: s.bucket, series: groups.map((g) => ({ name: g.name, data: g.interactions, color: platformColors[g.key] || slotColor(2) })) });
    if (d.followerSeries.length > 1) lineChart(followersCanvas, { keys: d.followerSeries.map((r) => r.day), bucket: 'day', series: [{ name: 'Followers', data: d.followerSeries.map((r) => r.followers), color, fill: true }], legend: false });
    else { replace(followersCanvas.parentElement, empty('Follower history appears after the first few syncs.')); }

    const types = d.types.filter((x) => x.posts);
    barChart(typesCanvas, { labels: types.map((x) => `${title(x.type)} (${x.posts})`), data: types.map((x) => x.interactions / x.posts), horizontal: true, color, label: 'Avg interactions' });
    barChart(weekdayCanvas, { labels: d.weekdays.map((w) => WEEKDAYS[w.grp]), data: d.weekdays.map((w) => w.posts), color, label: 'Posts' });
    barChart(hourCanvas, { labels: d.hours.map((x) => `${String(x.grp).padStart(2, '0')}h`), data: d.hours.map((x) => (x.posts ? x.interactions / x.posts : 0)), color, label: 'Avg interactions' });

    replace(accountsBox, card('Accounts', 'Per-platform totals for the period and the latest follower snapshot', accountsTable(d)));
    replace(top, card('Top posts', null, postsTable(topTab === 'views' ? d.topViewed.filter((p) => p.views !== null) : d.topPosts, { showCompetitor: false }), { actions: tabs() }));
  }

  function tabs() {
    const mk = (key, label) => h('button', { class: topTab === key ? 'on' : '', onClick: () => { topTab = key; render(); } }, label);
    return h('div', { class: 'tabs' }, mk('interactions', 'By interactions'), mk('views', 'By views'));
  }

  function accountsTable(d) {
    if (!d.accounts.length) return empty('No accounts attached. Add one on the Competitors page.');
    return h('div', { class: 'table-wrap' }, h('table', null,
      h('thead', null, h('tr', null, h('th', null, 'Account'), h('th', null, 'Status'), h('th', { class: 'num' }, 'Followers'), h('th', { class: 'num' }, 'Growth'), h('th', { class: 'num' }, 'Posts'), h('th', { class: 'num' }, 'Views'), h('th', { class: 'num' }, 'Avg views'), h('th', { class: 'num' }, 'Interactions'), h('th', { class: 'num' }, 'Per post'), h('th', { class: 'num' }, 'Eng. rate'), h('th', null, ''))),
      h('tbody', null, d.accounts.map((a) => h('tr', null,
        h('td', null, h('div', { class: 'post-cell' }, a.avatarUrl ? h('img', { class: 'thumb', src: a.avatarUrl, alt: '', style: { width: '32px', height: '32px', borderRadius: '50%' }, referrerpolicy: 'no-referrer' }) : platformBadge(a.platform, { label: false }), h('div', null, h('div', null, a.profileUrl ? h('a', { href: a.profileUrl, target: '_blank', rel: 'noopener noreferrer' }, `@${a.handle}`) : `@${a.handle}`), h('div', { class: 'meta' }, a.platformName)))),
        h('td', null, statusBadge(a.status, a.lastError), a.lastError ? h('div', { class: 'small muted', style: { maxWidth: '240px' } }, a.lastError) : null),
        h('td', { class: 'num' }, compact(a.followers)),
        h('td', { class: 'num' }, a.followerGrowth === null ? '—' : h('span', { class: `delta ${a.followerGrowth >= 0 ? 'up' : 'down'}` }, (a.followerGrowth >= 0 ? '+' : '') + compact(a.followerGrowth))),
        h('td', { class: 'num' }, int(a.posts)),
        h('td', { class: 'num' }, a.capabilities?.views ? compact(a.views || 0) : h('span', { class: 'muted', title: 'This platform does not expose competitors\' view counts' }, 'n/a')),
        h('td', { class: 'num' }, a.avgViews === null ? h('span', { class: 'muted' }, 'n/a') : compact(a.avgViews)),
        h('td', { class: 'num' }, h('strong', null, compact(a.interactions))),
        h('td', { class: 'num' }, compact(a.avgInteractions)),
        h('td', { class: 'num' }, a.engagementRate === null ? '—' : pct(a.engagementRate, 2)),
        h('td', null, a.status !== 'demo' && a.status !== 'manual' ? h('button', { class: 'btn ghost sm', title: 'Sync now', onClick: async (e) => { e.currentTarget.disabled = true; const r = await post(`/api/accounts/${a.id}/sync`); ctx.toast(r.ok ? `Synced: ${r.posts} posts` : r.error, r.ok ? 'ok' : 'bad'); await update(); } }, icon('sync')) : null),
      ))),
    ));
  }

  return { el, update, destroy: () => destroyAll(el) };
}
