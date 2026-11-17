import { h, replace, $ } from '../dom.js';
import { get } from '../api.js';
import { compact, int, pct, signedPct, change } from '../format.js';
import { lineChart, barChart, slotColor, heat, heatInk, destroyAll } from '../charts.js';
import { statTile, insightCards, card, segmentedBar, postsTable, competitorLink, platformBadge, empty, PLATFORM_NAMES } from '../components.js';

export function create(ctx) {
  const el = h('div', { class: 'view' });
  let data = null;
  let topTab = 'interactions';

  const slots = {
    banner: h('div'),
    insights: h('div'),
    kpis: h('div', { class: 'grid kpis' }),
    charts: h('div', { class: 'grid cols-2' }),
    mix: h('div', { class: 'grid cols-3' }),
    leaderboard: h('div'),
    matrix: h('div'),
    top: h('div'),
  };
  el.append(...Object.values(slots));

  const interactionsCanvas = h('canvas', { role: 'img', 'aria-label': 'Interactions over time by competitor' });
  const viewsCanvas = h('canvas', { role: 'img', 'aria-label': 'Video views over time by competitor' });
  const platInteractions = h('canvas', { role: 'img', 'aria-label': 'Interactions by platform' });
  const platViews = h('canvas', { role: 'img', 'aria-label': 'Video views by platform' });
  const sovBox = h('div');
  slots.charts.append(
    card('Interactions over time', 'Likes, comments, shares and saves on posts published in each period', h('div', { class: 'chart-box' }, interactionsCanvas)),
    card('Video views over time', 'Views reported by each platform for video posts (reels, TikToks, YouTube videos, X videos)', h('div', { class: 'chart-box' }, viewsCanvas)),
  );
  slots.mix.append(
    card('Share of voice', 'Share of all interactions in the period', sovBox),
    card('Interactions by platform', null, h('div', { class: 'chart-box short' }, platInteractions)),
    card('Video views by platform', null, h('div', { class: 'chart-box short' }, platViews)),
  );

  async function update() {
    el.classList.add('loading');
    try {
      data = await get(`/api/analysis/overview?${ctx.query()}`);
      renderAll();
    } finally {
      el.classList.remove('loading');
    }
  }

  function renderAll() {
    const d = data;
    const t = d.totals;
    ctx.setTitle('Overview', `${t.competitors} competitors · ${t.accounts} accounts · ${int(t.posts)} posts in the last ${d.filters.days} days`);

    // banner
    const banners = [];
    if (d.hasDemoData) banners.push(h('div', { class: 'banner' }, h('p', null, 'You are looking at demo data. ', h('a', { href: '#/connect' }, 'Connect your platforms'), ' to replace it with live competitor metrics.'), h('button', { class: 'btn sm', onClick: ctx.clearDemo }, 'Remove demo data')));
    if (d.accountIssues.length) banners.push(h('div', { class: 'banner warn' }, h('p', null, `${d.accountIssues.length} account(s) failed to sync. `, h('a', { href: '#/competitors' }, 'See details'))));
    replace(slots.banner, banners.length ? h('div', { style: { display: 'grid', gap: '8px' } }, banners) : null);

    replace(slots.insights, insightCards(d.insights));

    const s = d.series;
    replace(slots.kpis,
      statTile({ label: 'Total interactions', value: t.interactions, prev: t.prev.interactions, series: s.total.interactions, hero: false }),
      statTile({ label: 'Video views', value: t.views, prev: t.prev.views, series: s.total.views, note: t.views === null ? 'No platform with view data' : undefined }),
      statTile({ label: 'Posts published', value: t.posts, prev: t.prev.posts, series: s.total.posts }),
      statTile({ label: 'Followers tracked', value: t.followers, format: compact, note: 'sum of latest snapshots' }),
      statTile({ label: 'Interactions per post', value: t.posts ? t.interactions / t.posts : 0, prev: t.prev.posts ? t.prev.interactions / t.prev.posts : undefined }),
    );

    // time series (fixed colour per competitor, fold past 8)
    const groups = [...s.groups].sort((a, b) => b.interactions.reduce((x, y) => x + y, 0) - a.interactions.reduce((x, y) => x + y, 0));
    const series = (field) => groups.map((g) => ({ name: g.name, data: g[field], color: slotColor(g.slot) }));
    if (groups.length) {
      lineChart(interactionsCanvas, { keys: s.keys, bucket: s.bucket, series: series('interactions') });
      lineChart(viewsCanvas, { keys: s.keys, bucket: s.bucket, series: series('views').filter((x) => x.data.some((v) => v > 0)) });
    }

    replace(sovBox, segmentedBar(d.competitors.map((c) => ({ name: c.name, value: c.interactions, color: slotColor(c.slot) }))));
    const plats = d.platforms;
    barChart(platInteractions, { labels: plats.map((p) => p.name), data: plats.map((p) => p.interactions), horizontal: true, label: 'Interactions' });
    const withViews = plats.filter((p) => p.capabilities.views);
    barChart(platViews, { labels: withViews.map((p) => p.name), data: withViews.map((p) => p.views || 0), horizontal: true, label: 'Views' });

    replace(slots.leaderboard, card('Leaderboard', 'Period totals per competitor. Engagement rate = interactions per post ÷ followers.', leaderboard(d)));
    replace(slots.matrix, card('Where each competitor wins', 'Interactions by competitor and platform; darker means more.', matrix(d)));
    replace(slots.top, card('Top posts', null, topPosts(d), { actions: tabs() }));
  }

  function leaderboard(d) {
    if (!d.competitors.length) return empty('Add competitors on the Connect page to start.');
    const maxSov = Math.max(...d.competitors.map((c) => c.shareOfVoice), 1);
    return h('div', { class: 'table-wrap' }, h('table', null,
      h('thead', null, h('tr', null, h('th', null, 'Competitor'), h('th', null, 'Platforms'), h('th', { class: 'num' }, 'Followers'), h('th', { class: 'num' }, 'Growth'), h('th', { class: 'num' }, 'Posts'), h('th', { class: 'num' }, 'Views'), h('th', { class: 'num' }, 'Interactions'), h('th', { class: 'num' }, 'Δ vs prev'), h('th', { class: 'num' }, 'Per post'), h('th', { class: 'num' }, 'Eng. rate'), h('th', null, 'Share of voice'))),
      h('tbody', null, d.competitors.map((c) => {
        const delta = change(c.interactions, c.prevInteractions);
        return h('tr', null,
          h('td', null, competitorLink(c), c.isSelf ? h('span', { class: 'badge info', style: { marginLeft: '8px' } }, 'you') : null),
          h('td', null, h('div', { style: { display: 'flex', gap: '4px' } }, c.platforms.map((p) => platformBadge(p, { label: false })))),
          h('td', { class: 'num' }, compact(c.followers)),
          h('td', { class: 'num' }, c.followerGrowth === null ? h('span', { class: 'muted' }, '—') : h('span', { class: `delta ${c.followerGrowth >= 0 ? 'up' : 'down'}` }, (c.followerGrowth >= 0 ? '+' : '') + compact(c.followerGrowth))),
          h('td', { class: 'num' }, int(c.posts)),
          h('td', { class: 'num', title: c.postsWithViews ? `${c.postsWithViews} posts with view data` : '' }, c.views === null ? h('span', { class: 'muted' }, 'n/a') : compact(c.views)),
          h('td', { class: 'num' }, h('strong', null, compact(c.interactions))),
          h('td', { class: 'num' }, delta === null ? h('span', { class: 'muted' }, '—') : h('span', { class: `delta ${delta >= 0 ? 'up' : 'down'}` }, signedPct(delta))),
          h('td', { class: 'num' }, compact(c.avgInteractions)),
          h('td', { class: 'num' }, c.engagementRate === null ? h('span', { class: 'muted' }, '—') : pct(c.engagementRate, 2)),
          h('td', null, h('div', { class: 'meter-cell' }, h('div', { class: 'meter' }, h('i', { style: { width: `${(c.shareOfVoice / maxSov) * 100}%`, background: slotColor(c.slot) } })), h('span', { class: 'num small' }, pct(c.shareOfVoice, 0)))),
        );
      })),
    ));
  }

  function matrix(d) {
    const platforms = d.platforms.map((p) => p.platform);
    if (!platforms.length || !d.competitors.length) return empty('No data yet');
    const lookup = new Map(d.matrix.map((m) => [`${m.competitorId}:${m.platform}`, m]));
    const max = Math.max(...d.matrix.map((m) => m.interactions), 1);
    return h('div', { class: 'table-wrap' }, h('table', { class: 'heat' },
      h('thead', null, h('tr', null, h('th', null, 'Competitor'), platforms.map((p) => h('th', { class: 'num' }, PLATFORM_NAMES[p])), h('th', { class: 'num' }, 'Total'))),
      h('tbody', null, d.competitors.map((c) => h('tr', null,
        h('td', null, competitorLink(c)),
        platforms.map((p) => {
          const m = lookup.get(`${c.id}:${p}`);
          const v = m?.interactions || 0;
          return h('td', null, h('span', { class: 'cell', style: { background: heat(v, max), color: heatInk(v, max) }, title: m ? `${c.name} on ${PLATFORM_NAMES[p]}: ${int(v)} interactions, ${m.views === null ? 'views n/a' : int(m.views) + ' views'}, ${m.posts} posts` : 'Not tracked' }, m ? compact(v) : h('span', { class: 'muted' }, '·')));
        }),
        h('td', { class: 'num' }, h('strong', null, compact(c.interactions))),
      ))),
    ));
  }

  function tabs() {
    const mk = (key, label) => h('button', { class: topTab === key ? 'on' : '', onClick: () => { topTab = key; replace(slots.top, card('Top posts', null, topPosts(data), { actions: tabs() })); } }, label);
    return h('div', { class: 'tabs' }, mk('interactions', 'By interactions'), mk('views', 'By views'));
  }
  const topPosts = (d) => postsTable(topTab === 'views' ? d.topViewed.filter((p) => p.views !== null) : d.topPosts);

  return { el, update, destroy: () => destroyAll(el) };
}
