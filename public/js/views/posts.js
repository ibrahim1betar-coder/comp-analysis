import { h, replace, icon } from '../dom.js';
import { get } from '../api.js';
import { compact, int } from '../format.js';
import { card, postsTable } from '../components.js';

const TYPES = ['video', 'short', 'reel', 'image', 'carousel', 'text', 'link', 'live', 'post'];

export function create(ctx) {
  const el = h('div', { class: 'view' });
  const state = { sort: 'interactions', dir: 'desc', page: 1, type: '', q: '' };
  const body = h('div');
  const search = h('input', { class: 'input', type: 'search', placeholder: 'Search captions…', style: { minWidth: '220px' } });
  const type = h('select', { class: 'select', 'aria-label': 'Content type' }, h('option', { value: '' }, 'All types'), TYPES.map((t) => h('option', { value: t }, t[0].toUpperCase() + t.slice(1))));
  let timer;
  search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { state.q = search.value.trim(); state.page = 1; update(); }, 250); });
  type.addEventListener('change', () => { state.type = type.value; state.page = 1; update(); });
  const exportBtn = h('a', { class: 'btn', href: '#', download: '' }, icon('download'), 'Export CSV');
  el.append(h('div', { class: 'actions' }, search, type, h('span', { style: { flex: 1 } }), exportBtn), body);

  async function update() {
    el.classList.add('loading');
    try {
      const qs = `${ctx.query()}&sort=${state.sort}&dir=${state.dir}&page=${state.page}&pageSize=50${state.type ? `&type=${state.type}` : ''}${state.q ? `&q=${encodeURIComponent(state.q)}` : ''}`;
      exportBtn.href = `/api/export/posts.csv?${qs}`;
      const d = await get(`/api/analysis/posts?${qs}`);
      ctx.setTitle('Posts', `${int(d.total)} posts match · sorted by ${state.sort.replace('_', ' ')}`);
      const pages = Math.max(1, Math.ceil(d.total / d.pageSize));
      const sm = d.sums;
      const sumsLine = h('div', { class: 'sums' },
        h('span', null, h('strong', null, int(sm.posts)), ' posts'),
        h('span', null, h('strong', { title: int(sm.views) }, sm.views === null ? 'n/a' : compact(sm.views)), ' views'),
        h('span', null, h('strong', { title: int(sm.likes) }, compact(sm.likes)), ' likes'),
        h('span', null, h('strong', { title: int(sm.comments) }, compact(sm.comments)), ' comments'),
        h('span', null, h('strong', { title: int(sm.shares) }, compact(sm.shares)), ' shares'),
        h('span', null, h('strong', { title: int(sm.saves) }, compact(sm.saves)), ' saves'),
        h('span', null, h('strong', { title: int(sm.interactions) }, compact(sm.interactions)), ' interactions'),
        h('span', { class: 'muted' }, `· sum of all ${int(d.total)} matching posts in the selected period`),
      );
      replace(body, card('All posts', 'Click a column to sort. Views show n/a where the platform does not expose competitor view counts.',
        h('div', null,
          sumsLine,
          postsTable(d.rows, { sort: { key: state.sort, dir: state.dir }, onSort: (key) => { if (state.sort === key) state.dir = state.dir === 'desc' ? 'asc' : 'desc'; else { state.sort = key; state.dir = 'desc'; } state.page = 1; update(); } }),
          h('div', { class: 'pager' },
            h('span', null, `Page ${d.page} of ${pages} · ${int(d.total)} posts`),
            h('div', { class: 'actions' },
              h('button', { class: 'btn sm', disabled: d.page <= 1, onClick: () => { state.page--; update(); } }, 'Previous'),
              h('button', { class: 'btn sm', disabled: d.page >= pages, onClick: () => { state.page++; update(); } }, 'Next'),
            ),
          ),
        )));
    } finally {
      el.classList.remove('loading');
    }
  }
  return { el, update, destroy() {} };
}
