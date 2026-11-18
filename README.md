# Lime Competitor Analysis

A self-hosted competitor analysis dashboard for social media. It collects your competitors' posts from
**YouTube** (your own Data API key), **Instagram, Facebook and TikTok** (through your Apify account) and
**X** (API v2), and stores their **interactions**
(likes, comments, shares, saves) and **video views** into a local database on a schedule, and turns
them into a fast analytical website: leaderboard, share of voice, engagement rates, growth, platform
and content-type breakdowns, posting-time analysis, top posts and plain-language insights.

The website itself contains the **Connect** page with step-by-step instructions for every platform,
so nobody needs this README to get data flowing.

## Quick start

```bash
npm install
npm run seed      # optional: loads realistic demo data so you can explore the UI first
npm start         # http://localhost:3000
```

Requires Node.js 22.13 or newer (uses the built-in SQLite driver, no native builds).

Sign in with the default account, then change its password:

| Username | Password |
|---|---|
| `admin` | `admin123` |

(Set `ADMIN_USERNAME` / `ADMIN_PASSWORD` in `.env` before the first start to pick your own. More users,
including read-only viewers, are added inside the app under **Connect → Users & access**.)

Then open **Connect** in the sidebar:

1. Paste API credentials for each platform (tested on save, stored encrypted).
2. Add competitors and their @handles (one account per platform; mark your own brand).
3. Click **Sync now**. The scheduler re-collects every 6 hours by default.
4. Explore **Overview**, **Competitors** and **Posts**. Every number respects the filter row (date range, platforms, competitor).

## What each platform provides

Every platform offers two sources, switchable on the Connect page:

