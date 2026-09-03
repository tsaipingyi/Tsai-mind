import type { Sql } from '../db.js';
import type { Config } from '../config.js';
import type { Hub } from '../realtime.js';
import type { PushSender } from '../push.js';
import { toISODate } from '@tsai-mind/core';

export interface Logger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}

export interface Ctx {
  sql: Sql;
  hub: Hub;
  config: Config;
  log: Logger;
  /** Push sender for owner notifications (tests inject a capturing transport). */
  push: PushSender;
}

export const nowIso = (): string => new Date().toISOString();

/** Today's date (YYYY-MM-DD) in the configured timezone. */
export function todayIso(ctx: Pick<Ctx, 'config'>, at: Date = new Date()): string {
  return toISODate(at, ctx.config.tzName);
}

export function currentYear(ctx: Pick<Ctx, 'config'>): number {
  return Number(todayIso(ctx).slice(0, 4));
}

/** Serialize work per project so ops are applied in order (single instance, in-process). */
const locks = new Map<string, Promise<unknown>>();
export async function withProjectLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(projectId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  locks.set(projectId, run.catch(() => {}));
  try {
    return await run;
  } finally {
    if (locks.get(projectId) === run) locks.delete(projectId);
  }
}
