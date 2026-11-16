/** Small fetch wrapper: timeouts, retries with exponential backoff, Retry-After support, readable API errors. */

export class ApiError extends Error {
  constructor(message, { status = 0, retryable = false, body = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.retryable = retryable;
    this.body = body;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function qs(params) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    sp.set(k, String(v));
  }
  return sp.toString();
}

/** Pull a human-readable message out of the error payloads of the big platforms. */
export function extractApiMessage(body, status) {
  if (!body || typeof body !== 'object') return `HTTP ${status}`;
  return (
    body.error?.message || // Google, Meta, TikTok
    body.error_description ||
    body.detail || // X
    body.title ||
    (Array.isArray(body.errors) && body.errors[0]?.message) ||
    body.message ||
    `HTTP ${status}`
  );
}

export async function fetchJson(url, { method = 'GET', headers = {}, body, timeoutMs = 20000, retries = 3 } = {}) {
  let attempt = 0;
  for (;;) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(url, { method, headers, body, signal: controller.signal });
    } catch (err) {
      clearTimeout(timer);
      if (attempt < retries) {
        await sleep(500 * 2 ** attempt);
        attempt++;
        continue;
      }
      throw new ApiError(err.name === 'AbortError' ? `Request timed out after ${timeoutMs} ms` : `Network error: ${err.message}`, { retryable: true });
    }
    clearTimeout(timer);

    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }

    if (res.ok) return json ?? {};

    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt < retries) {
      const retryAfter = Number(res.headers.get('retry-after'));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 60000) : 800 * 2 ** attempt;
      await sleep(wait);
      attempt++;
      continue;
    }
    throw new ApiError(extractApiMessage(json, res.status), { status: res.status, retryable, body: json ?? text.slice(0, 300) });
  }
}
