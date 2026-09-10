/**
 * Browser-local stand-in for the artifact `db` capability, used when the page runs outside the
 * claude.ai viewer (a static host such as Vercel, or a file opened directly). Implements only the
 * members `persist.ts` calls, with the contract's shapes, on top of localStorage. One browser =
 * one copy of the data; nothing syncs.
 */
import type { DB as CloudDb, DocumentSnapshot, QuerySnapshot } from './types';

const KEY = 'tsaimind.localdb';

type Listener = { kind: 'doc' | 'col'; path: string; next: (snap: never) => void; prev?: Set<string> };

export function localStorageAvailable(): boolean {
  try {
    const k = '__tsaimind_probe__';
    localStorage.setItem(k, '1');
    localStorage.removeItem(k);
    return true;
  } catch {
    return false;
  }
}

export function createLocalDb(): CloudDb {
  const load = (): Record<string, Record<string, unknown>> => {
    try {
      return JSON.parse(localStorage.getItem(KEY) || '{}') as Record<string, Record<string, unknown>>;
    } catch {
      return {};
    }
  };
  const docs = load();
  const persist = () => localStorage.setItem(KEY, JSON.stringify(docs));
  const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));
  const listeners = new Set<Listener>();
  const inCol = (col: string, path: string) => path.startsWith(col + '/') && !path.slice(col.length + 1).includes('/');
  const colDocs = (col: string) => Object.keys(docs).filter((p) => inCol(col, p)).sort();
  const meta = { fromCache: false, hasPendingWrites: false };
  const docSnap = (path: string, override?: Record<string, unknown>): DocumentSnapshot => {
    const data = override !== undefined ? override : docs[path];
    return { id: path.split('/').pop()!, exists: data !== undefined, data: () => clone(data), metadata: meta };
  };
  const colSnap = (l: Listener, changedPath?: string, removed?: Record<string, unknown>): QuerySnapshot => {
    const ids = colDocs(l.path);
    const prev = l.prev ?? new Set<string>();
    const snaps = ids.map((p) => docSnap(p));
    const changes: { type: 'added' | 'modified' | 'removed'; doc: DocumentSnapshot; oldIndex: number; newIndex: number }[] = [];
    ids.forEach((p, i) => {
      if (!prev.has(p)) changes.push({ type: 'added', doc: snaps[i]!, oldIndex: -1, newIndex: i });
      else if (p === changedPath) changes.push({ type: 'modified', doc: snaps[i]!, oldIndex: i, newIndex: i });
    });
    for (const p of prev) if (!ids.includes(p)) changes.push({ type: 'removed', doc: docSnap(p, removed ?? {}), oldIndex: 0, newIndex: -1 });
    l.prev = new Set(ids);
    return { docs: snaps, size: snaps.length, empty: snaps.length === 0, docChanges: () => changes, metadata: meta };
  };
  const notify = (path: string, removed?: Record<string, unknown>) => {
    for (const l of listeners) {
      try {
        if (l.kind === 'doc' && l.path === path) (l.next as (s: DocumentSnapshot) => void)(docSnap(path));
        else if (l.kind === 'col' && inCol(l.path, path)) (l.next as (s: QuerySnapshot) => void)(colSnap(l, path, removed));
      } catch (e) {
        console.error('local db listener threw', e);
      }
    }
  };
  const write = async (path: string, data: Record<string, unknown>) => {
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw { code: 'invalid_argument', message: 'body must be an object' };
    docs[path] = clone(data);
    persist();
    notify(path);
  };
  const assertDoc = (path: string) => {
    if (path.split('/').length % 2 !== 0) throw new TypeError('document path needs an even number of segments: ' + path);
  };
  const assertCol = (path: string) => {
    if (path.split('/').length % 2 !== 1) throw new TypeError('collection path needs an odd number of segments: ' + path);
  };
  const doc = (path: string): ReturnType<CloudDb['doc']> => {
    assertDoc(path);
    return {
      id: path.split('/').pop()!,
      path,
      get: async () => docSnap(path),
      set: (data) => write(path, data),
      update: async (data) => {
        if (!docs[path]) throw { code: 'invalid_argument', message: 'document does not exist' };
        await write(path, { ...docs[path], ...data });
      },
      delete: async () => {
        const removed = docs[path];
        delete docs[path];
        persist();
        notify(path, removed);
      },
      onSnapshot: (next) => {
        const l: Listener = { kind: 'doc', path, next: next as never };
        listeners.add(l);
        setTimeout(() => listeners.has(l) && next(docSnap(path)), 0);
        return () => listeners.delete(l);
      },
    } as ReturnType<CloudDb['doc']>;
  };
  const collection = (path: string): ReturnType<CloudDb['collection']> => {
    assertCol(path);
    const l0: Listener = { kind: 'col', path, next: (() => undefined) as never };
    return {
      path,
      doc: (id?: string) => doc(`${path}/${id ?? crypto.randomUUID()}`),
      get: async () => colSnap({ ...l0 }),
      onSnapshot: (next: (snap: QuerySnapshot) => void) => {
        const l: Listener = { kind: 'col', path, next: next as never };
        listeners.add(l);
        setTimeout(() => listeners.has(l) && next(colSnap(l)), 0);
        return () => listeners.delete(l);
      },
    } as unknown as ReturnType<CloudDb['collection']>;
  };
  return { doc, collection } as CloudDb;
}
