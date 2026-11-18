import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';

function readDotEnv() {
  const file = resolve(process.cwd(), '.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*(?:#.*)?$/);
    if (!m) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
}
readDotEnv();

const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

const dbPath = resolve(process.cwd(), process.env.DB_PATH || './data/competitor-pulse.db');
mkdirSync(dirname(dbPath), { recursive: true });

function loadSecret() {
  if (process.env.APP_SECRET) return process.env.APP_SECRET;
  const secretFile = resolve(dirname(dbPath), '.secret');
  if (existsSync(secretFile)) return readFileSync(secretFile, 'utf8').trim();
  const secret = randomBytes(32).toString('hex');
  writeFileSync(secretFile, secret, { mode: 0o600 });
  return secret;
}

export const config = {
  port: num(process.env.PORT, 3000),
  host: process.env.HOST || '0.0.0.0',
  dbPath,
  secret: loadSecret(),
  adminUsername: process.env.ADMIN_USERNAME || '',
  adminPassword: process.env.ADMIN_PASSWORD || '',
  authDisabled: process.env.AUTH_DISABLED === '1',
  syncIntervalMinutes: num(process.env.SYNC_INTERVAL_MINUTES, 360),
  syncConcurrency: Math.max(1, num(process.env.SYNC_CONCURRENCY, 3)),
  lookbackDays: Math.max(1, num(process.env.LOOKBACK_DAYS, 90)),
  postsPerAccount: Math.max(10, num(process.env.POSTS_PER_ACCOUNT, 1000)),
  allowAnonImport: process.env.ALLOW_ANON_IMPORT === '1',
  isProduction: process.env.NODE_ENV === 'production',
};
