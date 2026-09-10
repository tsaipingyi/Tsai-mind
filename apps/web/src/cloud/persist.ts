/**
 * Write-through persistence of the DemoServer's state into the artifact's `db` capability.
 *
 * Document layout (each a plain JSON object, kept well under the 256 KiB cap):
 *   meta/account        { account, tokens, firstRun, updatedAt }
 *   meta/contacts       { contacts, updatedAt }
 *   projects/<id>       { project, nodes (live + deleted ≤ 30 days), dependencies, changes, batches,
 *                         activity (last 200), opLog (last 100 ops with inverses), serverSeq, updatedAt }
 *   chats/<sessionId>   { session, messages, updatedAt }
 *
 * Boot: read everything, or seed a first-run state when the store is empty. Writes: the server calls
 * `onDirty(kind, id)` after every mutation; each document is debounced 400 ms and written whole with
 * `set()`. `unavailable` is retried once; other failures surface in `useCloudStatus`. Cross-device:
 * `onSnapshot` on `projects` / `meta/*` / `chats`; a confirmed snapshot newer than what this page
 * knows replaces the in-memory state and reloads the open project.
 */
import type { ChatDoc, DemoServer, DirtyKind, ProjectDoc } from '../demo/mockApi';
import { useProject } from '../state/project';
import { toast } from '../state/toast';
import { useCapability } from './capabilities';
import { createLocalDb, localStorageAvailable } from './localDb';
import { CLOUD_DOCS } from './mode';
import { STARTER_OUTLINE, STARTER_PROJECT_NAME } from './seed';
import { LOCAL_MESSAGE, OFFLINE_MESSAGE, setCloudStatus, useCloudStatus } from './status';
import type { DB, DbError, DocumentSnapshot, QuerySnapshot } from './types';

const DEBOUNCE_MS = 400;
const MAX_DOC_BYTES = 240 * 1024;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Fired on `window` when another device changed a project (or deleted it): `detail = { projectId,
 * removed }`. App.tsx reloads the open project on it; a removed project is unloaded here.
 */
export const PROJECT_CHANGED_EVENT = 'tsaimind:project-changed';

type DocKey = string; // 'meta/account' | 'meta/contacts' | 'projects/<id>' | 'chats/<id>'

function bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

function errCode(e: unknown): string {
  const c = (e as DbError | undefined)?.code;
  return typeof c === 'string' ? c : 'unavailable';
}

function chineseError(code: string, e: unknown): string {
  switch (code) {
    case 'quota_exceeded':
      return '云端存储已满，这次改动没有保存';
    case 'resource_exhausted':
      return '云端写入太频繁，稍后会自动重试';
    case 'invalid_argument':
      return '云端拒绝了这份数据，改动没有保存';
    case 'revoked':
    case 'not_granted':
    case 'capability_disabled':
    case 'capability_removed':
      return '云端存储不可用，改动只在本页内存里';
    case 'project_too_large':
      return '项目太大（超过 240 KB），这次改动没有保存到云端';
    default:
      return `保存失败：${(e as Error | undefined)?.message ?? code}`;
  }
}

export class CloudPersister {
  db: DB | null = null;
  private booted = false;
  /** data lives in this browser only (no artifact db) */
  private local = false;
  private timers = new Map<DocKey, ReturnType<typeof setTimeout>>();
  private inflight = new Set<DocKey>();
  /** serialized body (without updatedAt) we last wrote or imported, to skip no-op writes */
  private lastBody = new Map<DocKey, string>();
  /** updatedAt of the version we hold, to ignore our own snapshots and older remote ones */
  private known = new Map<DocKey, string>();
  private tooLargeWarned = new Set<DocKey>();
  private unsubs: (() => void)[] = [];
  private hasError = false;

  constructor(private server: DemoServer) {}

  // ----- boot -----

