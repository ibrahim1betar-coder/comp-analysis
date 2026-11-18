import { db, stmt, nowIso, getSetting, setSetting } from './db.js';
import { encryptJson, decryptJson, mask } from './crypto.js';
import { getProvider, providers } from './providers/index.js';

export function getCredentials(platform, { shared = true } = {}) {
  const row = stmt('SELECT payload FROM credentials WHERE platform = ?').get(platform);
  const creds = row ? decryptJson(row.payload) : null;
  if (!shared) return creds;
  // Fill a missing shared token (e.g. Apify) from whichever platform it was saved for.
  const provider = getProvider(platform);
  const out = creds ? { ...creds } : {};
  let any = Boolean(creds);
  for (const f of provider.credentialFields) if (f.shared && !out[f.key] && getShared(f.shared)) { out[f.key] = getShared(f.shared); any = true; }
  return any ? out : null;
}

/** Fields that apply given the chosen values (a field with showWhen is only relevant when its condition holds). */
let currentDefaultSource = 'apify';
const applies = (field, values) => !field.showWhen || Object.entries(field.showWhen).every(([k, v]) => (values[k] ?? (k === 'source' ? currentDefaultSource : undefined)) === v);

export function saveCredentials(platform, values) {
  const provider = getProvider(platform);
  currentDefaultSource = provider.defaultSource || 'apify';
  const existing = getCredentials(platform, { shared: false }) || {};
  const clean = {};
  const merged = { ...existing, ...values };
  for (const f of provider.credentialFields) {
    if (f.type === 'select') {
      const allowed = f.options.map((o) => o[0]);
      clean[f.key] = allowed.includes(merged[f.key]) ? merged[f.key] : provider.defaultSource || allowed[0];
      continue;
    }
    if (!applies(f, clean)) continue;
    const v = values[f.key];
    // A masked value sent back from the UI means "keep what is stored".
    if (v === undefined || v === '' || (typeof v === 'string' && v.startsWith('••'))) {
      if (existing[f.key]) clean[f.key] = existing[f.key];
      else if (f.shared && getShared(f.shared)) clean[f.key] = getShared(f.shared);
      else if (!f.optional) throw new Error(`"${f.label}" is required`);
    } else clean[f.key] = String(v).trim();
    if (f.shared && clean[f.key]) setSetting(`shared.${f.shared}`, clean[f.key]);
  }
  stmt('INSERT INTO credentials (platform, payload, updated_at) VALUES (?, ?, ?) ON CONFLICT(platform) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at')
    .run(platform, encryptJson(clean), nowIso());
  return clean;
}

/** A token pasted for one platform (e.g. the Apify token) is reused by the others that need the same one. */
export const getShared = (name) => getSetting(`shared.${name}`, null);

export const APIFY_PLATFORMS = ['instagram', 'facebook', 'tiktok', 'youtube', 'x'];

/** Store one Apify token and connect every platform that runs through Apify (TikTok only if it is not set to the Research API). */
export function saveApifyToken(token) {
  const t = String(token || '').trim();
  if (!t || t.startsWith('••')) {
    if (!getShared('apify')) throw new Error('Apify API token is required');
  } else setSetting('shared.apify', t);
  for (const platform of APIFY_PLATFORMS) {
    const existing = getCredentials(platform, { shared: false }) || {};
    // Keep platforms that are deliberately on an official source (or another source) as they are.
    if (existing.source && existing.source !== 'apify') continue;
    // YouTube and X default to their official APIs: only switch them to Apify when nothing official is configured.
    if (!existing.source && ['youtube', 'x'].includes(platform) && (existing.apiKey || existing.bearerToken)) continue;
    saveCredentials(platform, { ...existing, source: 'apify', apifyToken: getShared('apify') });
  }
}

/** Meta app (App ID + secret) used by "Connect with Facebook". Stored encrypted. */
export function getMetaApp() {
  const row = stmt('SELECT payload FROM credentials WHERE platform = ?').get('meta_app');
  return row ? decryptJson(row.payload) : null;
}
export function saveMetaApp({ appId, appSecret, configId }) {
  const existing = getMetaApp() || {};
  const clean = {
    appId: String(appId || existing.appId || '').trim(),
    appSecret: (!appSecret || String(appSecret).startsWith('••')) ? existing.appSecret : String(appSecret).trim(),
    configId: configId === undefined ? existing.configId || '' : String(configId).trim(),
  };
  if (!clean.appId || !clean.appSecret) throw new Error('App ID and App Secret are required');
  stmt('INSERT INTO credentials (platform, payload, updated_at) VALUES (?, ?, ?) ON CONFLICT(platform) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at').run('meta_app', encryptJson(clean), nowIso());
  return clean;
}

export function deleteApifyToken() {
  stmt('DELETE FROM settings WHERE key = ?').run('shared.apify');
  for (const platform of APIFY_PLATFORMS) {
    const existing = getCredentials(platform, { shared: false });
    if (existing && (existing.source || 'apify') === 'apify') deleteCredentials(platform);
  }
}

export function deleteCredentials(platform) {
  stmt('DELETE FROM credentials WHERE platform = ?').run(platform);
}

/** Capabilities for the UI: some sources expose fewer metrics (e.g. Meta Graph API has no competitor view counts). */
export function effectiveCapabilities(platform) {
  const p = getProvider(platform);
  const creds = getCredentials(platform);
  return (p.capabilitiesFor && p.capabilitiesFor(creds)) || p.capabilities;
}

export function configuredPlatforms() {
  const out = new Set();
  for (const p of Object.keys(providers)) {
    const creds = getCredentials(p);
    if (!creds) continue;
    currentDefaultSource = providers[p].defaultSource || 'apify';
    const ok = providers[p].credentialFields.every((f) => f.optional || f.type === 'select' || !applies(f, creds) || creds[f.key]);
    if (ok) out.add(p);
  }
  return out;
}

/** Masked view for the UI: secrets show their last 4 characters only. */
export function describeCredentials() {
  const rows = db.prepare('SELECT platform, updated_at FROM credentials').all().filter((r) => providers[r.platform]);
  return rows.map((r) => {
    const creds = getCredentials(r.platform) || {};
    const provider = getProvider(r.platform);
    const fields = {};
    for (const f of provider.credentialFields) fields[f.key] = f.secret ? mask(creds[f.key]) : creds[f.key] ?? '';
    return { platform: r.platform, updatedAt: r.updated_at, fields };
  });
}
