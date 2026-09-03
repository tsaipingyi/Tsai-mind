export type NodeKind = 'goal' | 'task' | 'milestone' | 'note';
export type NodeStatus = 'todo' | 'in_progress' | 'blocked' | 'waiting' | 'done';
export type RollupMode = 'auto' | 'manual';
export type Actor = 'user' | 'claude' | 'system';

/** ISO date string, YYYY-MM-DD. */
export type ISODate = string;
/** ISO timestamp string. */
export type ISOTime = string;

export interface TNode {
  id: string;
  projectId: string;
  parentId: string | null;
  rank: string;
  title: string;
  description: string;
  kind: NodeKind;
  /** Contact id, or null meaning "me". */
  ownerId: string | null;
  status: NodeStatus;
  progress: number;
  progressMode: RollupMode;
  startDate: ISODate | null;
  dueDate: ISODate | null;
  dateMode: RollupMode;
  estimateHours: number | null;
  priority: 1 | 2 | 3 | 4;
  tags: string[];
  lastNudgedAt: ISOTime | null;
  version: number;
  createdAt: ISOTime;
  updatedAt: ISOTime;
  deletedAt: ISOTime | null;
}

export const NODE_STATUSES: readonly NodeStatus[] = ['todo', 'in_progress', 'blocked', 'waiting', 'done'];
export const NODE_KINDS: readonly NodeKind[] = ['goal', 'task', 'milestone', 'note'];

export interface Contact {
  id: string;
  name: string;
  company: string | null;
  email: string | null;
  phone: string | null;
  notes: string | null;
  archivedAt: ISOTime | null;
}

export interface Project {
  id: string;
  name: string;
  rootNodeId: string;
  createdAt: ISOTime;
  archivedAt: ISOTime | null;
}

export interface Dependency {
  fromNode: string;
  toNode: string;
}

export type ChangeSource = 'claude' | 'batch';
export type ChangeStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export interface Change {
  id: string;
  nodeId: string;
  /** Field name, or the pseudo-fields "delete" / "status". */
  field: string;
  oldValue: unknown;
  newValue: unknown;
  reason: string | null;
  source: ChangeSource;
  batchId: string | null;
  status: ChangeStatus;
  decidedAt: ISOTime | null;
  createdAt: ISOTime;
  expiresAt: ISOTime;
}

/** Fields a client may set directly on a node. */
export type NodePatch = Partial<
  Pick<
    TNode,
    | 'title'
    | 'description'
    | 'kind'
    | 'ownerId'
    | 'status'
    | 'progress'
    | 'progressMode'
    | 'startDate'
    | 'dueDate'
    | 'dateMode'
    | 'estimateHours'
    | 'priority'
    | 'tags'
    | 'lastNudgedAt'
  >
>;

export const PATCHABLE_FIELDS: readonly (keyof NodePatch)[] = [
  'title',
  'description',
  'kind',
  'ownerId',
  'status',
  'progress',
  'progressMode',
  'startDate',
  'dueDate',
  'dateMode',
  'estimateHours',
  'priority',
  'tags',
  'lastNudgedAt',
];

/** Input for creating a node. Missing fields get defaults. */
export interface NewNodeInput {
  id: string;
  projectId: string;
  parentId: string | null;
  rank: string;
  title: string;
  description?: string;
  kind?: NodeKind;
  ownerId?: string | null;
  status?: NodeStatus;
  progress?: number;
  progressMode?: RollupMode;
  startDate?: ISODate | null;
  dueDate?: ISODate | null;
  dateMode?: RollupMode;
  estimateHours?: number | null;
  priority?: 1 | 2 | 3 | 4;
  tags?: string[];
}

interface OpBase {
  opId: string;
  clientId: string;
  projectId: string;
  actor: Actor;
  /** ISO timestamp set by the client; the server records its own receivedAt. */
  at: ISOTime;
}

export type Op = OpBase &
  (
    | { type: 'create_node'; node: NewNodeInput }
    | { type: 'update_node'; nodeId: string; patch: NodePatch; baseVersion?: number }
    | { type: 'move_node'; nodeId: string; parentId: string; rank: string; baseVersion?: number }
    | { type: 'delete_node'; nodeId: string }
    | { type: 'restore_node'; nodeId: string }
  );

export type OpType = Op['type'];

export interface ServerOp {
  serverSeq: number;
  op: Op;
}
