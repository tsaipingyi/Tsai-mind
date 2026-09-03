import { describe, expect, it } from 'vitest';
import type { Op } from '@tsai-mind/core';
import { MemoryStorage, OpQueue, isRetryableError, type QueueTransport } from './queue';
import type { OpResult, OpsResponse } from '../api/types';
import { SnapshotStore } from './snapshot';

function op(id: string, projectId = 'p1', extra: Partial<Op> = {}): Op {
  return {
    opId: id,
    clientId: 'c1',
    projectId,
    actor: 'user',
    at: '2026-09-03T00:00:00.000Z',
    type: 'update_node',
    nodeId: 'n1',
    patch: { title: id },
    ...extra,
  } as Op;
}

class NetErr extends Error {
  status = 0;
}

/** Fake server: records each request, answers per op, and can be told to fail. */
class FakeTransport implements QueueTransport {
  calls: { projectId: string; ops: Op[] }[] = [];
  failNext = 0;
  seq = 0;
  reject = new Set<string>();
  async postOps(projectId: string, ops: Op[]): Promise<OpsResponse> {
    if (this.failNext > 0) {
      this.failNext--;
      throw new NetErr('offline');
    }
    this.calls.push({ projectId, ops: [...ops] });
    const results: OpResult[] = ops.map((o) =>
      this.reject.has(o.opId)
        ? { opId: o.opId, ok: false, error: 'version_conflict', message: 'expected version 1, have 2' }
        : { opId: o.opId, ok: true, serverSeq: ++this.seq },
    );
    return { results, serverSeq: this.seq };
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

function make(transport: FakeTransport, storage = new MemoryStorage(), events: ConstructorParameters<typeof OpQueue>[0]['events'] = {}) {
  return new OpQueue({ transport, storage, flushDelayMs: 0, events });
}

describe('OpQueue', () => {
  it('holds ops while offline and flushes them in order when back online', async () => {
    const t = new FakeTransport();
    const q = make(t);
    await q.load();
    q.setOnline(false);
    q.enqueue(op('a'));
    q.enqueue(op('b'));
    q.enqueue(op('c'));
    await tick();
    expect(t.calls).toHaveLength(0);
    expect(q.size).toBe(3);
    q.setOnline(true);
    await q.flush();
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]!.ops.map((o) => o.opId)).toEqual(['a', 'b', 'c']);
    expect(q.size).toBe(0);
  });

  it('batches per project but keeps cross-project FIFO order', async () => {
    const t = new FakeTransport();
    const q = make(t);
    q.setOnline(false);
    q.enqueue(op('a', 'p1'));
    q.enqueue(op('b', 'p1'));
    q.enqueue(op('c', 'p2'));
    q.enqueue(op('d', 'p1'));
    q.setOnline(true);
    await q.flush();
    expect(t.calls.map((c) => [c.projectId, c.ops.map((o) => o.opId)])).toEqual([
      ['p1', ['a', 'b']],
      ['p2', ['c']],
      ['p1', ['d']],
    ]);
  });

  it('retries after a network error without losing or reordering ops', async () => {
    const t = new FakeTransport();
    const errors: string[] = [];
    const q = make(t, undefined, { onNetworkError: (pid) => errors.push(pid) });
    t.failNext = 1;
    q.enqueue(op('a'));
    q.enqueue(op('b'));
    await q.flush();
    expect(errors).toEqual(['p1']);
    expect(q.isOnline).toBe(false);
    expect(q.size).toBe(2);
    expect(t.calls).toHaveLength(0);
    // an edit while offline just queues
    q.enqueue(op('c'));
    await tick();
    expect(t.calls).toHaveLength(0);
    // network comes back
    q.setOnline(true);
    await q.flush();
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]!.ops.map((o) => o.opId)).toEqual(['a', 'b', 'c']);
    expect(q.size).toBe(0);
  });

  it('dedupes by opId', async () => {
    const t = new FakeTransport();
    const q = make(t);
    q.setOnline(false);
    expect(q.enqueue(op('a'))).toBe(true);
    expect(q.enqueue(op('a'))).toBe(false);
    expect(q.enqueue({ ...op('a'), patch: { title: 'other' } } as Op)).toBe(false);
    expect(q.size).toBe(1);
    q.setOnline(true);
    await q.flush();
    expect(t.calls[0]!.ops).toHaveLength(1);
  });

  it('drops a rejected op (409) and marks the project for reload; others still apply', async () => {
    const t = new FakeTransport();
    t.reject.add('b');
    const failed: OpResult[] = [];
    const acked: string[] = [];
    const q = make(t, undefined, {
      onOpFailed: (_pid, r) => failed.push(r),
      onResults: (pid, results, seq) => acked.push(`${pid}:${results.length}:${seq}`),
    });
    q.setOnline(false);
    q.enqueue(op('a'));
    q.enqueue(op('b'));
    q.enqueue(op('c'));
    q.setOnline(true);
    await q.flush();
    expect(failed.map((r) => r.opId)).toEqual(['b']);
    expect(failed[0]!.error).toBe('version_conflict');
    expect(q.needsReload('p1')).toBe(true);
    expect(q.needsReload('p2')).toBe(false);
    expect(q.size).toBe(0);
    expect(acked).toEqual(['p1:3:2']);
    q.clearReload('p1');
    expect(q.needsReload('p1')).toBe(false);
  });

  it('drops a whole batch on a non-retryable request error (e.g. 403) instead of looping', async () => {
    const t = new FakeTransport();
    const bad: QueueTransport = {
      async postOps() {
        const e = new Error('forbidden') as Error & { status: number };
        e.status = 403;
        throw e;
      },
    };
    const failed: string[] = [];
    const q = new OpQueue({ transport: bad, storage: new MemoryStorage(), flushDelayMs: 0, events: { onOpFailed: (_p, r) => failed.push(r.opId) } });
    q.enqueue(op('a'));
    await q.flush();
    expect(failed).toEqual(['a']);
    expect(q.size).toBe(0);
    expect(q.needsReload('p1')).toBe(true);
    expect(t.calls).toHaveLength(0);
  });

  it('persists queued ops and restores them on the next launch', async () => {
    const storage = new MemoryStorage();
    const t1 = new FakeTransport();
    const q1 = make(t1, storage);
    q1.setOnline(false);
    q1.enqueue(op('a'));
    q1.enqueue(op('b', 'p2'));
    await tick();
    // "restart"
    const t2 = new FakeTransport();
    const q2 = make(t2, storage);
    await q2.load();
    expect(q2.pending().map((o) => o.opId)).toEqual(['a', 'b']);
    expect(q2.pending('p2').map((o) => o.opId)).toEqual(['b']);
    await q2.flush();
    expect(t2.calls).toHaveLength(2);
    expect(q2.size).toBe(0);
    expect(JSON.parse(storage.map.get('tsaimind.opqueue')!).ops).toEqual([]);
  });

  it('serialises concurrent flushes', async () => {
    const t = new FakeTransport();
    const q = make(t);
    q.setOnline(false);
    q.enqueue(op('a'));
    q.enqueue(op('b'));
    q.setOnline(true);
    await Promise.all([q.flush(), q.flush(), q.flush()]);
    expect(t.calls).toHaveLength(1);
  });

  it('classifies transport errors', () => {
    expect(isRetryableError(new NetErr('x'))).toBe(true);
    expect(isRetryableError(Object.assign(new Error(), { status: 503 }))).toBe(true);
    expect(isRetryableError(Object.assign(new Error(), { status: 409 }))).toBe(false);
    expect(isRetryableError(Object.assign(new Error(), { status: 401 }))).toBe(false);
  });
});

describe('SnapshotStore', () => {
  it('round-trips a project snapshot', async () => {
    const s = new SnapshotStore(new MemoryStorage());
    const project = { id: 'p1', name: '官网改版', rootNodeId: 'r', createdAt: 'x', archivedAt: null };
    await s.save({ project, nodes: [], contacts: [], pending: [], serverSeq: 7, appliedOpIds: ['a'] });
    const back = await s.load('p1');
    expect(back?.project.name).toBe('官网改版');
    expect(back?.serverSeq).toBe(7);
    expect(back?.appliedOpIds).toEqual(['a']);
    expect(await s.load('nope')).toBeNull();
    await s.remove('p1');
    expect(await s.load('p1')).toBeNull();
  });
});
