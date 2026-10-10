// Business dates are ISO strings "YYYY-MM-DD" in the outlet's timezone (default Asia/Kolkata).

export const DEFAULT_TZ = 'Asia/Kolkata';

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DMY_RE = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/;

export function isValidIsoDate(s: string): boolean {
  const m = ISO_RE.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

/** Accepts YYYY-MM-DD or DD/MM/YYYY (Indian convention). Returns ISO or null. */
export function parseBusinessDate(s: string): string | null {
  const t = s.trim();
  if (isValidIsoDate(t)) return t;
  const m = DMY_RE.exec(t);
  if (!m) return null;
  const iso = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return isValidIsoDate(iso) ? iso : null;
}

export function todayInTz(tz: string = DEFAULT_TZ, now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function toUtc(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

export function addDays(iso: string, n: number): string {
  return new Date(toUtc(iso) + n * 86400000).toISOString().slice(0, 10);
}

/** b − a in whole days. */
export function diffDays(a: string, b: string): number {
  return Math.round((toUtc(b) - toUtc(a)) / 86400000);
}

/** 0 = Sunday … 6 = Saturday */
export function weekday(iso: string): number {
  return new Date(toUtc(iso)).getUTCDay();
}

export const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = iso.slice(0, 10);
  if (!isValidIsoDate(d)) return iso;
  const [y, m, day] = d.split('-');
  return `${day}/${m}/${y}`;
}

export function formatDateTime(isoTs: string | null | undefined, tz: string = DEFAULT_TZ): string {
  if (!isoTs) return '—';
  const dt = new Date(isoTs);
  if (Number.isNaN(dt.getTime())) return isoTs;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(dt);
  return parts.replace(',', '');
}

/** Business date (in tz) of an ISO timestamp. */
export function businessDateOf(isoTs: string, tz: string = DEFAULT_TZ): string {
  return todayInTz(tz, new Date(isoTs));
}
