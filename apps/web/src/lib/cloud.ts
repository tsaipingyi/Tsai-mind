/**
 * Cloud-persistence status, read defensively from `src/cloud/` (owned by the cloud-mode work).
 *
 * Contract (type-only — nothing here imports the module statically, so the build stays green when the
 * directory is absent): `src/cloud/status.ts` exports a zustand store `useCloudStatus` whose state is
 * `{ state: 'loading' | 'ready' | 'saving' | 'offline' | 'error', message?: string }`, and
 * `src/cloud/mode.ts` exports `isCloud` (the VITE_CLOUD build flag). Only these two light modules are
 * globbed — `src/cloud/index.ts` pulls in the whole persistence layer and is loaded lazily by demo/install.
 */
export type CloudState = 'loading' | 'ready' | 'saving' | 'offline' | 'error';

export interface CloudStatus {
  state: CloudState;
  /** error text (or any extra detail) */
  message?: string;
}

type StatusModule = { useCloudStatus?: (() => unknown) & { getState?: () => unknown } };
type ModeModule = { isCloud?: boolean };

const statusModules = import.meta.glob<StatusModule>('../cloud/status.ts', { eager: true });
const modeModules = import.meta.glob<ModeModule>('../cloud/mode.ts', { eager: true });
const realHook: (() => unknown) | null = Object.values(statusModules).find((m) => typeof m?.useCloudStatus === 'function')?.useCloudStatus ?? null;
/** true only in a cloud build (`VITE_CLOUD=true`); false when the module is missing. */
export const isCloudBuild: boolean = Object.values(modeModules).some((m) => m?.isCloud === true);

const STATES: CloudState[] = ['loading', 'ready', 'saving', 'offline', 'error'];

function normalize(v: unknown): CloudStatus | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const raw = o.state ?? o.status;
  if (typeof raw !== 'string' || !STATES.includes(raw as CloudState)) return null;
  const message = typeof o.message === 'string' ? o.message : typeof o.error === 'string' ? o.error : undefined;
  return message ? { state: raw as CloudState, message } : { state: raw as CloudState };
}

/** null outside cloud builds (no pill is shown). */
export function useCloudStatus(): CloudStatus | null {
  // `realHook` is fixed for the life of the bundle, so the hook call order is stable
  const v = realHook ? realHook() : null;
  return isCloudBuild ? normalize(v) : null;
}

export function cloudStatusLabel(s: CloudStatus): string {
  switch (s.state) {
    case 'loading':
      return '连接云端…';
    case 'saving':
      return '保存中…';
    case 'ready':
      return '已保存';
    case 'offline':
      return '离线（本页数据不会保存）';
    case 'error':
      return s.message || '保存失败';
    default:
      return '';
  }
}

/** The custom event cloud mode fires after it pulls a newer copy of a project (`detail.projectId`). */
export const PROJECT_CHANGED_EVENT = 'tsaimind:project-changed';
