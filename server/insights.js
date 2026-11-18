/** Rule-based narrative insights computed from the overview payload. No external calls. */
import { providers } from './providers/index.js';

const fmt = (n) => {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
  if (abs >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (abs >= 1e4) return (n / 1e3).toFixed(0) + 'K';
  if (abs >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return Math.round(n).toLocaleString('en-US');
};
const pctChange = (cur, prev) => (prev ? ((cur - prev) / prev) * 100 : null);
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function overviewInsights(o) {
  const out = [];
  const comps = o.competitors.filter((c) => c.posts > 0);
  if (!comps.length) {
    out.push({ tone: 'neutral', title: 'No posts in this period', body: 'Add competitors and run a sync, or widen the date range.' });
    return out;
  }
  const self = comps.find((c) => c.isSelf);
  const leader = comps[0];
  out.push({
    tone: 'info', title: `${leader.name} leads on interactions`,
    body: `${fmt(leader.interactions)} interactions across ${fmt(leader.posts)} posts (${leader.shareOfVoice.toFixed(0)}% share of voice)${self && self !== leader ? `, versus ${fmt(self.interactions)} for ${self.name}` : ''}.`,
  });

  const withViews = comps.filter((c) => c.views);
  if (withViews.length) {
    const vl = [...withViews].sort((a, b) => b.views - a.views)[0];
    out.push({ tone: 'info', title: `${vl.name} wins on video views`, body: `${fmt(vl.views)} views in the period, averaging ${fmt(vl.avgViews)} per video post.` });
  }

  const withRate = comps.filter((c) => c.engagementRate !== null && c.followers > 100);
  if (withRate.length > 1) {
    const er = [...withRate].sort((a, b) => b.engagementRate - a.engagementRate)[0];
    out.push({
      tone: 'good', title: `${er.name} has the most engaged audience`,
      body: `Engagement rate of ${er.engagementRate.toFixed(2)}% per post relative to ${fmt(er.followers)} followers${er !== leader ? `, higher than ${leader.name}'s ${(leader.engagementRate ?? 0).toFixed(2)}% despite fewer total interactions` : ''}.`,
    });
  }

  const movers = comps.filter((c) => c.prevInteractions > 50).map((c) => ({ c, d: pctChange(c.interactions, c.prevInteractions) })).filter((m) => m.d !== null);
  if (movers.length) {
    movers.sort((a, b) => b.d - a.d);
    const up = movers[0];
    const down = movers[movers.length - 1];
    if (up.d > 15) out.push({ tone: 'good', title: `${up.c.name} is accelerating`, body: `Interactions up ${up.d.toFixed(0)}% versus the previous ${o.filters.days} days (${fmt(up.c.prevInteractions)} → ${fmt(up.c.interactions)}).` });
    if (down !== up && down.d < -15) out.push({ tone: 'warn', title: `${down.c.name} is slowing down`, body: `Interactions down ${Math.abs(down.d).toFixed(0)}% versus the previous period (${fmt(down.c.prevInteractions)} → ${fmt(down.c.interactions)}).` });
  }

  const growth = comps.filter((c) => c.followerGrowth !== null && c.followersAtStart).map((c) => ({ c, g: (c.followerGrowth / c.followersAtStart) * 100 })).sort((a, b) => b.g - a.g);
  if (growth.length && growth[0].g > 0.5) out.push({ tone: 'good', title: `${growth[0].c.name} is growing fastest`, body: `+${fmt(growth[0].c.followerGrowth)} followers (${growth[0].g.toFixed(1)}%) since the start of the period.` });

  const cadence = [...comps].sort((a, b) => b.posts - a.posts)[0];
  const perWeek = (cadence.posts / o.filters.days) * 7;
  out.push({ tone: 'neutral', title: `${cadence.name} posts the most`, body: `${fmt(cadence.posts)} posts, about ${perWeek.toFixed(1)} per week, earning ${fmt(cadence.avgInteractions)} interactions per post.` });

  const efficient = [...comps].filter((c) => c.posts >= 3).sort((a, b) => b.avgInteractions - a.avgInteractions)[0];
  if (efficient && efficient !== cadence) out.push({ tone: 'info', title: `${efficient.name} gets the most out of each post`, body: `${fmt(efficient.avgInteractions)} interactions per post, ${(efficient.avgInteractions / (cadence.avgInteractions || 1)).toFixed(1)}× the most frequent poster.` });

  if (o.platforms.length > 1) {
    const p = o.platforms[0];
    out.push({ tone: 'info', title: `${p.name} drives the most interactions`, body: `${p.shareOfVoice.toFixed(0)}% of all interactions come from ${p.name} (${fmt(p.interactions)} across ${fmt(p.posts)} posts).` });
  }

  const noViews = o.platforms.filter((p) => !p.capabilities.views && p.posts);
  if (noViews.length) out.push({ tone: 'neutral', title: 'View counts not available everywhere', body: `${noViews.map((p) => p.name).join(' and ')} do not expose competitors' video play counts through their official APIs, so view totals cover ${o.platforms.filter((p) => p.capabilities.views).map((p) => p.name).join(', ') || 'no platforms'} only. Interactions are complete.` });

  if (o.coverageIssues?.length) out.push({ tone: 'warn', title: `${o.coverageIssues.length} account${o.coverageIssues.length > 1 ? 's' : ''} not fully collected for this period`, body: `${o.coverageIssues.slice(0, 3).map((a) => `${providers[a.platform]?.name || a.platform} @${a.handle.replace(/^@/, '')} (${a.postsTotal} stored${a.profilePostsCount ? ` of ${a.profilePostsCount}` : ''}, back to ${a.oldestPostAt.slice(0, 10)})`).join(' · ')}. Older posts inside the period may be missing: raise POSTS_PER_ACCOUNT and run a full re-sync.` });
  if (o.accountIssues.length) out.push({ tone: 'warn', title: `${o.accountIssues.length} account${o.accountIssues.length > 1 ? 's' : ''} failed to sync`, body: o.accountIssues.slice(0, 3).map((a) => `${providers[a.platform]?.name || a.platform} @${a.handle}: ${a.error}`).join(' · ') });
  return out;
}

export function competitorInsights(d) {
  const out = [];
  const t = d.totals;
  if (!t.posts) return [{ tone: 'neutral', title: 'No posts in this period', body: 'Sync the accounts or widen the date range.' }];
  const ch = pctChange(t.interactions, t.prev.interactions);
  if (ch !== null) out.push({ tone: ch >= 0 ? 'good' : 'warn', title: `Interactions ${ch >= 0 ? 'up' : 'down'} ${Math.abs(ch).toFixed(0)}%`, body: `${fmt(t.prev.interactions)} → ${fmt(t.interactions)} compared with the previous ${d.filters.days} days.` });

  const best = [...d.accounts].filter((a) => a.posts).sort((a, b) => b.interactions - a.interactions)[0];
  if (best) out.push({ tone: 'info', title: `${best.platformName} is the strongest channel`, body: `${fmt(best.interactions)} interactions from ${fmt(best.posts)} posts (${fmt(best.avgInteractions)} per post)${best.views ? `, ${fmt(best.views)} views` : ''}.` });

  const types = d.types.filter((x) => x.posts >= 2);
  if (types.length > 1) {
    const byAvg = [...types].sort((a, b) => b.interactions / b.posts - a.interactions / a.posts)[0];
    out.push({ tone: 'info', title: `${byAvg.type[0].toUpperCase() + byAvg.type.slice(1)} content performs best`, body: `${fmt(byAvg.interactions / byAvg.posts)} interactions per ${byAvg.type} versus ${fmt(t.interactions / t.posts)} overall.` });
  }
  const days = d.weekdays.filter((w) => w.posts >= 2);
  if (days.length > 1) {
    const bestDay = [...days].sort((a, b) => b.interactions / b.posts - a.interactions / a.posts)[0];
    const busiest = [...d.weekdays].sort((a, b) => b.posts - a.posts)[0];
    out.push({ tone: 'neutral', title: `Best day: ${WEEKDAYS[bestDay.grp]}`, body: `Posts published on ${WEEKDAYS[bestDay.grp]} average ${fmt(bestDay.interactions / bestDay.posts)} interactions. Most posts go out on ${WEEKDAYS[busiest.grp]}.` });
  }
  const growing = d.accounts.filter((a) => a.followerGrowth);
  if (growing.length) {
    const g = growing.reduce((s, a) => s + a.followerGrowth, 0);
    out.push({ tone: g >= 0 ? 'good' : 'warn', title: `${g >= 0 ? '+' : ''}${fmt(g)} followers`, body: `Net follower change across ${growing.length} account${growing.length > 1 ? 's' : ''} in the period.` });
  }
  return out;
}

const RANGE_LABEL = { '7d': 'the last 7 days', '30d': 'the last 30 days', '90d': 'the last 90 days', '180d': 'the last 6 months', '365d': 'the last 12 months', all: 'all time' };
export const periodLabel = (f) => RANGE_LABEL[f.range] || `${f.from.slice(0, 10)} to ${new Date(new Date(f.to).getTime() - 86400_000).toISOString().slice(0, 10)}`;

/** One-paragraph written recap of the selected period across all competitors. */
export function periodSummary(o) {
  const t = o.totals;
  const f = o.filters;
  const comps = o.competitors.filter((c) => c.posts > 0);
  if (!t.posts) return `No posts were published by the tracked competitors in ${periodLabel(f)}.`;
  const parts = [];
  parts.push(`In ${periodLabel(f)}, ${comps.length} competitor${comps.length === 1 ? '' : 's'} published ${fmt(t.posts)} posts that earned ${fmt(t.interactions)} interactions (${fmt(t.likes)} likes, ${fmt(t.comments)} comments${t.shares ? `, ${fmt(t.shares)} shares` : ''}${t.saves ? `, ${fmt(t.saves)} saves` : ''})${t.views ? ` and ${fmt(t.views)} video views` : ''}.`);
  const ch = pctChange(t.interactions, t.prev.interactions);
  if (ch !== null) parts.push(`Interactions are ${ch >= 0 ? 'up' : 'down'} ${Math.abs(ch).toFixed(0)}% against the previous ${f.days} days.`);
  if (comps.length > 1) {
    const [a, b] = comps;
    parts.push(`${a.name} leads with ${fmt(a.interactions)} interactions (${a.shareOfVoice.toFixed(0)}% share of voice), ahead of ${b.name} with ${fmt(b.interactions)} (${b.shareOfVoice.toFixed(0)}%).`);
    const self = comps.find((c) => c.isSelf);
    if (self && self !== a) parts.push(`${self.name} ranks #${comps.indexOf(self) + 1} with ${fmt(self.interactions)} interactions (${self.shareOfVoice.toFixed(0)}%).`);
  }
  if (t.followers) parts.push(`Combined audience: ${fmt(t.followers)} followers across ${t.accounts} tracked accounts.`);
  return parts.join(' ');
}
