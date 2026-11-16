# Competitor Pulse

A self-hosted competitor analysis dashboard for social media. It connects to the official APIs of
**YouTube, Instagram, Facebook, TikTok and X**, collects your competitors' posts, **interactions**
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

Then open **Connect** in the sidebar:

1. Paste API credentials for each platform (tested on save, stored encrypted).
2. Add competitors and their @handles (one account per platform; mark your own brand).
3. Click **Sync now**. The scheduler re-collects every 6 hours by default.
4. Explore **Overview**, **Competitors** and **Posts**. Every number respects the filter row (date range, platforms, competitor).

## What each platform provides

| Platform | How to connect | Followers | Interactions | Video views (competitors) |
|---|---|---|---|---|
| YouTube | Data API v3 key (free, 5 min) | ✓ | likes, comments | ✓ |
| Instagram | Meta app + long-lived token + your IG professional account ID (Business Discovery) | ✓ | likes, comments | ✗ not exposed by Meta |
| Facebook | Meta app token with *Page Public Content Access* (app review) | ✓ | reactions, comments, shares | ✗ only for pages you own |
| TikTok | Research API client key + secret (approval required) | ✓ | likes, comments, shares | ✓ |
| X | API v2 bearer token (Basic tier or higher) | ✓ | likes, replies, reposts + quotes, bookmarks | ✓ video views, else impressions |

Where an API does not expose a metric, the dashboard shows **n/a** instead of a misleading zero.
For any platform you cannot connect, the **CSV import** on the Connect page accepts post-level
metrics (from a social listening tool or manual collection); imported posts appear in every chart.

## Configuration

Copy `.env.example` to `.env`:

| Variable | Default | Purpose |
|---|---|---|
| `PORT`, `HOST` | `3000`, `0.0.0.0` | Where the website listens |
| `DASHBOARD_PASSWORD` | empty | Set it to require a login (recommended for anything not on localhost) |
| `APP_SECRET` | auto-generated in `data/.secret` | Key used to encrypt API credentials at rest |
| `SYNC_INTERVAL_MINUTES` | `360` | Background collection interval (`0` disables the scheduler) |
| `SYNC_CONCURRENCY` | `3` | Accounts collected in parallel (interleaved across platforms) |
| `LOOKBACK_DAYS` | `90` | History collected on the first sync and on a full re-sync |
| `POSTS_PER_ACCOUNT` | `300` | Cap per account per sync |
| `DB_PATH` | `./data/competitor-pulse.db` | SQLite file |

`npm run sync` (or `npm run sync -- --full`) runs a collection from the command line, for cron or CI.

## How the analysis works

* **Interactions** = likes/reactions + comments + shares (reposts, quotes) + saves (bookmarks).
* **Video views** = platform-reported view counts. Totals cover only platforms that expose them.
* **Engagement rate** = average interactions per post ÷ followers × 100.
* **Share of voice** = a competitor's interactions ÷ all tracked interactions in the period.
* **Δ vs previous** = change against the period of equal length immediately before the selected range.
* **Follower growth** = newest daily follower snapshot minus the snapshot at the start of the period.
* **Posting days / hours** use the post's published time (UTC).
* Each sync re-reads the last 14 days of posts so counters keep updating; a full re-sync refreshes the whole look-back window.

## Performance design

* The dashboard never waits on third-party APIs: collection runs in the background and pages read from SQLite.
* SQLite in WAL mode with covering indexes; aggregates are computed in SQL with cached prepared statements.
* Analysis responses are memoised per filter and invalidated on any write; clients send `If-None-Match` and get `304` for unchanged data.
* Brotli/gzip compression, immutable caching for vendor assets, no build step, no framework: the whole front end is ~60 KB of ES modules plus Chart.js served locally.
* Collection is incremental (new posts + a 14-day refresh window), concurrency-limited, platform-interleaved, with exponential backoff and `Retry-After` handling.

## Security

* Credentials are encrypted with AES-256-GCM before they touch disk; the UI only ever sees masked values.
* Optional password login with an HMAC-signed, `HttpOnly` cookie and login rate limiting.
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
| `PUT /api/credentials/:platform` · `POST /api/credentials/:platform/test` | Connect platforms |
| `POST /api/sync` · `GET /api/sync/status` · `GET /api/sync/runs` | Collection control |
| `POST /api/import` (text/csv) · `GET /api/import/template.csv` | Manual data |

Date ranges accept `range=7d|30d|90d|180d|365d|all` or `from=YYYY-MM-DD&to=YYYY-MM-DD`.

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