  async boot(): Promise<void> {
    this.server.onDirty = (kind, id) => this.markDirty(kind, id);
    let db = await useCapability('db');
    if (!db && localStorageAvailable()) {
      // outside the claude.ai viewer (a static host, a saved file): keep the data in this browser
      db = createLocalDb();
      this.local = true;
    }
    if (!db) {
      await this.seedStarter();
      setCloudStatus({ state: 'offline', message: OFFLINE_MESSAGE, firstRun: true });
      this.booted = true;
      return;
    }
    this.db = db;
    try {
      await this.load();
    } catch (e) {
      // the contract: retry `unavailable` once after a short randomized delay
      if (errCode(e) === 'unavailable') {
        await sleep(500 + Math.random() * 1000);
        try {
          await this.load();
        } catch (e2) {
          return this.failBoot(e2);
        }
      } else return this.failBoot(e);
    }
    this.subscribe();
    this.installFlushHooks();
    this.booted = true;
    if (!this.hasError) setCloudStatus({ state: this.local ? 'local' : 'ready', message: this.local ? LOCAL_MESSAGE : undefined });
  }

  private async failBoot(e: unknown): Promise<void> {
    const code = errCode(e);
    this.db = null;
    await this.seedStarter();
    setCloudStatus({ state: 'error', message: `${chineseError(code, e)}。数据只在本页内存里。`, firstRun: true });
    this.booted = true;
  }

  private async load(): Promise<void> {
    const db = this.db!;
    const [acc, contacts, projects, chats] = await Promise.all([
      db.doc(CLOUD_DOCS.account).get(),
      db.doc(CLOUD_DOCS.contacts).get(),
      db.collection(CLOUD_DOCS.projects).get(),
      db.collection(CLOUD_DOCS.chats).get(),
    ]);
    if (!acc.exists) {
      // empty store: first run
      await this.seedStarter();
      setCloudStatus({ firstRun: true });
      this.markDirty('account', 'account');
      this.markDirty('contacts', 'contacts');
      return;
    }
    this.importAccount(acc);
    if (contacts.exists) this.importContacts(contacts);
    for (const d of projects.docs) this.importProject(d);
    for (const d of chats.docs) this.importChat(d);
  }

  private async seedStarter(): Promise<void> {
    if (this.server.projectIds().length) return;
    const res = await this.server.handle({ method: 'POST', url: '/api/projects', body: JSON.stringify({ name: STARTER_PROJECT_NAME, outline: STARTER_OUTLINE }) });
    if (!res.ok) console.warn('cloud: could not seed the starter project', await res.text());
  }

  // ----- import (snapshot → memory) -----

  private bodyOf(data: Record<string, unknown>): string {
    const { updatedAt: _u, ...rest } = data;
    void _u;
    return JSON.stringify(rest);
  }

  private remember(key: DocKey, data: Record<string, unknown>): void {
    this.known.set(key, String(data.updatedAt ?? ''));
    this.lastBody.set(key, this.bodyOf(data));
  }

  private importAccount(snap: DocumentSnapshot): void {
    const data = snap.data();
    if (!data) return;
    this.server.importAccountDoc(data);
    setCloudStatus({ firstRun: data.firstRun === true });
    this.remember(CLOUD_DOCS.account, data);
  }

  private importContacts(snap: DocumentSnapshot): void {
    const data = snap.data();
    if (!data) return;
    this.server.importContactsDoc(data);
    this.remember(CLOUD_DOCS.contacts, data);
  }

  private importProject(snap: DocumentSnapshot): void {
    const data = snap.data();
    if (!data) return;
    this.server.importProjectDoc(data as unknown as ProjectDoc);
    this.remember(`${CLOUD_DOCS.projects}/${snap.id}`, data);
  }

  private importChat(snap: DocumentSnapshot): void {
    const data = snap.data();
    if (!data) return;
    this.server.importChatDoc(data as unknown as ChatDoc);
    this.remember(`${CLOUD_DOCS.chats}/${snap.id}`, data);
  }

  // ----- cross-device -----

