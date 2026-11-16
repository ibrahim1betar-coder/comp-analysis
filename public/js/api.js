const etags = new Map();
const bodies = new Map();

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export async function api(path, { method = 'GET', body, raw = false, headers = {} } = {}) {
  const init = { method, headers: { ...headers }, credentials: 'same-origin' };
  if (body !== undefined) {
    if (typeof body === 'string') { init.body = body; init.headers['Content-Type'] ||= 'text/plain'; }
    else { init.body = JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
  }
  // Conditional GETs: the server answers 304 when the analysis has not changed; we reuse the parsed body.
  if (method === 'GET' && etags.has(path)) init.headers['If-None-Match'] = etags.get(path);
  const res = await fetch(path, init);
  if (res.status === 304 && bodies.has(path)) return bodies.get(path);
  if (res.status === 401 && !path.startsWith('/api/login') && !path.startsWith('/api/me/')) {
    window.dispatchEvent(new CustomEvent('auth:required'));
    throw new HttpError(401, 'Authentication required');
  }
  if (raw) return res;
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
  if (!res.ok) throw new HttpError(res.status, data?.error || `Request failed (${res.status})`);
  if (method === 'GET') {
    const etag = res.headers.get('ETag');
    if (etag) { etags.set(path, etag); bodies.set(path, data); }
  }
  return data;
}

export const get = (path) => api(path);
export const post = (path, body) => api(path, { method: 'POST', body: body ?? {} });
export const put = (path, body) => api(path, { method: 'PUT', body });
export const del = (path) => api(path, { method: 'DELETE' });
