/**
 * Persisted FIFO of outgoing Ops. No React, no RN imports: the transport and
 * storage are injected so it runs in Node for tests and on device with
 * AsyncStorage + fetch.
 *
 * Rules (docs/DESIGN.md §6):
 * - every local edit is enqueued; the UI already applied it optimistically
 * - when online, ops are flushed in FIFO order, batched per project
 * - a network failure keeps the ops and marks us offline; the next
 *   setOnline(true) / flush() retries
 * - the server answers per op; a failed op (409 version conflict, cycle, ...)
 *   is dropped and the project is marked for reload so the UI re-syncs
 * - duplicates (same opId) are ignored
 */
import type { Op } from '@tsai-mind/core';
import type { OpResult, OpsResponse } from '../api/types';

export interface QueueTransport {
  postOps(projectId: string, ops: Op[]): Promise<OpsResponse>;
}

export interface QueueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface QueueEvents {
  /** Server accepted (or rejected per-op) a batch. Called once per batch. */
  onResults?: (projectId: string, results: OpResult[], serverSeq: number) => void;
  /** An op was dropped because the server refused it. */
  onOpFailed?: (projectId: string, result: OpResult) => void;
  /** Transport failed (offline); ops kept. */
  onNetworkError?: (projectId: string, error: unknown) => void;
  /** Number of queued ops changed. */
  onSizeChange?: (size: number) => void;
}

export interface QueueOptions {
  transport: QueueTransport;
  storage: QueueStorage;
  storageKey?: string;
  events?: QueueEvents;
  /** Debounce before a flush after enqueue (ms). 0 = flush on next microtask. */
  flushDelayMs?: number;
  /** Max ops per request. */
  batchSize?: number;
  /** Injected for tests. */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (h: unknown) => void;
}

/** Treat these transport errors as "offline": keep the ops and retry later. */
export function isRetryableError(e: unknown): boolean {
  const status = (e as { status?: number } | null)?.status;
  if (status === 0 || status === undefined) return true; // fetch threw
  if (status === 408 || status === 429) return true;
  return status >= 500;
}

export class OpQueue {
  private ops: Op[] = [];
  private online = true;
  private flushing: Promise<void> | null = null;
  private timer: unknown = null;
  private loaded = false;
  private readonly reloadNeeded = new Set<string>();
  private readonly key: string;
  private readonly events: QueueEvents;
  private readonly flushDelay: number;
  private readonly batchSize: number;
  private readonly setT: (fn: () => void, ms: number) => unknown;
  private readonly clearT: (h: unknown) => void;