  private subscribe(): void {
    const db = this.db!;
    const onError = (e: DbError) => {
      console.warn('cloud: subscription ended', e);
      if (e.code === 'revoked') {
        this.db = null;
        setCloudStatus({ state: 'error', message: chineseError('revoked', e) });
      }
    };
    // a remote version wins only when it is confirmed, newer than ours, and we have nothing unsaved for it
    const isNewer = (key: DocKey, snap: DocumentSnapshot): boolean => {
      if (snap.metadata.hasPendingWrites || !snap.exists) return false;
      if (this.timers.has(key) || this.inflight.has(key)) return false;
      const updatedAt = String(snap.data()?.updatedAt ?? '');
      const known = this.known.get(key);
      return !known || updatedAt > known;
    };
    this.unsubs.push(
      db.doc(CLOUD_DOCS.account).onSnapshot((snap) => {
        if (!isNewer(CLOUD_DOCS.account, snap)) return;
        this.importAccount(snap);
        void import('../state/session').then(({ useSession }) => useSession.getState().bootstrap());
      }, onError),
      db.doc(CLOUD_DOCS.contacts).onSnapshot((snap) => {
        if (!isNewer(CLOUD_DOCS.contacts, snap)) return;
        this.importContacts(snap);
        const proj = useProject.getState();
        if (proj.projectId) void proj.reload();
      }, onError),
      db.collection(CLOUD_DOCS.projects).onSnapshot((snap: QuerySnapshot) => {
        if (snap.metadata.hasPendingWrites) return;
        for (const ch of snap.docChanges()) {
          const id = ch.doc.id;
          const key = `${CLOUD_DOCS.projects}/${id}`;
          if (ch.type === 'removed') {
            if (this.timers.has(key) || this.inflight.has(key)) continue;
            if (!this.server.removeProject(id)) continue;
            this.known.delete(key);
            this.lastBody.delete(key);
            this.notifyProject(id, true);
            continue;
          }
          if (!isNewer(key, ch.doc)) continue;
          this.importProject(ch.doc);
          this.notifyProject(id, false);
        }
      }, onError),
      db.collection(CLOUD_DOCS.chats).onSnapshot((snap: QuerySnapshot) => {
        if (snap.metadata.hasPendingWrites) return;
        for (const ch of snap.docChanges()) {
          const key = `${CLOUD_DOCS.chats}/${ch.doc.id}`;
          if (ch.type === 'removed') {
            if (this.timers.has(key) || this.inflight.has(key)) continue;
            this.server.removeChat(ch.doc.id);
            this.known.delete(key);
            this.lastBody.delete(key);
            continue;
          }
          if (isNewer(key, ch.doc)) this.importChat(ch.doc);
        }
      }, onError),
    );
  }

  private notifyProject(projectId: string, removed: boolean): void {
    // App.tsx listens to the event and reloads the open project; a removal has no listener, so unload here
    const proj = useProject.getState();
    if (removed && proj.projectId === projectId) proj.unload();
    try {
      window.dispatchEvent(new CustomEvent(PROJECT_CHANGED_EVENT, { detail: { projectId, removed } }));
    } catch {
      /* ignore */
    }
  }

  // ----- write-through -----

  markDirty(kind: DirtyKind, id: string): void {
    let key: DocKey;
    switch (kind) {
      case 'account':
        key = CLOUD_DOCS.account;
        break;
      case 'contacts':
        key = CLOUD_DOCS.contacts;
        break;
      case 'project':
      case 'project-delete':
        key = `${CLOUD_DOCS.projects}/${id}`;
        break;
      case 'chat':
      case 'chat-delete':
        key = `${CLOUD_DOCS.chats}/${id}`;
        break;
    }
    if (this.booted && kind === 'project' && useCloudStatus.getState().firstRun) {
      setCloudStatus({ firstRun: false });
      this.markDirty('account', 'account');
    }
    if (!this.db) return;
    const t = this.timers.get(key);
    if (t) clearTimeout(t);
    this.timers.set(
      key,
      setTimeout(() => void this.flush(key), DEBOUNCE_MS),
    );
    this.refreshState();
  }

