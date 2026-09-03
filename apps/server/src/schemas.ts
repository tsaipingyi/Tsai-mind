import { z } from 'zod';

export const uuid = z.string().uuid();
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

export const nodeKind = z.enum(['goal', 'task', 'milestone', 'note']);
export const nodeStatus = z.enum(['todo', 'in_progress', 'blocked', 'waiting', 'done']);
export const rollupMode = z.enum(['auto', 'manual']);
export const actor = z.enum(['user', 'claude', 'system']);

export const nodePatch = z
  .object({
    title: z.string(),
    description: z.string(),
    kind: nodeKind,
    ownerId: uuid.nullable(),
    status: nodeStatus,
    progress: z.number().int().min(0).max(100),
    progressMode: rollupMode,
    startDate: isoDate.nullable(),
    dueDate: isoDate.nullable(),
    dateMode: rollupMode,
    estimateHours: z.number().nonnegative().nullable(),
    priority: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
    tags: z.array(z.string()),
    lastNudgedAt: z.string().nullable(),
  })
  .partial()
  .strict();

export const newNodeInput = z.object({
  id: uuid,
  projectId: uuid,
  parentId: uuid.nullable(),
  rank: z.string().min(1),
  title: z.string(),
  description: z.string().optional(),
  kind: nodeKind.optional(),
  ownerId: uuid.nullable().optional(),
  status: nodeStatus.optional(),
  progress: z.number().int().min(0).max(100).optional(),
  progressMode: rollupMode.optional(),
  startDate: isoDate.nullable().optional(),
  dueDate: isoDate.nullable().optional(),
  dateMode: rollupMode.optional(),
  estimateHours: z.number().nonnegative().nullable().optional(),
  priority: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).optional(),
  tags: z.array(z.string()).optional(),
});

const opBase = { opId: uuid, clientId: z.string().min(1), projectId: uuid, actor, at: z.string() };

export const opSchema = z.discriminatedUnion('type', [
  z.object({ ...opBase, type: z.literal('create_node'), node: newNodeInput }),
  z.object({ ...opBase, type: z.literal('update_node'), nodeId: uuid, patch: nodePatch, baseVersion: z.number().int().optional() }),
  z.object({ ...opBase, type: z.literal('move_node'), nodeId: uuid, parentId: uuid, rank: z.string().min(1), baseVersion: z.number().int().optional() }),
  z.object({ ...opBase, type: z.literal('delete_node'), nodeId: uuid }),
  z.object({ ...opBase, type: z.literal('restore_node'), nodeId: uuid }),
]);

export const opsBody = z.object({ ops: z.array(opSchema).min(1).max(500) });

export const contactInput = z
  .object({
    name: z.string(),
    company: z.string().nullable(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    avatarUrl: z.string().nullable(),
    notes: z.string().nullable(),
    archivedAt: z.string().nullable(),
  })
  .partial();

export const planMode = z.enum(['append', 'sync', 'replace']);
