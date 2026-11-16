import { h, replace, icon } from '../dom.js';
import { get, post, put, del, api } from '../api.js';
import { int, relTime, longDate } from '../format.js';
import { card, platformBadge, empty, PLATFORM_NAMES } from '../components.js';

const GUIDES = {
  youtube: {
    summary: 'Public data, free, 5 minutes. Views, likes and comments for any channel.',
    steps: [
      ['Create a Google Cloud project', 'Open console.cloud.google.com, create (or pick) a project.'],
      ['Enable the YouTube Data API v3', 'APIs & Services → Library → search "YouTube Data API v3" → Enable.'],
      ['Create an API key', 'APIs & Services → Credentials → Create credentials → API key. Restrict it to the YouTube Data API.'],
      ['Paste the key here and save', 'The dashboard tests the key immediately.'],
      ['Add competitor channels', 'Use the @handle (youtube.com/@handle), the channel URL, or the UC… channel ID.'],
    ],
    note: 'Quota is 10,000 units per day. Collecting 300 videos for one channel costs about 15 units, so you can track hundreds of channels on the free quota.',
    data: 'Subscribers, video views, likes, comments, Shorts vs long-form detection.',
  },
  instagram: {
    summary: 'Needs a Meta developer app and your own Instagram professional account. Interactions for any business/creator account.',
    steps: [
      ['Switch your own Instagram account to Professional', 'Business or Creator, linked to a Facebook Page (Instagram → Settings → Account type and tools).'],
      ['Create a Meta app', 'developers.facebook.com → My Apps → Create app → Business type. Add the "Instagram Graph API" product.'],
      ['Generate a token', 'Tools → Graph API Explorer → select your app → add permissions instagram_basic, instagram_manage_insights, pages_show_list, pages_read_engagement, business_management → Generate token.'],
      ['Make the token long-lived', 'Exchange it: GET /oauth/access_token?grant_type=fb_exchange_token&client_id=APP_ID&client_secret=APP_SECRET&fb_exchange_token=SHORT_TOKEN (valid 60 days). Use the Access Token Debugger to confirm.'],
      ['Find your Instagram account ID', 'GET /me/accounts → take the Page id → GET /{page-id}?fields=instagram_business_account → copy the id.'],
      ['Paste token and ID here, then add competitors by @username', 'Only business or creator accounts can be read through Business Discovery.'],
    ],
    note: 'Meta does not expose play counts for accounts you do not own. Likes and comments are complete; reels are marked so you can still compare video content. Add view counts via CSV import if you collect them elsewhere.',
    data: 'Followers, posts, likes, comments, media type (reel / image / carousel).',
  },
  facebook: {
    summary: 'Needs a Meta app with "Page Public Content Access" (app review) to read Pages you do not manage.',
    steps: [
      ['Create or reuse a Meta app', 'developers.facebook.com → My Apps → Create app → Business.'],
      ['Request Page Public Content Access', 'App Dashboard → App Review → Permissions and Features → request "Page Public Content Access" and "Page Public Metadata Access". Describe your competitive benchmarking use case.'],
      ['Generate a long-lived token', 'Graph API Explorer → permissions pages_read_engagement, pages_show_list → Generate → exchange for a long-lived token (same call as Instagram, step 4).'],
      ['Paste the token here', 'Until app review is approved, only Pages you manage can be read.'],
      ['Add competitor Pages', 'Use the Page username (facebook.com/username), numeric ID, or URL.'],
    ],
    note: 'Video views are only available for Pages you own. Reactions, comments and shares are collected for every public Page.',
    data: 'Followers, posts, reactions, comments, shares, attachment type.',
  },
  tiktok: {
    summary: 'Official TikTok Research API (approval required). Views, likes, comments and shares for any public account.',
    steps: [
      ['Apply for the Research API', 'developers.tiktok.com → Research API → apply. Available to academic and non-profit researchers in the US and EU; approval takes a few weeks.'],
      ['Create an app with Research API access', 'In the developer portal, add the "Research API" product to your app.'],
      ['Copy the client key and client secret', 'App details → Credentials.'],
      ['Paste both here', 'The dashboard requests a client-credentials token and refreshes it automatically.'],
      ['Add competitor @usernames', 'Posts are queried in 30-day windows back to the look-back period.'],
    ],
    note: 'If you do not qualify for the Research API, export metrics from a listening tool (or TikTok Creator Center for your own account) and use the CSV import below. Imported posts show up in every chart exactly like API data.',
    data: 'Followers, total likes, video views, likes, comments, shares.',
  },
  x: {
    summary: 'X API v2 with an app bearer token. Reading other users\' posts requires the Basic tier (paid) or higher.',
    steps: [
      ['Create a developer account and project', 'developer.x.com → Developer Portal → create a project and an app.'],
      ['Choose the Basic tier or higher', 'The Free tier cannot read other accounts\' posts.'],
      ['Generate a bearer token', 'App → Keys and tokens → Bearer Token.'],
      ['Paste it here', 'The dashboard verifies it with a single user lookup.'],
      ['Add competitor @usernames', 'Retweets and replies are excluded; original posts and quotes are counted.'],
    ],
    note: 'Views = video view count when a post contains video, otherwise the post\'s impressions. Shares = reposts + quotes, saves = bookmarks.',
    data: 'Followers, posts, impressions, video views, likes, replies, reposts, quotes, bookmarks.',
  },
};

