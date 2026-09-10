/**
 * `window.claude.use(name)` wrapped for absence: resolves the namespace or `null` — when the page
 * runs outside a Claude viewer (no `window.claude` at all), when the viewer does not serve the
 * capability, or when `use` itself throws/rejects. The promise is memoized per name like the
 * runtime's own.
 */
import type { CapabilityMap } from './types';

interface ClaudeLike {
  use?: (name: string) => Promise<unknown>;
}

const memo = new Map<string, Promise<unknown>>();

export function useCapability<K extends keyof CapabilityMap>(name: K): Promise<CapabilityMap[K] | null> {
  let p = memo.get(name);
  if (!p) {
    p = (async () => {
      try {
        const c = (globalThis as unknown as { claude?: ClaudeLike }).claude;
        if (!c || typeof c.use !== 'function') return null;
        const ns = await c.use(name);
        return ns ?? null;
      } catch {
        return null;
      }
    })();
    memo.set(name, p);
  }
  return p as Promise<CapabilityMap[K] | null>;
}

/** True when a `window.claude.use` exists at all (a viewer or the platform's top-level host). */
export function hasClaudeRuntime(): boolean {
  const c = (globalThis as unknown as { claude?: ClaudeLike }).claude;
  return !!c && typeof c.use === 'function';
}