| Platform | Official API | Apify | Followers | Interactions | Video views |
|---|---|---|---|---|---|
| YouTube | **Data API v3 key (default)** | `streamers/youtube-scraper` | ✓ | likes, comments | ✓ |
| Instagram | Meta Graph API via **Connect with Facebook** (Business Discovery; no competitor reel views) | **`apify/instagram-scraper` (default)** | ✓ | likes, comments | ✓ with Apify |
| Facebook | Meta Graph API via **Connect with Facebook** (needs *Page Public Content Access* for Pages you don't manage) | **`apify/facebook-posts-scraper` (default)** | ✓ | reactions, comments, shares | when reported |
| TikTok | Research API (approval required) · also **Python + yt-dlp** (free) | **`clockworks/tiktok-scraper` (default)** | ✓ | likes, comments, shares, saves | ✓ |
| X | **API v2 bearer token (default)** | `apidojo/tweet-scraper` | ✓ | likes, replies, reposts + quotes, bookmarks | ✓ |

One Apify token covers every platform set to Apify: paste it once in the Apify card. Advanced: override actors with
`APIFY_INSTAGRAM_ACTOR`, `APIFY_INSTAGRAM_PROFILE_ACTOR`, `APIFY_FACEBOOK_ACTOR`, `APIFY_FACEBOOK_PAGE_ACTOR`,
`APIFY_TIKTOK_ACTOR`, `APIFY_YOUTUBE_ACTOR`, `APIFY_X_ACTOR` in `.env`.

### Connect with Facebook (official Meta API)

Meta only grants API access through an app, so this is a one-time setup, after which you sign in with your own account:

1. developers.facebook.com → My Apps → Create app (type *Business*) → add **Facebook Login for Business** and **Instagram Graph API**.
2. Facebook Login → Settings → *Valid OAuth Redirect URIs*: `http://localhost:3000/api/oauth/meta/callback` (or your server's address; localhost is allowed in Development mode).
3. App settings → Basic → copy **App ID** and **App Secret** into the Meta card on the Connect page.
4. Click **Connect with Facebook**. The dashboard exchanges the login for a 60-day token, finds the Instagram professional account linked to your Page, and switches Facebook and Instagram to the Graph API source.

If Facebook answers **"URL blocked"**, the redirect was not accepted. Either fix the whitelist (Client OAuth login = Yes,
Web OAuth login = Yes, the exact URI in *Valid OAuth Redirect URIs*), or use the fallback on the Meta card,
**"Connect without whitelisting"**: it sends you to Facebook's own `login_success.html` page (always allowed); copy that
page's address into the dashboard and click *Finish connection*.

Why no direct username/password login: Facebook, Instagram and TikTok block automated logins (checkpoints, 2FA, suspensions)
and it would require storing your personal passwords. The official APIs and Apify are the two routes that work reliably.

Where a metric is unavailable the dashboard shows **n/a** rather than a misleading zero, and the **CSV import** accepts
post-level metrics from any other tool.

## Configuration

Copy `.env.example` to `.env`:

| Variable | Default | Purpose |
|---|---|---|
| `PORT`, `HOST` | `3000`, `0.0.0.0` | Where the website listens |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | `admin`, `admin123` | First admin account, created on first start only |
| `AUTH_DISABLED` | `0` | `1` runs without login (local use only) |
| `PYTHON_BIN` | auto (`python3` / `python` / `py`) | Python launcher for the TikTok yt-dlp source |
| `APP_SECRET` | auto-generated in `data/.secret` | Key used to encrypt API credentials at rest |
| `SYNC_INTERVAL_MINUTES` | `360` | Background collection interval (`0` disables the scheduler) |
| `SYNC_CONCURRENCY` | `3` | Accounts collected in parallel (interleaved across platforms) |
| `LOOKBACK_DAYS` | `90` | How far back incremental syncs refresh. The first sync and a full re-sync fetch the newest `POSTS_PER_ACCOUNT` posts regardless of age |
| `POSTS_PER_ACCOUNT` | `1000` | Newest posts collected per account per sync. The dashboard warns when an account's stored posts do not reach back to the start of the selected period |
| `DB_PATH` | `./data/competitor-pulse.db` | SQLite file |

`npm run sync` (or `npm run sync -- --full`) runs a collection from the command line, for cron or CI.

## How the analysis works

Two ways to count, switchable in the filter row:

* **Activity in period** (default): views, likes, comments, shares and saves **gained during the selected period on any post**,
  old or new. Every sync stores each post's counters (`post_snapshots`); the period value is the difference between the
  snapshots at the period's start and end. A post published inside the period contributes its full counters. The first
  sync only records the starting point, so activity appears from the second sync on.
* **Published in period**: lifetime totals of the posts published inside the period. Use it for ranges before tracking
  started, or to compare launches.

* **Interactions** = likes/reactions + comments + shares (reposts, quotes) + saves (bookmarks).
* **Video views** = platform-reported view counts. Totals cover only platforms that expose them.
* **Engagement rate** = average interactions per post ÷ followers × 100.
* **Share of voice** = a competitor's interactions ÷ all tracked interactions in the period.
* **Δ vs previous** = change against the period of equal length immediately before the selected range.
* **Follower growth** = newest daily follower snapshot minus the snapshot at the start of the period.
* **Posting days / hours** use the post's published time (UTC).
* The first sync fetches an account's newest posts regardless of age, so rarely-posting accounts still show up. Later syncs re-read the last 14 days (counters keep updating) plus anything new; a full re-sync fetches everything again.

## Performance design

* The dashboard never waits on third-party APIs: collection runs in the background and pages read from SQLite.
* SQLite in WAL mode with covering indexes; aggregates are computed in SQL with cached prepared statements.
* Analysis responses are memoised per filter and invalidated on any write; clients send `If-None-Match` and get `304` for unchanged data.
* Brotli/gzip compression, immutable caching for vendor assets, no build step, no framework: the whole front end is ~60 KB of ES modules plus Chart.js served locally.
* Collection is incremental (new posts + a 14-day refresh window), concurrency-limited, platform-interleaved, with exponential backoff and `Retry-After` handling.

## Security

* Credentials are encrypted with AES-256-GCM before they touch disk; the UI only ever sees masked values.
* Username/password accounts (scrypt-hashed), admin and read-only viewer roles, HMAC-signed `HttpOnly` session cookies that are invalidated on password change, login rate limiting.
* Strict Content-Security-Policy (no inline scripts), `nosniff`, no referrer leakage to platforms' CDNs.
* All data stays on your server. Nothing is sent anywhere except the platforms' own APIs.

## Project layout

```
server/
  index.js        Fastify app: static files, compression, security headers, auth hook
  routes/api.js   REST API (competitors, accounts, credentials, sync, analysis, import/export)
  collector.js    Scheduled, concurrent, incremental collection into SQLite
  analysis.js     SQL aggregations: overview, competitor detail, posts, export
  insights.js     Rule-based narrative insights
  providers/      One module per platform (youtube, instagram, facebook, tiktok, x)
  apify.js        Apify client (run actor, dataset items, tolerant field mapping)
  db.js           node:sqlite schema, pragmas, re-entrant transactions
  credentials.js  Encrypted credential store
  seed.js         Demo data generator
public/
  index.html, css/app.css, js/ (app shell, router, charts, views/)
test/             node:test suites: analysis, API, providers, CSV, crypto
```

## API overview

| Method & path | Purpose |
|---|---|
| `GET /api/analysis/overview?range=30d&platforms=youtube,tiktok&competitors=1,2` | Totals, per-competitor and per-platform rows, matrix, time series, top posts, insights |
| `GET /api/analysis/competitors/:id?range=…` | Per-account breakdown, content types, weekday/hour analysis, follower history |
| `GET /api/analysis/posts?sort=views&dir=desc&page=1&type=reel&q=launch` | Paginated post list |
| `GET /api/export/posts.csv?range=all` | CSV export |
| `POST /api/competitors` · `POST /api/competitors/:id/accounts` · `DELETE …` | Manage what is tracked |
| `PUT /api/credentials/:platform` · `POST /api/credentials/:platform/test` | Connect platforms (fields per platform from `GET /api/meta`) |
| `POST /api/sync` · `GET /api/sync/status` · `GET /api/sync/runs` | Collection control |
| `POST /api/import` (text/csv) · `GET /api/import/template.csv` | Manual data |
| `POST /api/login` · `GET /api/users` · `POST /api/users` · `PUT /api/me/password` | Accounts |

Date ranges accept `range=7d|30d|90d|180d|365d|all` or `from=YYYY-MM-DD&to=YYYY-MM-DD`.

## Deploying (Docker)

```bash
docker build -t competitor-pulse .
docker run -d -p 3000:3000 -v competitor-pulse-data:/app/data -e ADMIN_PASSWORD=choose-a-strong-one competitor-pulse
```

The image works unchanged on Railway, Render, Fly.io or any VPS. Keep the `/app/data` volume: it holds the database and the credential-encryption key.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Cannot find module 'node:sqlite'` or "needs Node.js 22.13 or newer" | Install Node 22 LTS or newer from https://nodejs.org, check with `node --version`, then run `npm start` again. |
| `Cannot find package 'fastify'` or "Dependencies are not installed" | Run `npm install` inside the project folder first. |
| `EADDRINUSE` / "Port 3000 is already in use" | Start on another port: `PORT=4000 npm start` (PowerShell: `$env:PORT=4000; npm start`). |
| Browser shows an empty dashboard | Run `npm run seed` for demo data, or connect a platform and add competitors on the Connect page, then click Sync now. |
| `npm start` opens nothing | It does not open a browser by itself: go to http://localhost:3000 once the terminal prints "ready". |
| Sync fails with "not connected" | Save credentials for that platform on the Connect page; the test must pass before accounts can be collected. |

## Tests

```bash
npm test
```
