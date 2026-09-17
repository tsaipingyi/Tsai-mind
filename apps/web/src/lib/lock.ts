/**
 * Page lock: a password asked for when the page is opened. Only a salted PBKDF2-SHA256 hash is
 * stored (in the account settings); the password itself never leaves the browser. Once unlocked,
 * the tab stays unlocked until it is closed (sessionStorage) or 锁定 is pressed.
 *
 * This is a screen lock, not encryption: in the cloud edition the data is already private to the
 * claude.ai owner, and in the browser-local edition it lives only in that browser.
 */
export interface PageLock {
  /** hex */
  salt: string;
  /** hex, PBKDF2-SHA256 */
  hash: string;
  iter: number;
}

const UNLOCK_KEY = 'tsaimind.unlocked';
const ITER = 120_000;
/** an unlock is good for the tab session, at most this long */
const MAX_UNLOCK_MS = 12 * 60 * 60 * 1000;

function hex(bytes: ArrayBuffer | Uint8Array): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function unhex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function derive(password: string, salt: Uint8Array, iter: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password.normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations: iter }, key, 256);
  return hex(bits);
}

export async function makeLock(password: string): Promise<PageLock> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { salt: hex(salt), hash: await derive(password, salt, ITER), iter: ITER };
}

export async function verifyLock(lock: PageLock, password: string): Promise<boolean> {
  if (!lock.salt || !lock.hash) return false;
  const got = await derive(password, unhex(lock.salt), lock.iter || ITER);
  if (got.length !== lock.hash.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ lock.hash.charCodeAt(i);
  return diff === 0;
}

/** true when this tab already unlocked this exact lock (a changed password locks again) */
export function isUnlocked(lock: PageLock): boolean {
  try {
    const v = sessionStorage.getItem(UNLOCK_KEY);
    if (!v) return false;
    const [hash, at] = v.split(':');
    return hash === lock.hash && Date.now() - Number(at) < MAX_UNLOCK_MS;
  } catch {
    return false;
  }
}

export function rememberUnlocked(lock: PageLock): void {
  try {
    sessionStorage.setItem(UNLOCK_KEY, `${lock.hash}:${Date.now()}`);
  } catch {
    /* private mode: the lock simply asks again after a reload */
  }
}

export function forgetUnlocked(): void {
  try {
    sessionStorage.removeItem(UNLOCK_KEY);
  } catch {
    /* ignore */
  }
}
