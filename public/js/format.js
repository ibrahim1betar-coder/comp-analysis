const intFmt = new Intl.NumberFormat('en-US');
export const int = (n) => (n === null || n === undefined || Number.isNaN(Number(n)) ? '—' : intFmt.format(Math.round(Number(n))));

export function compact(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
  const v = Number(n);
  const abs = Math.abs(v);
  const trim = (x) => x.replace(/\.0$/, '');
  if (abs >= 1e9) return trim((v / 1e9).toFixed(abs >= 1e10 ? 0 : 1)) + 'B';
  if (abs >= 1e6) return trim((v / 1e6).toFixed(abs >= 1e7 ? 0 : 1)) + 'M';
  if (abs >= 1e4) return (v / 1e3).toFixed(0) + 'K';
  if (abs >= 1e3) return trim((v / 1e3).toFixed(1)) + 'K';
  return intFmt.format(Math.round(v));
}

export const pct = (n, digits = 1) => (n === null || n === undefined || Number.isNaN(Number(n)) ? '—' : `${Number(n).toFixed(digits)}%`);
export const signedPct = (n, digits = 0) => (n === null || n === undefined || !Number.isFinite(n) ? '—' : `${n > 0 ? '+' : ''}${n.toFixed(digits)}%`);
export const signed = (n) => (n === null || n === undefined ? '—' : `${n > 0 ? '+' : ''}${compact(n)}`);
export const change = (cur, prev) => (prev ? ((cur - prev) / prev) * 100 : null);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function shortDate(iso, bucket = 'day') {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  if (bucket === 'month') return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}
export function longDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
export function relTime(iso) {
  if (!iso) return 'never';
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  return `${Math.floor(diff / 86400)} d ago`;
}
export const title = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');
export const truncate = (s, n = 90) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');
