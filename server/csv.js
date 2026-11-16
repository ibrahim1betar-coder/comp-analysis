/** Minimal RFC-4180 CSV parser and writer (quotes, escaped quotes, CRLF). */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const s = String(text).replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c !== '')) rows.push(row);
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  return rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])));
}

export function toCsv(rows, columns) {
  const cols = columns || (rows.length ? Object.keys(rows[0]) : []);
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\r\n');
}

export const IMPORT_TEMPLATE = {
  columns: ['competitor', 'platform', 'handle', 'post_id', 'published_at', 'type', 'url', 'views', 'likes', 'comments', 'shares', 'saves', 'followers', 'caption'],
  example: [
    { competitor: 'Acme Fitness', platform: 'instagram', handle: 'acmefit', post_id: 'C9xyz123', published_at: '2026-11-02T14:00:00Z', type: 'reel', url: 'https://www.instagram.com/reel/C9xyz123/', views: 48200, likes: 2310, comments: 88, shares: 120, saves: 310, followers: 182000, caption: 'New winter drop' },
    { competitor: 'Acme Fitness', platform: 'tiktok', handle: 'acmefit', post_id: '7311112222', published_at: '2026-11-03T09:30:00Z', type: 'video', url: 'https://www.tiktok.com/@acmefit/video/7311112222', views: 221000, likes: 15400, comments: 410, shares: 980, saves: 0, followers: 410000, caption: '' },
  ],
};
