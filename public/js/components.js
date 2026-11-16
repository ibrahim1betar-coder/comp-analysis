import { h, icon } from './dom.js';
import { compact, int, pct, signedPct, change, longDate, relTime, title, truncate } from './format.js';
import { slotColor, sparkline } from './charts.js';

export const PLATFORM_NAMES = { youtube: 'YouTube', instagram: 'Instagram', facebook: 'Facebook', tiktok: 'TikTok', x: 'X' };

export function platformBadge(platform, { label = true } = {}) {
  return h('span', { class: 'badge platform', title: PLATFORM_NAMES[platform] || platform }, icon(platform, 'platform-icon'), label ? PLATFORM_NAMES[platform] || platform : null);
}

export function statusBadge(status, error) {
  const map = { ok: ['ok', 'check', 'Synced'], demo: ['info', 'info', 'Demo data'], manual: ['info', 'download', 'Imported'], pending: ['warn', 'info', 'Waiting for sync'], error: ['bad', 'warn', 'Error'] };
  const [cls, ic, text] = map[status] || ['', 'info', status];
  return h('span', { class: `badge ${cls}`, title: error || text }, icon(ic), text);
}

export function competitorLink(c, { slot = c.slot ?? c.color_slot, id = c.id, name = c.name ?? c.competitor } = {}) {
  return h('a', { class: 'entity', href: `#/competitors/${id}` }, h('span', { class: 'dot', style: { background: slotColor(slot) } }), name);
}

/** Stat tile: label, value, delta vs previous period, sparkline. */
export function statTile({ label, value, prev, series, format = compact, hero = false, upIsGood = true, note, color }) {
  const d = prev === undefined ? null : change(value, prev);
  const deltaEl = d === null ? h('span', { class: 'muted' }, note || (prev === undefined ? '' : 'no previous data')) : h('span', { class: `delta ${d >= 0 === upIsGood ? 'up' : 'down'}`, title: `Previous period: ${format(prev)}` }, signedPct(d), h('span', { class: 'muted', style: { fontWeight: 400 } }, ' vs previous'));
  return h('div', { class: `card stat ${hero ? 'hero' : ''}` },
    h('div', { class: 'label' }, label),
    h('div', { class: 'value', title: int(value) }, format(value)),
    h('div', { class: 'meta' }, deltaEl, series && series.length > 1 ? sparkline(series, { color }) : null),
  );
}

export function insightCards(insights) {
  const ic = { good: 'check', warn: 'warn', info: 'info', neutral: 'info' };
  return h('div', { class: 'insights' }, insights.map((i) => h('div', { class: `insight ${i.tone}` }, icon(ic[i.tone] || 'info'), h('div', null, h('strong', null, i.title), h('p', null, i.body)))));
}

export function card(titleText, sub, body, { actions } = {}) {
  return h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('div', null, h('h2', null, titleText), sub ? h('div', { class: 'sub' }, sub) : null), actions || null),
    body,
  );
}

export const empty = (text) => h('div', { class: 'empty' }, text);

/** Tall segmented bar for share of voice (<= 6 parts, rest folded into Other). */
export function segmentedBar(parts) {
  const total = parts.reduce((s, p) => s + p.value, 0);
  if (!total) return empty('No interactions in this period');
  const sorted = [...parts].filter((p) => p.value > 0).sort((a, b) => b.value - a.value);
  const shown = sorted.slice(0, 6);
  const rest = sorted.slice(6);
  if (rest.length) shown.push({ name: `Other (${rest.length})`, value: rest.reduce((s, p) => s + p.value, 0), color: 'var(--axis)' });
  const bar = h('div', { class: 'segbar', role: 'img', 'aria-label': shown.map((p) => `${p.name} ${pct((p.value / total) * 100, 0)}`).join(', ') });
  for (const p of shown) {
    const share = (p.value / total) * 100;
    const seg = h('div', { style: { flex: `${p.value} 1 0`, background: p.color }, title: `${p.name}: ${compact(p.value)} (${pct(share, 1)})` });
    if (share >= 9) seg.append(h('span', null, pct(share, 0)));
    bar.append(seg);
  }
  const legend = h('div', { class: 'legend' }, shown.map((p) => h('span', null, h('i', { class: 'swatch', style: { background: p.color } }), p.name, h('span', { class: 'muted' }, ` · ${compact(p.value)}`))));
  return h('div', null, bar, legend);
}

/** Table of posts with competitor, platform, type, published date, views and interactions. */
export function postsTable(rows, { showCompetitor = true, sort, onSort } = {}) {
  if (!rows.length) return empty('No posts match these filters');
  const th = (key, label, cls = '') => {
    const el = h('th', { class: `${cls} ${onSort ? 'sortable' : ''} ${sort?.key === key ? 'sorted' : ''}`.trim() }, label, sort?.key === key ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : '');
    if (onSort) el.addEventListener('click', () => onSort(key));
    return el;
  };
  return h('div', { class: 'table-wrap' }, h('table', null,
    h('thead', null, h('tr', null,
      h('th', null, 'Post'),
      showCompetitor ? h('th', null, 'Competitor') : null,
      h('th', null, 'Platform'),
      h('th', null, 'Type'),
      th('published_at', 'Published'),
      th('views', 'Views', 'num'),
      th('likes', 'Likes', 'num'),
      th('comments', 'Comments', 'num'),
      th('shares', 'Shares', 'num'),
      th('interactions', 'Interactions', 'num'),
    )),
    h('tbody', null, rows.map((p) => h('tr', null,
      h('td', null, h('div', { class: 'post-cell' },
        p.thumbnail_url ? h('img', { class: 'thumb', src: p.thumbnail_url, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : null,
        h('div', { style: { minWidth: 0 } },
          h('div', { class: 'caption', title: p.caption || '' }, p.url ? h('a', { href: p.url, target: '_blank', rel: 'noopener noreferrer' }, truncate(p.caption || '(no caption)', 80)) : truncate(p.caption || '(no caption)', 80)),
          h('div', { class: 'meta' }, `@${p.handle}`),
        ))),
      showCompetitor ? h('td', null, competitorLink(p)) : null,
      h('td', null, platformBadge(p.platform)),
      h('td', null, title(p.type)),
      h('td', { class: 'nowrap', title: longDate(p.published_at) }, new Date(p.published_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit' })),
      h('td', { class: 'num', title: p.views === null ? 'Not available for this platform' : int(p.views) }, p.views === null ? h('span', { class: 'muted' }, 'n/a') : compact(p.views)),
      h('td', { class: 'num' }, compact(p.likes)),
      h('td', { class: 'num' }, compact(p.comments)),
      h('td', { class: 'num' }, compact(p.shares)),
      h('td', { class: 'num' }, h('strong', null, compact(p.interactions))),
    ))),
  ));
}

export const lastSyncText = (iso) => (iso ? `Last sync ${relTime(iso)}` : 'Not synced yet');
