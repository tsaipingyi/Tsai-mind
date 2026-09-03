import type { ISODate } from './types.js';

export function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** YYYY-MM-DD for a Date in a given IANA timezone (defaults to the runtime's zone). */
export function toISODate(d: Date, timeZone?: string): ISODate {
  if (!timeZone) return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function addDays(iso: ISODate, days: number): ISODate {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const t = Date.UTC(y, m - 1, d + days);
  const r = new Date(t);
  return `${r.getUTCFullYear()}-${pad2(r.getUTCMonth() + 1)}-${pad2(r.getUTCDate())}`;
}

/** Whole days from a to b (b - a). */
export function daysBetween(a: ISODate, b: ISODate): number {
  const [ay, am, ad] = a.split('-').map(Number) as [number, number, number];
  const [by, bm, bd] = b.split('-').map(Number) as [number, number, number];
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

export function isISODate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}

/** "9/15" style short date for display; falls back to ISO when the year differs. */
export function shortDate(iso: ISODate, year: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return y === year ? `${m}/${d}` : iso;
}
