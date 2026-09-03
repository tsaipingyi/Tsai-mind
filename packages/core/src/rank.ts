/**
 * Fractional indexing over a base-62 alphabet. Keys are plain strings that
 * sort lexicographically; rankBetween(a, b) returns a key strictly between
 * a and b. null means "no bound" on that side. Keys never end with the
 * minimum digit, so there is always room after any key.
 */
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const BASE = ALPHABET.length;

function digit(ch: string): number {
  const i = ALPHABET.indexOf(ch);
  if (i < 0) throw new Error(`invalid rank char: ${ch}`);
  return i;
}

/** Digit string strictly between a and b, where '' on the right means 1.0. Requires a < b. */
function mid(a: string, b: string): string {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  if (n > 0) return a.slice(0, n) + mid(a.slice(n), b.slice(n));
  const da = a === '' ? 0 : digit(a[0]!);
  const db = b === '' ? BASE : digit(b[0]!);
  if (db - da > 1) return ALPHABET[(da + db) >> 1]!;
  // db === da only when a is '' and b starts with the min digit: descend into b.
  if (db === da) return ALPHABET[da]! + mid('', b.slice(1));
  return ALPHABET[da]! + mid(a.slice(1), '');
}

export function rankBetween(a: string | null, b: string | null): string {
  const lo = a ?? '';
  const hi = b ?? '';
  if (hi !== '' && lo >= hi) throw new Error(`rankBetween: "${lo}" is not < "${hi}"`);
  return mid(lo, hi);
}

export function firstRank(): string {
  return ALPHABET[BASE >> 1]!;
}

/** n ranks placed in order between a and b. */
export function ranksBetween(a: string | null, b: string | null, n: number): string[] {
  const out: string[] = [];
  let prev = a;
  for (let i = 0; i < n; i++) {
    const r = rankBetween(prev, b);
    out.push(r);
    prev = r;
  }
  return out;
}

export function compareRank(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