  /** The document as it should be stored now, or null when it no longer exists. */
  private serialize(key: DocKey): Record<string, unknown> | null {
    if (key === CLOUD_DOCS.account) return { ...this.server.exportAccountDoc(), firstRun: useCloudStatus.getState().firstRun };
    if (key === CLOUD_DOCS.contacts) return this.server.exportContactsDoc();
    const [col, id] = key.split('/') as [string, string];
    if (col === CLOUD_DOCS.projects) return this.server.exportProjectDoc(id) as unknown as Record<string, unknown> | null;
    if (col === CLOUD_DOCS.chats) return this.server.exportChatDoc(id) as unknown as Record<string, unknown> | null;
    return null;
  }

  private async flush(key: DocKey): Promise<void> {
    const t = this.timers.get(key);
    if (t) clearTimeout(t);
    this.timers.delete(key);
    const db = this.db;
    if (!db) return;
    if (this.inflight.has(key)) {
      // a write for this doc is still running; come back after it
      this.markDirty(...this.kindOf(key));
      return;
    }
    const doc = this.serialize(key);
    if (doc && key.startsWith(`${CLOUD_DOCS.projects}/`) && bytes(JSON.stringify(doc)) > MAX_DOC_BYTES) {
      this.hasError = true;
      setCloudStatus({ state: 'error', message: chineseError('project_too_large', null) });
      if (!this.tooLargeWarned.has(key)) {
        this.tooLargeWarned.add(key);
        toast(chineseError('project_too_large', null), 'error');
      }
      return;
    }
    this.tooLargeWarned.delete(key);
    const body = doc ? this.bodyOf(doc) : '';
    if (doc && this.lastBody.get(key) === body) {
      this.refreshState();
      return;
    }
    this.inflight.add(key);
    this.refreshState();
    let retried = false;
    for (;;) {
      try {
        if (doc) await db.doc(key).set(doc);
        else await db.doc(key).delete();
        if (doc) this.remember(key, doc);
        else {
          this.known.delete(key);
          this.lastBody.delete(key);
        }
        this.hasError = false;
        setCloudStatus({ savedAt: new Date().toISOString(), message: undefined });
        break;
      } catch (e) {
        const code = errCode(e);
        if (code === 'unavailable' && !retried) {
          retried = true;
          await sleep(500 + Math.random() * 1000);
          continue;
        }
        this.hasError = true;
        setCloudStatus({ state: 'error', message: chineseError(code, e) });
        console.warn('cloud: write failed', key, e);
        if (code === 'revoked' || code === 'not_granted' || code === 'capability_disabled' || code === 'capability_removed') this.db = null;
        break;
      }
    }
    this.inflight.delete(key);
    this.refreshState();
  }

  private kindOf(key: DocKey): [DirtyKind, string] {
    if (key === CLOUD_DOCS.account) return ['account', 'account'];
    if (key === CLOUD_DOCS.contacts) return ['contacts', 'contacts'];
    const [col, id] = key.split('/') as [string, string];
    return [col === CLOUD_DOCS.projects ? 'project' : 'chat', id];
  }

  private refreshState(): void {
    if (!this.db || !this.booted) return;
    if (this.hasError) return; // sticky until the next successful write
    const busy = this.timers.size > 0 || this.inflight.size > 0;
    const cur = useCloudStatus.getState().state;
    const next = busy ? 'saving' : this.local ? 'local' : 'ready';
    if (cur !== next) setCloudStatus({ state: next });
  }

  /** Best effort: write everything that is still debounced (page hidden / unloading). */
  flushAll(): void {
    for (const key of [...this.timers.keys()]) void this.flush(key);
  }

  private installFlushHooks(): void {
    const onHide = () => {
      if (document.visibilityState === 'hidden') this.flushAll();
    };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', () => this.flushAll());
  }
}

let persister: CloudPersister | null = null;

/** Start persistence for the server; resolves once the in-memory state is loaded (or offline). */
export function bootCloudPersistence(server: DemoServer): Promise<void> {
  persister = new CloudPersister(server);
  return persister.boot();
}

export function cloudPersister(): CloudPersister | null {
  return persister;
}
