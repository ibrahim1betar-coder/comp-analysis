import youtube from './youtube.js';
import instagram from './instagram.js';
import facebook from './facebook.js';
import tiktok from './tiktok.js';
import x from './x.js';

export const providers = Object.fromEntries([youtube, instagram, facebook, tiktok, x].map((p) => [p.id, p]));
export const PLATFORMS = Object.keys(providers);

export function getProvider(id) {
  const p = providers[id];
  if (!p) throw new Error(`Unknown platform "${id}"`);
  return p;
}

/** Normalise a handle the way the platform's provider does so UNIQUE(platform, handle) catches duplicates. */
export function normaliseHandle(platform, handle) {
  const h = String(handle || '').trim();
  switch (platform) {
    case 'youtube': {
      const q = parseYt(h);
      return q.id || (q.forHandle ? `@${q.forHandle}` : q.forUsername);
    }
    case 'instagram': return instagramParse(h);
    case 'tiktok': return tiktokParse(h);
    case 'x': return xParse(h);
    case 'facebook': return facebookParse(h);
    default: return h;
  }
}
import { parseHandle as parseYt } from './youtube.js';
import { parseHandle as instagramParse } from './instagram.js';
import { parseHandle as tiktokParse } from './tiktok.js';
import { parseHandle as xParse } from './x.js';
import { parseHandle as facebookParse } from './facebook.js';

/** Public, non-secret description of every platform for the UI. */
export function describeProviders(configured = new Set()) {
  return Object.values(providers).map((p) => ({
    id: p.id,
    name: p.name,
    source: p.source || 'Official API',
    capabilities: p.capabilities,
    credentialFields: p.credentialFields,
    handlePlaceholder: p.handlePlaceholder,
    configured: configured.has(p.id),
  }));
}
