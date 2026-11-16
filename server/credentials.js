import { db, stmt, nowIso } from './db.js';
import { encryptJson, decryptJson, mask } from './crypto.js';
import { getProvider } from './providers/index.js';

export function getCredentials(platform) {
  const row = stmt('SELECT payload FROM credentials WHERE platform = ?').get(platform);
  return row ? decryptJson(row.payload) : null;
}

export function saveCredentials(platform, values) {
  const provider = getProvider(platform);
  const existing = getCredentials(platform) || {};
  const clean = {};
  for (const f of provider.credentialFields) {
    const v = values[f.key];
    // A masked value sent back from the UI means "keep what is stored".
    if (v === undefined || v === '' || (typeof v === 'string' && v.startsWith('••'))) {
      if (existing[f.key]) clean[f.key] = existing[f.key];
      else if (!f.optional) throw new Error(`"${f.label}" is required`);
    } else clean[f.key] = String(v).trim();
  }
  stmt('INSERT INTO credentials (platform, payload, updated_at) VALUES (?, ?, ?) ON CONFLICT(platform) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at')
    .run(platform, encryptJson(clean), nowIso());
  return clean;
}

export function deleteCredentials(platform) {
  stmt('DELETE FROM credentials WHERE platform = ?').run(platform);
}

export function configuredPlatforms() {
  return new Set(db.prepare('SELECT platform FROM credentials').all().map((r) => r.platform));
}

/** Masked view for the UI: secrets show their last 4 characters only. */
export function describeCredentials() {
  const rows = db.prepare('SELECT platform, updated_at FROM credentials').all();
  return rows.map((r) => {
    const creds = getCredentials(r.platform);
    const provider = getProvider(r.platform);
    const fields = {};
    for (const f of provider.credentialFields) fields[f.key] = f.secret ? mask(creds[f.key]) : creds[f.key] ?? '';
    return { platform: r.platform, updatedAt: r.updated_at, fields };
  });
}
