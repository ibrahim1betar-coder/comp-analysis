/** Minimal Apify client: run an actor synchronously and return its dataset items. */
import { fetchJson, qs, ApiError } from './http.js';

const API = 'https://api.apify.com/v2';

/** Run `actorId` (e.g. "apify/instagram-scraper") with `input` and return the dataset items. Waits up to `timeoutSecs`. */
export async function runActor(token, actorId, input, { timeoutSecs = 300, memoryMb } = {}) {
  if (!token) throw new ApiError('Apify API token is missing', { status: 401 });
  const id = actorId.replace('/', '~');
  const url = `${API}/acts/${encodeURIComponent(id)}/run-sync-get-dataset-items?${qs({ timeout: timeoutSecs, memory: memoryMb, clean: true, format: 'json' })}`;
  const items = await fetchJson(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(input), timeoutMs: (timeoutSecs + 30) * 1000, retries: 1 });
  if (!Array.isArray(items)) throw new ApiError(`Apify actor ${actorId} returned no dataset`, { body: items });
  return items;
}

/** Verify a token and report the account it belongs to. */
export async function whoAmI(token) {
  const data = await fetchJson(`${API}/users/me`, { headers: { Authorization: `Bearer ${token}` } });
  return data.data || data;
}

/** First defined value among several candidate field names (actors rename fields between versions). */
export const pick = (obj, ...keys) => {
  for (const k of keys) {
    const v = k.split('.').reduce((o, p) => (o == null ? undefined : o[p]), obj);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
};
export const num = (v) => (v === undefined || v === null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
export const when = (v) => {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number') return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
