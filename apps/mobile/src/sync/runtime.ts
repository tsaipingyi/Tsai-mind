/**
 * Wires the React-free queue/snapshot modules to the device: fetch transport,
 * AsyncStorage, network signal. Stores register their handlers here so the
 * queue does not import UI code.
 */
import { create } from 'zustand';
import { api } from '../api/client';
import { kv } from '../lib/storage';
import { OpQueue, type QueueEvents } from './queue';
import { SnapshotStore } from './snapshot';
import { onNetwork } from './network';

const handlers: QueueEvents = {};

export function setQueueHandlers(h: QueueEvents): void {
  Object.assign(handlers, h);
}

interface SyncState {
  online: boolean;
  queued: number;
}

export const useSync = create<SyncState>(() => ({ online: true, queued: 0 }));

export const queue = new OpQueue({
  transport: { postOps: (pid, ops) => api.postOps(pid, ops) },
  storage: kv,
  events: {
    onResults: (pid, results, seq) => handlers.onResults?.(pid, results, seq),
    onOpFailed: (pid, r) => handlers.onOpFailed?.(pid, r),
    onNetworkError: (pid, e) => {
      useSync.setState({ online: false });
      handlers.onNetworkError?.(pid, e);
    },
    onSizeChange: (n) => {
      useSync.setState({ queued: n });
      handlers.onSizeChange?.(n);
    },
  },
});

export const snapshots = new SnapshotStore(kv);

let wired = false;
export function startSync(): void {
  if (wired) return;
  wired = true;
  onNetwork((online) => {
    useSync.setState({ online });
    queue.setOnline(online);
  });
}

/** Called after a successful request: if we thought we were offline, we are not. */
export function noteOnline(): void {
  if (!queue.isOnline) queue.setOnline(true);
  if (!useSync.getState().online) useSync.setState({ online: true });
}

const NODE_INDEX_KEY = 'tsaimind.nodeIndex';
let nodeIndex: Record<string, string> | null = null;

/** nodeId → projectId, so /node/[id] can open offline. */
export async function rememberNodes(projectId: string, nodeIds: string[]): Promise<void> {
  const idx = await loadNodeIndex();
  let changed = false;
  for (const id of nodeIds) {
    if (idx[id] !== projectId) {
      idx[id] = projectId;
      changed = true;
    }
  }
  if (changed) await kv.setItem(NODE_INDEX_KEY, JSON.stringify(idx)).catch(() => undefined);
}

export async function projectOfNode(nodeId: string): Promise<string | null> {
  const idx = await loadNodeIndex();
  return idx[nodeId] ?? null;
}

async function loadNodeIndex(): Promise<Record<string, string>> {
  if (nodeIndex) return nodeIndex;
  try {
    const raw = await kv.getItem(NODE_INDEX_KEY);
    nodeIndex = raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    nodeIndex = {};
  }
  return nodeIndex;
}
