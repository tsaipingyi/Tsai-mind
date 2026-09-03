/**
 * Last-seen project trees, so the app opens offline. Plain data only; the
 * project store rebuilds a core TreeStore from it and replays unsent ops.
 */
import type { Change, Contact, Project, TNode } from '@tsai-mind/core';
import type { QueueStorage } from './queue';

export interface ProjectSnapshot {
  project: Project;
  nodes: TNode[];
  contacts: Contact[];
  pending: Change[];
  serverSeq: number;
  /** opIds already applied inside `nodes` (optimistic local edits). */
  appliedOpIds: string[];
  savedAt: string;
}

export interface ProjectListSnapshot {
  rows: unknown[];
  savedAt: string;
}

export class SnapshotStore {
  constructor(
    private readonly storage: QueueStorage,
    private readonly prefix = 'tsaimind.snapshot.',
  ) {}

  async load(projectId: string): Promise<ProjectSnapshot | null> {
    try {
      const raw = await this.storage.getItem(this.prefix + projectId);
      if (!raw) return null;
      const s = JSON.parse(raw) as ProjectSnapshot;
      if (!s || !Array.isArray(s.nodes) || !s.project) return null;
      return { ...s, appliedOpIds: s.appliedOpIds ?? [], pending: s.pending ?? [], contacts: s.contacts ?? [] };
    } catch {
      return null;
    }
  }

  async save(snapshot: Omit<ProjectSnapshot, 'savedAt'>): Promise<void> {
    try {
      await this.storage.setItem(this.prefix + snapshot.project.id, JSON.stringify({ ...snapshot, savedAt: new Date().toISOString() }));
    } catch {
      /* ignore */
    }
  }

  async remove(projectId: string): Promise<void> {
    await this.storage.removeItem(this.prefix + projectId).catch(() => undefined);
  }

  async loadGeneric<T>(key: string): Promise<T | null> {
    try {
      const raw = await this.storage.getItem(this.prefix + key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return null;
    }
  }

  async saveGeneric(key: string, value: unknown): Promise<void> {
    try {
      await this.storage.setItem(this.prefix + key, JSON.stringify(value));
    } catch {
      /* ignore */
    }
  }
}
