// Populates the database with realistic demo data so the dashboard can be explored before any API is connected.
// Usage: npm run seed           (adds demo data if none exists)
//        npm run seed -- --reset (wipes everything first)
import { db, stmt, transaction } from './db.js';
import { storeAccountData } from './collector.js';
import { invalidate } from './analysis.js';

let seed = 42;
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const between = (a, b) => a + rnd() * (b - a);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const DAY = 86400_000;

const COMPETITORS = [
  { name: 'Your brand', isSelf: true, strength: 0.7, accounts: { youtube: 'yourbrand', instagram: 'yourbrand', tiktok: 'yourbrand', x: 'yourbrand', facebook: 'yourbrand' } },
  { name: 'Northwind Studio', strength: 1.4, accounts: { youtube: 'northwindstudio', instagram: 'northwind.studio', tiktok: 'northwindstudio', x: 'northwind' } },
  { name: 'Lumen Labs', strength: 1.0, accounts: { youtube: 'lumenlabs', instagram: 'lumenlabs', tiktok: 'lumen.labs', x: 'lumenlabs', facebook: 'lumenlabs' } },
  { name: 'Peak & Pine', strength: 0.55, accounts: { instagram: 'peakandpine', tiktok: 'peakandpine', facebook: 'peakandpine' } },
];

const PLATFORM = {
  youtube: { followers: 180_000, perWeek: 2.5, views: [8_000, 120_000], likeRate: 0.035, commentRate: 0.004, types: ['video', 'video', 'short'], hasViews: true, shares: false },
  instagram: { followers: 240_000, perWeek: 5, views: null, likeRate: 0.02, commentRate: 0.0012, types: ['reel', 'image', 'carousel', 'reel'], hasViews: false, shares: false },
  tiktok: { followers: 420_000, perWeek: 6, views: [15_000, 900_000], likeRate: 0.06, commentRate: 0.0015, types: ['video'], hasViews: true, shares: true },
  x: { followers: 95_000, perWeek: 12, views: [3_000, 80_000], likeRate: 0.012, commentRate: 0.002, types: ['text', 'text', 'image', 'video'], hasViews: true, shares: true },
  facebook: { followers: 310_000, perWeek: 4, views: null, likeRate: 0.006, commentRate: 0.0008, types: ['video', 'image', 'link', 'text'], hasViews: false, shares: true },
};

const CAPTIONS = ['Behind the scenes of our latest launch', 'Three tips you did not know about', 'Customer story: how Maya doubled her results', 'We asked 100 people this one question', 'New collection drops Friday', 'A day in the life of our design team', 'Live Q&A recap', 'The mistake everyone makes with onboarding', 'Our favourite moments from this month', 'Tutorial: from zero to done in 10 minutes', 'Why we changed our pricing', 'Unboxing the limited edition'];

function run({ reset }) {
  if (reset) transaction(() => { for (const t of ['sync_runs', 'posts', 'snapshots', 'accounts', 'competitors']) db.exec(`DELETE FROM ${t}`); });
  if (db.prepare(`SELECT 1 FROM accounts WHERE status = 'demo' LIMIT 1`).get()) { console.log('Demo data already present. Use --reset to recreate.'); return; }

  const now = Date.now();
  const days = 120;
  let totalPosts = 0;
  COMPETITORS.forEach((c, i) => {
    const compId = Number(stmt('INSERT INTO competitors (name, color_slot, is_self) VALUES (?, ?, ?)').run(c.name, i + 1, c.isSelf ? 1 : 0).lastInsertRowid);
    for (const [platform, handle] of Object.entries(c.accounts)) {
      const spec = PLATFORM[platform];
      const accId = Number(stmt('INSERT INTO accounts (competitor_id, platform, handle, display_name, profile_url, status, last_synced_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(compId, platform, handle, c.name, `https://${platform === 'x' ? 'x.com' : platform + '.com'}/${handle}`, 'demo', new Date().toISOString()).lastInsertRowid);

      // Follower snapshots: one per day, slow growth with a bump for strong brands.
      const baseFollowers = spec.followers * c.strength * between(0.8, 1.2);
      const growth = between(0.0003, 0.0025) * (c.strength > 1 ? 1.6 : 1);
      const posts = [];
      let followers = baseFollowers;
      const snapshots = [];
      for (let d = days; d >= 0; d--) {
        followers *= 1 + growth * between(0.5, 1.5);
        snapshots.push({ capturedOn: new Date(now - d * DAY).toISOString().slice(0, 10), followers: Math.round(followers) });
      }
      // Posts: Poisson-ish cadence, weekday skew, occasional viral hit, slight upward trend for strong brands.
      const perDay = (spec.perWeek * between(0.7, 1.3)) / 7;
      for (let d = days; d >= 0; d--) {
        const date = new Date(now - d * DAY);
        const weekday = date.getUTCDay();
        const dayFactor = weekday === 0 || weekday === 6 ? 0.55 : weekday === 2 || weekday === 4 ? 1.3 : 1;
        let n = 0;
        let p = rnd();
        while (p < perDay * dayFactor && n < 4) { n++; p += rnd(); }
        for (let k = 0; k < n; k++) {
          const type = pick(spec.types);
          const momentum = c.strength > 1 ? 1 + (days - d) / days * 0.5 : c.strength < 0.6 ? 1.15 - (days - d) / days * 0.35 : 1;
          const viral = rnd() < 0.05 ? between(4, 12) : 1;
          const typeBoost = type === 'reel' || type === 'short' || type === 'video' ? between(1.1, 1.6) : 1;
          const reach = followers * between(0.05, 0.35) * momentum * viral * typeBoost;
          const hour = Math.floor(between(8, 21));
          const publishedAt = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hour, Math.floor(between(0, 59))));
          const views = spec.hasViews && (type !== 'text' && type !== 'image' && type !== 'link' || platform === 'x') ? Math.round(reach * (platform === 'x' && type !== 'video' ? 0.6 : 1)) : null;
          const likes = Math.round(reach * spec.likeRate * between(0.6, 1.5));
          posts.push({
            externalId: `demo-${accId}-${d}-${k}`, publishedAt: publishedAt.toISOString(), type,
            url: `https://example.com/${platform}/${handle}/${d}-${k}`, caption: pick(CAPTIONS), thumbnailUrl: null,
            views, likes,
            comments: Math.round(reach * spec.commentRate * between(0.5, 1.6)),
            shares: spec.shares ? Math.round(likes * between(0.04, 0.15)) : 0,
            saves: platform === 'x' ? Math.round(likes * between(0.02, 0.08)) : 0,
          });
        }
      }
      storeAccountData(accId, platform, { profile: null, posts }, { markSynced: false });
      const ins = stmt('INSERT INTO snapshots (account_id, captured_on, followers) VALUES (?, ?, ?) ON CONFLICT(account_id, captured_on) DO UPDATE SET followers = excluded.followers');
      transaction(() => { for (const s of snapshots) ins.run(accId, s.capturedOn, s.followers); });
      totalPosts += posts.length;
    }
  });
  invalidate();
  console.log(`Seeded ${COMPETITORS.length} competitors and ${totalPosts} demo posts over ${days} days.`);
}

run({ reset: process.argv.includes('--reset') });