export function create(ctx) {
  const el = h('div', { class: 'view' });
  const platformsBox = h('div', { style: { display: 'grid', gap: '12px' } });
  const syncBox = h('div');
  const importBox = h('div');
  const runsBox = h('div');

  el.append(
    card('How it works', 'Four steps from zero to a live competitor dashboard', h('div', { class: 'steps' },
      h('div', { class: 'step' }, h('div', null, h('strong', null, 'Connect platforms'), h('p', null, 'Add API credentials below for each network you want to track. Each one is tested on save and stored encrypted.'))),
      h('div', { class: 'step' }, h('div', null, h('strong', null, 'Add competitors'), h('p', null, 'Create a competitor and attach its @handles. Mark one as your own brand to benchmark against.'))),
      h('div', { class: 'step' }, h('div', null, h('strong', null, 'Collect'), h('p', null, `Posts, views, interactions and follower counts are pulled into the local database. The scheduler re-collects every ${ctx.meta.sync.intervalMinutes} minutes.`))),
      h('div', { class: 'step' }, h('div', null, h('strong', null, 'Analyse'), h('p', null, 'The Overview, Competitors and Posts pages compute share of voice, engagement rates, growth, content-type and timing analysis from the stored data, instantly.'))),
    )),
    h('div', null, h('h2', { style: { marginBottom: '10px' } }, 'Platform connections'), platformsBox),
    syncBox,
    importBox,
    card('How the analysis works', 'Definitions used everywhere in the dashboard', h('dl', { class: 'defs' },
      h('div', null, h('dt', null, 'Interactions'), h('dd', null, 'Likes (or reactions) + comments + shares (reposts, quotes) + saves (bookmarks) on posts published inside the selected period.')),
      h('div', null, h('dt', null, 'Video views'), h('dd', null, 'View counts reported by the platform. YouTube, TikTok and X expose them for any account; Instagram and Facebook only for accounts you own, so they show n/a unless imported.')),
      h('div', null, h('dt', null, 'Engagement rate'), h('dd', null, 'Average interactions per post ÷ followers × 100. Compares audience quality independent of size.')),
      h('div', null, h('dt', null, 'Share of voice'), h('dd', null, 'A competitor\'s interactions as a share of all interactions across the tracked set for the period.')),
      h('div', null, h('dt', null, 'Δ vs previous'), h('dd', null, 'Change against the period of the same length immediately before the selected range.')),
      h('div', null, h('dt', null, 'Follower growth'), h('dd', null, 'Difference between the newest follower snapshot and the snapshot at the start of the period. One snapshot is saved per account per day.')),
      h('div', null, h('dt', null, 'Posting days and hours'), h('dd', null, 'Based on the post\'s published time in UTC. Average interactions by hour shows when a competitor\'s audience responds most.')),
      h('div', null, h('dt', null, 'Freshness'), h('dd', null, 'Each sync re-reads the last 14 days of posts so counters keep updating, and fetches anything new. Use "Full re-sync" to refresh the whole look-back window.')),
    )),
    runsBox,
  );

  async function update() {
    ctx.setTitle('Connect & settings', 'Connect platforms, add competitors, import data and control collection');
    const [creds, competitors, status, runs] = await Promise.all([get('/api/credentials'), get('/api/competitors'), get('/api/sync/status'), get('/api/sync/runs?limit=25')]);
    const credMap = new Map(creds.map((c) => [c.platform, c]));
    replace(platformsBox, ctx.meta.providers.map((p) => platformCard(p, credMap.get(p.id), competitors)));
    replace(syncBox, syncCard(status, competitors));
    replace(importBox, importCard());
    replace(runsBox, card('Recent collection runs', null, runsTable(runs)));
  }

  function platformCard(p, saved, competitors) {
    const g = GUIDES[p.id];
    const connected = Boolean(saved);
    const tracked = competitors.flatMap((c) => c.accounts).filter((a) => a.platform === p.id).length;
    const msg = h('div');
    const inputs = {};
    const form = h('form', { class: 'credential-form', onSubmit: async (e) => {
      e.preventDefault();
      const payload = Object.fromEntries(Object.entries(inputs).map(([k, i]) => [k, i.value]));
      const btn = e.submitter; if (btn) btn.disabled = true;
      replace(msg, h('div', { class: 'status-msg' }, 'Saving and testing…'));
      try {
        const res = await put(`/api/credentials/${p.id}`, payload);
        replace(msg, h('div', { class: `status-msg ${res.test?.ok ? 'ok' : 'bad'}` }, res.test ? res.test.message : 'Saved'));
        if (res.test?.ok) { ctx.toast(`${p.name} connected`); ctx.meta.providers.find((x) => x.id === p.id).configured = true; }
        await ctx.refreshMeta();
      } catch (err) { replace(msg, h('div', { class: 'status-msg bad' }, err.message)); }
      finally { if (btn) btn.disabled = false; }
    } });
    for (const f of p.credentialFields) {
      const input = h('input', { class: 'input', type: f.secret ? 'password' : 'text', placeholder: f.placeholder || '', value: saved?.fields?.[f.key] || '', autocomplete: 'off', spellcheck: 'false' });
      inputs[f.key] = input;
      form.append(h('label', { class: 'field' }, `${f.label}${f.optional ? ' (optional)' : ''}`, input, f.hint ? h('span', { class: 'field-hint' }, f.hint) : null));
    }
    form.append(h('div', { class: 'actions' },
      h('button', { class: 'btn primary', type: 'submit' }, connected ? 'Update & test' : 'Save & test'),
      connected ? h('button', { class: 'btn', type: 'button', onClick: async () => { replace(msg, h('div', { class: 'status-msg' }, 'Testing…')); const r = await post(`/api/credentials/${p.id}/test`); replace(msg, h('div', { class: `status-msg ${r.ok ? 'ok' : 'bad'}` }, r.message)); } }, 'Test connection') : null,
      connected ? h('button', { class: 'btn danger', type: 'button', onClick: async () => { if (!confirm(`Remove ${p.name} credentials?`)) return; await del(`/api/credentials/${p.id}`); await ctx.refreshMeta(); update(); } }, 'Remove') : null,
      saved ? h('span', { class: 'muted small' }, `Saved ${relTime(saved.updatedAt)}`) : null,
    ), msg);

    const cap = (ok, label) => h('span', { class: `badge ${ok ? 'ok' : ''}` }, icon(ok ? 'check' : 'info'), label);
    return h('details', { class: 'card platform-card', open: !connected && p.id === 'youtube' ? true : null },
      h('summary', null,
        icon(p.id, 'platform-icon'),
        h('div', { class: 'title' }, h('strong', null, p.name), h('span', null, g.summary)),
        h('span', { class: `badge ${connected ? 'ok' : 'warn'}` }, icon(connected ? 'check' : 'lock'), connected ? `Connected · ${tracked} account${tracked === 1 ? '' : 's'}` : 'Not connected'),
        icon('chevron', 'chev'),
      ),
      h('div', { class: 'body' },
        h('div', { class: 'guide' },
          h('div', { class: 'caps', style: { marginBottom: '12px' } }, cap(p.capabilities.views, 'Video views'), cap(p.capabilities.interactions, 'Interactions'), cap(p.capabilities.followers, 'Followers'), cap(p.capabilities.shares, 'Shares')),
          h('h4', null, 'How to connect'),
          h('ol', null, g.steps.map(([t, d]) => h('li', null, h('strong', null, t), ' — ', d))),
          h('div', { class: 'note' }, h('strong', null, 'Data collected: '), g.data, h('br'), g.note),
        ),
        h('div', null, h('h4', null, 'Credentials'), form, h('p', { class: 'field-hint', style: { marginTop: '10px' } }, 'Stored encrypted (AES-256-GCM) in the local database. Never sent anywhere except the platform\'s own API.')),
      ),
    );
  }

  function syncCard(status, competitors) {
    const accounts = competitors.flatMap((c) => c.accounts);
    const live = accounts.filter((a) => a.status !== 'demo' && a.status !== 'manual');
    const demo = accounts.filter((a) => a.status === 'demo');
    const info = h('div', { class: 'small secondary' }, status.running
      ? `Collecting… ${status.done}/${status.total} accounts (${status.current.join(', ')})`
      : status.lastResult ? `Last run: ${status.lastResult.ok} ok, ${status.lastResult.failed} failed, ${int(status.lastResult.posts)} posts (${relTime(status.finishedAt)})` : 'No collection has run yet.');
    return card('Collection', `Scheduler: ${status.scheduler}. Look-back ${ctx.meta.sync.lookbackDays} days, up to ${ctx.meta.sync.postsPerAccount} posts per account, ${ctx.meta.sync.concurrency} accounts in parallel. Change these in .env.`,
      h('div', { style: { display: 'grid', gap: '12px' } },
        h('div', { class: 'actions' },
          h('button', { class: 'btn primary', disabled: status.running || !live.length, onClick: () => ctx.startSync() }, icon('sync'), 'Sync all accounts now'),
          h('button', { class: 'btn', disabled: status.running || !live.length, onClick: () => ctx.startSync({ full: true }) }, 'Full re-sync (whole look-back window)'),
          h('span', { class: 'muted small' }, `${live.length} live account${live.length === 1 ? '' : 's'}${demo.length ? `, ${demo.length} demo` : ''}`),
        ),
        info,
        h('div', { class: 'actions' },
          h('a', { class: 'btn', href: '/api/export/posts.csv?range=all' }, icon('download'), 'Export all posts (CSV)'),
          demo.length ? h('button', { class: 'btn', onClick: ctx.clearDemo }, 'Remove demo data') : null,
          h('button', { class: 'btn danger', onClick: async () => {
            if (prompt('This deletes every competitor, account and post. Type DELETE to confirm.') !== 'DELETE') return;
            await post('/api/maintenance/reset', { confirm: 'DELETE' }); ctx.toast('All data deleted'); await ctx.refreshMeta(); update();
          } }, icon('trash'), 'Delete all data'),
        ),
      ));
  }

  function importCard() {
    const cols = ctx.meta.importTemplate.columns;
    const result = h('div');
    const textarea = h('textarea', { class: 'input', placeholder: `${cols.join(',')}\nAcme,instagram,acmefit,C9xyz,2026-11-02T14:00:00Z,reel,https://…,48200,2310,88,120,310,182000,"New drop"`, 'aria-label': 'CSV content' });
    const file = h('input', { type: 'file', accept: '.csv,text/csv', class: 'visually-hidden' });
    const zone = h('div', { class: 'dropzone', tabindex: '0', role: 'button', onClick: () => file.click(), onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') file.click(); } }, 'Drop a CSV file here or click to choose one');
    const readFile = (f) => f && f.text().then((t) => { textarea.value = t; });
    file.addEventListener('change', () => readFile(file.files[0]));
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('over'));
    zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('over'); readFile(e.dataTransfer.files[0]); });
    const submit = async () => {
      if (!textarea.value.trim()) return;
      replace(result, h('div', { class: 'status-msg' }, 'Importing…'));
      try {
        const r = await api('/api/import', { method: 'POST', body: textarea.value, headers: { 'Content-Type': 'text/csv' } });
        replace(result, h('div', { class: `status-msg ${r.errors.length ? 'bad' : 'ok'}` }, `${r.rows} rows read · ${r.posts} posts stored · ${r.accounts} new accounts · ${r.competitors} new competitors${r.errors.length ? ` · ${r.errors.length} rows skipped: ${r.errors.slice(0, 3).join('; ')}` : ''}`));
        if (r.posts) { ctx.toast(`Imported ${r.posts} posts`); textarea.value = ''; await ctx.refreshMeta(); }
      } catch (err) { replace(result, h('div', { class: 'status-msg bad' }, err.message)); }
    };
    return card('Import metrics from CSV', 'For platforms without API access, or data exported from a social listening tool. Rows merge by post ID, so re-importing updates counters.',
      h('div', { style: { display: 'grid', gap: '12px' } },
        h('p', { class: 'small secondary' }, 'Columns: ', h('code', null, cols.join(', ')), '. Required: competitor, platform (youtube / instagram / facebook / tiktok / x), handle, post_id, published_at (ISO date). Leave views empty when unknown. followers (optional) stores a follower snapshot for today.'),
        zone, file, textarea,
        h('div', { class: 'actions' }, h('button', { class: 'btn primary', onClick: submit }, icon('download'), 'Import'), h('a', { class: 'btn', href: '/api/import/template.csv' }, 'Download template')),
        result,
      ));
  }

  function runsTable(runs) {
    if (!runs.length) return empty('No collection runs yet.');
    return h('div', { class: 'table-wrap' }, h('table', null,
      h('thead', null, h('tr', null, h('th', null, 'Started'), h('th', null, 'Account'), h('th', null, 'Competitor'), h('th', null, 'Result'), h('th', { class: 'num' }, 'Posts'))),
      h('tbody', null, runs.map((r) => h('tr', null,
        h('td', { class: 'nowrap', title: longDate(r.started_at) }, relTime(r.started_at)),
        h('td', null, r.platform ? h('span', { class: 'post-cell' }, platformBadge(r.platform, { label: false }), `@${r.handle}`) : h('span', { class: 'muted' }, 'deleted account')),
        h('td', null, r.competitor || '—'),
        h('td', null, r.ok === null ? h('span', { class: 'badge' }, 'running') : h('span', { class: `badge ${r.ok ? 'ok' : 'bad'}`, title: r.message || '' }, r.ok ? 'ok' : 'failed'), r.ok === 0 ? h('div', { class: 'small muted' }, r.message) : null),
        h('td', { class: 'num' }, int(r.posts_upserted)),
      ))),
    ));
  }

  return { el, update, destroy() {} };
}
