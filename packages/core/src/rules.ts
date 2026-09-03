import type { Actor, NodePatch, Op } from './types.js';

/**
 * Which edits need the owner's confirmation when made by Claude.
 * "delete" and "status_done" are pseudo-fields.
 */
export type KeyField = 'dueDate' | 'startDate' | 'ownerId' | 'delete' | 'status_done';

export const DEFAULT_KEY_FIELDS: readonly KeyField[] = ['dueDate', 'startDate', 'ownerId', 'delete', 'status_done'];

export interface ConfirmationSettings {
  /** When false, Claude's edits always apply directly. */
  requireConfirmation: boolean;
  keyFields: readonly KeyField[];
}

export const DEFAULT_SETTINGS: ConfirmationSettings = {
  requireConfirmation: true,
  keyFields: DEFAULT_KEY_FIELDS,
};

/** Split a patch into the part that applies directly and the part that needs confirmation. */
export function splitPatch(
  patch: NodePatch,
  actor: Actor,
  settings: ConfirmationSettings = DEFAULT_SETTINGS,
): { direct: NodePatch; guarded: NodePatch } {
  if (actor !== 'claude' || !settings.requireConfirmation) return { direct: { ...patch }, guarded: {} };
  const direct: NodePatch = {};
  const guarded: NodePatch = {};
  for (const [k, v] of Object.entries(patch) as [keyof NodePatch, unknown][]) {
    let guardedField = false;
    if (k === 'status') guardedField = v === 'done' && settings.keyFields.includes('status_done');
    else guardedField = (settings.keyFields as readonly string[]).includes(k);
    (guardedField ? guarded : direct)[k] = v as never;
  }
  return { direct, guarded };
}

/** True when a whole op must be held for confirmation (currently only deletes). */
export function opNeedsConfirmation(op: Op, settings: ConfirmationSettings = DEFAULT_SETTINGS): boolean {
  if (op.actor !== 'claude' || !settings.requireConfirmation) return false;
  if (op.type === 'delete_node') return settings.keyFields.includes('delete');
  return false;
}