  constructor(private readonly opts: QueueOptions) {
    this.key = opts.storageKey ?? 'tsaimind.opqueue';
    this.events = opts.events ?? {};
    this.flushDelay = opts.flushDelayMs ?? 150;
    this.batchSize = opts.batchSize ?? 50;
    this.setT = opts.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearT = opts.clearTimeoutFn ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /** Restore persisted ops (call once at startup, before enqueue). */
  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await this.opts.storage.getItem(this.key);
      if (raw) {
        const parsed = JSON.parse(raw) as { ops?: Op[]; reload?: string[] };
        const seen = new Set<string>();
        for (const op of parsed.ops ?? []) {
          if (op && typeof op.opId === 'string' && !seen.has(op.opId)) {
            seen.add(op.opId);
            this.ops.push(op);
          }
        }
        for (const p of parsed.reload ?? []) this.reloadNeeded.add(p);
      }
    } catch {
      /* corrupt store: start empty */
    }
    this.events.onSizeChange?.(this.ops.length);
  }

  get size(): number {
    return this.ops.length;
  }

  get isOnline(): boolean {
    return this.online;
  }

  has(opId: string): boolean {
    return this.ops.some((o) => o.opId === opId);
  }

  pending(projectId?: string): Op[] {
    return projectId ? this.ops.filter((o) => o.projectId === projectId) : [...this.ops];
  }

  needsReload(projectId: string): boolean {
    return this.reloadNeeded.has(projectId);
  }

  clearReload(projectId: string): void {
    if (this.reloadNeeded.delete(projectId)) void this.persist();
  }

  /** Enqueue a local op. Returns false when it was already queued. */
  enqueue(op: Op): boolean {
    if (this.has(op.opId)) return false;
    this.ops.push(op);
    this.events.onSizeChange?.(this.ops.length);
    void this.persist();
    this.schedule();
    return true;
  }

  setOnline(online: boolean): void {
    const was = this.online;
    this.online = online;
    if (online && !was) {
      this.cancelTimer();
      void this.flush();
    }
  }

  /** Drop everything (logout). */
  async clear(): Promise<void> {
    this.cancelTimer();
    this.ops = [];
    this.reloadNeeded.clear();
    this.events.onSizeChange?.(0);
    await this.opts.storage.removeItem(this.key);
  }

  /**
   * Send queued ops now. Serialised: concurrent callers await the same run.
   * Sends batches in FIFO order; a batch is the longest run of consecutive ops
   * for the same project, so cross-project order is preserved.
   */
  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.cancelTimer();
    this.flushing = this.run().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async run(): Promise<void> {
    while (this.online && this.ops.length) {
      const batch = this.nextBatch();
      const pid = batch[0]!.projectId;
      let res: OpsResponse;
      try {
        res = await this.opts.transport.postOps(pid, batch);
      } catch (e) {
        if (isRetryableError(e)) {
          this.online = false;
          this.events.onNetworkError?.(pid, e);
          return;
        }
        // 4xx on the whole request (bad token, malformed): drop the batch so we don't loop forever
        this.remove(batch.map((o) => o.opId));
        this.reloadNeeded.add(pid);
        for (const op of batch) this.events.onOpFailed?.(pid, { opId: op.opId, ok: false, error: 'rejected', message: String((e as Error)?.message ?? e) });
        await this.persist();
        continue;
      }
      // Ops the server did not mention are treated as accepted (defensive; the server answers every op).
      const results = Array.isArray(res?.results) ? res.results : [];
      let failed = false;
      for (const r of results) {
        if (!r.ok) {
          failed = true;
          this.events.onOpFailed?.(pid, r);
        }
      }
      if (failed) this.reloadNeeded.add(pid);
      this.remove(batch.map((o) => o.opId));
      await this.persist();
      this.events.onResults?.(pid, results, typeof res?.serverSeq === 'number' ? res.serverSeq : -1);
    }
  }

  private nextBatch(): Op[] {
    const pid = this.ops[0]!.projectId;
    const out: Op[] = [];
    for (const op of this.ops) {
      if (op.projectId !== pid || out.length >= this.batchSize) break;
      out.push(op);
    }
    return out;
  }

  private remove(opIds: string[]): void {
    const set = new Set(opIds);
    this.ops = this.ops.filter((o) => !set.has(o.opId));
    this.events.onSizeChange?.(this.ops.length);
  }

  private schedule(): void {
    if (!this.online || this.timer) return;
    if (this.flushDelay <= 0) {
      this.timer = true;
      void Promise.resolve().then(() => {
        this.timer = null;
        void this.flush();
      });
      return;
    }
    this.timer = this.setT(() => {
      this.timer = null;
      void this.flush();
    }, this.flushDelay);
  }

  private cancelTimer(): void {
    if (this.timer && this.timer !== true) this.clearT(this.timer);
    this.timer = null;
  }

  private persist(): Promise<void> {
    return this.opts.storage.setItem(this.key, JSON.stringify({ ops: this.ops, reload: [...this.reloadNeeded] })).catch(() => undefined);
  }
}

/** In-memory storage for tests and as a fallback when the platform store is unavailable. */
export class MemoryStorage implements QueueStorage {
  readonly map = new Map<string, string>();
  async getItem(k: string): Promise<string | null> {
    return this.map.get(k) ?? null;
  }
  async setItem(k: string, v: string): Promise<void> {
    this.map.set(k, v);
  }
  async removeItem(k: string): Promise<void> {
    this.map.delete(k);
  }
}
