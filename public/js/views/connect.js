import { h, replace, icon } from '../dom.js';
import { get, post, put, del, api } from '../api.js';
import { int, relTime, longDate, at } from '../format.js';
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
    summary: 'Through Apify: public data for any account, including reel and video view counts. No Meta app needed.',
    steps: [
      ['Create an Apify account', 'console.apify.com → Sign up. The free plan includes monthly credits; the Instagram scraper costs about $2.30 per 1,000 posts.'],
      ['Copy your API token', 'Apify Console → Settings → API & Integrations → Personal API tokens → copy (or create) a token.'],
      ['Paste the token in the Apify card above', 'It is verified against your Apify account and links Instagram, Facebook and TikTok in one go.'],
      ['Add competitor accounts', 'Use the @username or profile URL of any public Instagram account. Private accounts cannot be read.'],
    ],
    note: 'Each sync runs the actor once per account (about 10-30 seconds). Views are reported for reels and videos; image posts have no view count.',
    data: 'Followers, posts count, likes, comments, reel/video views, media type (reel / video / image / carousel).',
  },
  facebook: {
    summary: 'Through Apify: public Page posts with reactions, comments, shares and followers. No Meta app review needed.',
    steps: [
      ['Create an Apify account and token', 'Same token as Instagram: console.apify.com → Settings → API & Integrations → Personal API tokens.'],
      ['Link Apify above', 'Once the Apify token is saved, Facebook is linked automatically.'],
      ['Add competitor Pages', 'Use the Page username (facebook.com/username), the numeric Page ID or the full URL. Only public Pages, not personal profiles or groups.'],
    ],
    note: 'Reactions are counted as likes. Video view counts are stored when the actor reports them; otherwise the post shows n/a for views.',
    data: 'Followers, Page likes, posts, reactions, comments, shares, media type.',
  },
  tiktok: {
    summary: 'Through Apify (default), a free Python fetcher (yt-dlp), or the official TikTok Research API.',
    steps: [
      ['Choose the data source', 'Apify needs only your Apify token. Python (yt-dlp) is free and needs no account, just Python installed on the machine running the dashboard. The Research API is TikTok\'s official route but requires an approved research application.'],
      ['Python: install Python 3 and yt-dlp', 'python.org → Downloads → install (tick "Add Python to PATH"), then in a terminal run:  pip install yt-dlp   (Windows: py -m pip install yt-dlp). Select "Python (yt-dlp)" and click Save & test.'],
      ['Apify: link the token above', 'Same token as Instagram and Facebook; TikTok is collected with clockworks/tiktok-scraper.'],
      ['Research API: paste client key and secret', 'developers.tiktok.com → Research API → apply → add the Research API product to your app → copy the credentials.'],
      ['Add competitor accounts', 'Use the @username or profile URL.'],
    ],
    note: 'TikTok has no public API for other accounts\' videos. The Python source uses yt-dlp\'s TikTok extractor: it is free but depends on yt-dlp keeping up with TikTok\'s changes (run "pip install -U yt-dlp" when it stops working) and is not an official TikTok interface. Apify and the Research API are the alternatives.',
    data: 'Followers, total likes, video count, views, likes, comments, shares, saves per video.',
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
  const usersBox = h('div');

  el.append(
    card('How it works', 'Four steps from zero to a live competitor dashboard', h('div', { class: 'steps' },
      h('div', { class: 'step' }, h('div', null, h('strong', null, 'Connect platforms'), h('p', null, 'YouTube uses your own Google API key; Instagram, Facebook and TikTok run through your Apify account (one token for all three). Each connection is tested on save and stored encrypted.'))),
      h('div', { class: 'step' }, h('div', null, h('strong', null, 'Add competitors'), h('p', null, 'Create a competitor and attach its @handles. Mark one as your own brand to benchmark against.'))),
      h('div', { class: 'step' }, h('div', null, h('strong', null, 'Collect'), h('p', null, `Posts, views, interactions and follower counts are pulled into the local database. The scheduler re-collects every ${ctx.meta.sync.intervalMinutes} minutes.`))),
      h('div', { class: 'step' }, h('div', null, h('strong', null, 'Analyse'), h('p', null, 'The Overview, Competitors and Posts pages compute share of voice, engagement rates, growth, content-type and timing analysis from the stored data, instantly.'))),
    )),
    h('div', null, h('h2', { style: { marginBottom: '10px' } }, 'Platform connections'), platformsBox),
    syncBox,
    importBox,
    usersBox,
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
    replace(platformsBox, apifyCard(), ctx.meta.providers.map((p) => platformCard(p, credMap.get(p.id), competitors)));
    replace(syncBox, syncCard(status, competitors));
    replace(importBox, importCard());
    replace(runsBox, card('Recent collection runs', null, runsTable(runs)));
    replace(usersBox, await usersCard());
    if (location.hash.includes('users=1')) usersBox.scrollIntoView({ behavior: 'smooth' });
  }

  async function usersCard() {
    if (!ctx.meta.authRequired) return card('Users & access', 'Login is disabled (AUTH_DISABLED=1). Remove that setting to require a username and password.', h('div'));
    const me = ctx.user;
    const msg = h('div');
    const say = (text, ok = true) => replace(msg, h('div', { class: `status-msg ${ok ? 'ok' : 'bad'}` }, text));

    // change my own password
    const cur = h('input', { class: 'input', type: 'password', placeholder: 'Current password', autocomplete: 'current-password' });
    const nw = h('input', { class: 'input', type: 'password', placeholder: 'New password (8+ characters)', autocomplete: 'new-password' });
    const mine = h('form', { class: 'actions', onSubmit: async (e) => {
      e.preventDefault();
      try { await put('/api/me/password', { currentPassword: cur.value, password: nw.value }); say('Password changed.'); cur.value = nw.value = ''; location.hash = '#/connect'; setTimeout(() => location.reload(), 800); }
      catch (err) { say(err.message, false); }
    } }, cur, nw, h('button', { class: 'btn primary', type: 'submit' }, 'Change my password'));

    let adminPart = null;
    if (me.role === 'admin') {
      const users = await get('/api/users');
      const uname = h('input', { class: 'input', placeholder: 'Username', autocomplete: 'off' });
      const upass = h('input', { class: 'input', type: 'password', placeholder: 'Password (8+ characters)', autocomplete: 'new-password' });
      const role = h('select', { class: 'select' }, h('option', { value: 'viewer' }, 'Viewer (read only)'), h('option', { value: 'admin' }, 'Admin'));
      const add = h('form', { class: 'actions', onSubmit: async (e) => {
        e.preventDefault();
        try { await post('/api/users', { username: uname.value.trim(), password: upass.value, role: role.value }); say(`Created ${uname.value.trim()}.`); update(); }
        catch (err) { say(err.message, false); }
      } }, uname, upass, role, h('button', { class: 'btn primary', type: 'submit' }, icon('plus'), 'Add user'));
      adminPart = h('div', { style: { display: 'grid', gap: '12px' } },
        h('h4', null, 'All users'),
        h('div', { class: 'table-wrap' }, h('table', null,
          h('thead', null, h('tr', null, h('th', null, 'Username'), h('th', null, 'Role'), h('th', null, 'Last sign-in'), h('th', null, ''))),
          h('tbody', null, users.map((u) => h('tr', null,
            h('td', null, u.username, u.id === me.id ? h('span', { class: 'badge info', style: { marginLeft: '8px' } }, 'you') : null, u.mustChange ? h('span', { class: 'badge warn', style: { marginLeft: '8px' } }, 'default password') : null),
            h('td', null, u.role),
            h('td', null, u.lastLoginAt ? relTime(u.lastLoginAt) : 'never'),
            h('td', null, h('div', { class: 'actions' },
              h('button', { class: 'btn ghost sm', onClick: async () => {
                const p = prompt(`New password for ${u.username} (8+ characters):`);
                if (!p) return;
                try { await put(`/api/users/${u.id}/password`, { password: p }); say(`Password for ${u.username} updated.`); update(); } catch (err) { say(err.message, false); }
              } }, 'Reset password'),
              u.id !== me.id ? h('button', { class: 'btn ghost sm danger', onClick: async () => {
                if (!confirm(`Delete user ${u.username}?`)) return;
                try { await del(`/api/users/${u.id}`); update(); } catch (err) { say(err.message, false); }
              } }, icon('trash')) : null,
            )),
          ))),
        )),
        h('h4', null, 'Add a user'),
        add,
      );
    }
    return card('Users & access', `Signed in as ${me.username} (${me.role}). Admins manage data and users; viewers can only look.`,
      h('div', { style: { display: 'grid', gap: '14px' } }, h('div', null, h('h4', null, 'My password'), mine), adminPart, msg));
  }



  const APIFY = new Set(['instagram', 'facebook', 'tiktok']);
  function apifyCard() {
    const linked = ctx.meta.sharedApifyToken;
    const msg = h('div');
    const input = h('input', { class: 'input', type: 'password', placeholder: linked ? 'Token saved. Paste a new one to replace it.' : 'apify_api_…', autocomplete: 'off', spellcheck: 'false' });
    const form = h('form', { class: 'credential-form', onSubmit: async (e) => {
      e.preventDefault();
      const btn = e.submitter; if (btn) btn.disabled = true;
      replace(msg, h('div', { class: 'status-msg' }, 'Saving and testing…'));
      try {
        const res = await put('/api/credentials/apify', { apifyToken: input.value });
        replace(msg, h('div', { class: `status-msg ${res.test?.ok ? 'ok' : 'bad'}` }, res.test?.message || 'Saved'));
        if (res.test?.ok) ctx.toast('Apify linked: Instagram, Facebook and TikTok are ready');
        await ctx.refreshMeta(); update();
      } catch (err) { replace(msg, h('div', { class: 'status-msg bad' }, err.message)); }
      finally { if (btn) btn.disabled = false; }
    } },
      h('label', { class: 'field' }, 'Apify API token', input, h('span', { class: 'field-hint' }, 'Apify Console → Settings → API & Integrations → Personal API tokens.')),
      h('div', { class: 'actions' },
        h('button', { class: 'btn primary', type: 'submit' }, linked ? 'Update & test' : 'Link Instagram, Facebook & TikTok'),
        linked ? h('button', { class: 'btn danger', type: 'button', onClick: async () => { if (!confirm('Unlink Apify? Instagram, Facebook and TikTok will stop collecting.')) return; await del('/api/credentials/apify'); await ctx.refreshMeta(); update(); } }, 'Unlink') : null,
      ), msg);
    return h('div', { class: 'card platform-card', style: { padding: 0 } },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', padding: '16px 20px' } },
        h('div', { class: 'brand-mark', style: { background: 'var(--surface-3)', color: 'var(--text)' } }, 'A'),
        h('div', { class: 'title', style: { flex: 1 } }, h('strong', null, 'Apify'), h('div', { class: 'muted small' }, 'One token links Instagram, Facebook and TikTok. Apify runs the collection; you only paste the token.')),
        h('span', { class: `badge ${linked ? 'ok' : 'warn'}` }, icon(linked ? 'check' : 'lock'), linked ? 'Linked' : 'Not linked'),
      ),
      h('div', { class: 'body', style: { gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)' } },
        h('div', { class: 'guide' },
          h('h4', null, 'How to get the token'),
          h('ol', null,
            h('li', null, h('strong', null, 'Create an Apify account'), ' — console.apify.com → Sign up (the free plan includes monthly credits).'),
            h('li', null, h('strong', null, 'Copy your API token'), ' — Settings → API & Integrations → Personal API tokens → copy or create one.'),
            h('li', null, h('strong', null, 'Paste it here and click Link'), ' — the token is tested against your Apify account and stored encrypted.'),
            h('li', null, h('strong', null, 'Add competitors'), ' — then click Sync now. Each account costs a few cents per sync (about $2 per 1,000 posts).'),
          ),
        ),
        h('div', null, h('h4', null, 'Token'), form),
      ),
    );
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
    const rows = {};
    const refresh = () => {
      for (const f of p.credentialFields) if (f.showWhen) rows[f.key].hidden = !Object.entries(f.showWhen).every(([k, v]) => (inputs[k]?.value || 'apify') === v);
    };
    for (const f of p.credentialFields) {
      let input;
      if (f.type === 'select') {
        input = h('select', { class: 'select', onChange: refresh }, f.options.map(([v, l]) => h('option', { value: v, selected: (saved?.fields?.[f.key] || f.options[0][0]) === v ? true : null }, l)));
      } else {
        input = h('input', { class: 'input', type: f.secret ? 'password' : 'text', placeholder: f.placeholder || '', value: saved?.fields?.[f.key] || '', autocomplete: 'off', spellcheck: 'false' });
      }
      inputs[f.key] = input;
      rows[f.key] = f.shared === 'apify'
        ? h('div', { class: 'field' }, h('span', { class: 'small secondary' }, ctx.meta.sharedApifyToken ? 'Uses the Apify token from the Apify card above.' : 'Paste your Apify token in the Apify card above first.'))
        : h('label', { class: 'field' }, `${f.label}${f.optional ? ' (optional)' : ''}`, input, f.hint ? h('span', { class: 'field-hint' }, f.hint) : null);
      form.append(rows[f.key]);
    }
    refresh();
    form.append(h('div', { class: 'actions' },
      h('button', { class: 'btn primary', type: 'submit' }, connected ? 'Update & test' : 'Save & test'),
      connected ? h('button', { class: 'btn', type: 'button', onClick: async () => { replace(msg, h('div', { class: 'status-msg' }, 'Testing…')); const r = await post(`/api/credentials/${p.id}/test`); replace(msg, h('div', { class: `status-msg ${r.ok ? 'ok' : 'bad'}` }, r.message)); } }, 'Test connection') : null,
      connected ? h('button', { class: 'btn danger', type: 'button', onClick: async () => { if (!confirm(`Remove ${p.name} credentials?`)) return; await del(`/api/credentials/${p.id}`); await ctx.refreshMeta(); update(); } }, 'Remove') : null,
      saved ? h('span', { class: 'muted small' }, `Saved ${relTime(saved.updatedAt)}`) : null,
    ), msg);

    const viaApify = APIFY.has(p.id) && (p.id !== 'tiktok' || (saved?.fields?.source || 'apify') === 'apify');
    const linked = ctx.meta.sharedApifyToken;
    const credentialsPane = viaApify && p.id !== 'tiktok'
      ? h('div', null, h('h4', null, 'Credentials'),
          h('p', { class: 'small secondary' }, linked ? 'Linked through the Apify token above. Nothing else to configure.' : 'Paste your Apify token in the Apify card above to link this platform.'),
          linked ? h('div', { class: 'actions', style: { marginTop: '10px' } }, h('button', { class: 'btn', type: 'button', onClick: async () => { replace(msg, h('div', { class: 'status-msg' }, 'Testing…')); const r = await post(`/api/credentials/${p.id}/test`); replace(msg, h('div', { class: `status-msg ${r.ok ? 'ok' : 'bad'}` }, r.message)); } }, 'Test connection')) : null,
          msg)
      : h('div', null, h('h4', null, 'Credentials'), form, h('p', { class: 'field-hint', style: { marginTop: '10px' } }, 'Stored encrypted (AES-256-GCM) in the local database. Never sent anywhere except the platform\'s own API.'));
    const cap = (ok, label) => h('span', { class: `badge ${ok ? 'ok' : ''}` }, icon(ok ? 'check' : 'info'), label);
    return h('details', { class: 'card platform-card', open: !connected && p.id === 'youtube' ? true : null },
      h('summary', null,
        icon(p.id, 'platform-icon'),
        h('div', { class: 'title' }, h('strong', null, p.name, h('span', { class: 'badge', style: { marginLeft: '8px', fontWeight: 500 } }, p.source)), h('span', null, g.summary)),
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
        credentialsPane,
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
        h('td', null, r.platform ? h('span', { class: 'post-cell' }, platformBadge(r.platform, { label: false }), at(r.handle)) : h('span', { class: 'muted' }, 'deleted account')),
        h('td', null, r.competitor || '—'),
        h('td', null, r.ok === null ? h('span', { class: 'badge' }, 'running') : h('span', { class: `badge ${r.ok ? 'ok' : 'bad'}`, title: r.message || '' }, r.ok ? 'ok' : 'failed'), r.ok === 0 ? h('div', { class: 'small muted' }, r.message) : null),
        h('td', { class: 'num' }, int(r.posts_upserted)),
      ))),
    ));
  }

  return { el, update, destroy() {} };
}
