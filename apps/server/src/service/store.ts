import { TreeStore, type Actor, type Change, type Contact, type Dependency, type Project, type TNode } from '@tsai-mind/core';
import { DEFAULT_SETTINGS, type ConfirmationSettings, type KeyField } from '@tsai-mind/core';
import type { Sql, Tx } from '../db.js';
import { NODE_COLUMNS, nodeToRow, rowToChange, rowToContact, rowToNode, rowToProject } from '../mapping.js';
import { notFound } from '../errors.js';

type Db = Sql | Tx;

/** Build a TreeStore from live + deleted rows (deleted rows are needed for restore). */
export async function loadStore(db: Db, projectId: string): Promise<TreeStore> {
  const rows = await db`select * from node where project_id = ${projectId}`;
  return new TreeStore(rows.map(rowToNode));
}

export async function persistNodes(db: Db, nodes: TNode[]): Promise<void> {
  const updatable = NODE_COLUMNS.filter((c) => c !== 'id');
  for (const n of nodes) {
    const row = nodeToRow(n) as Record<(typeof NODE_COLUMNS)[number], never>;
    // text[] must be sent with an explicit array type (1009), otherwise postgres.js sends a bare string
    row.tags = db.array(n.tags, 1009) as never;
    await db`insert into node ${db(row, ...NODE_COLUMNS)} on conflict (id) do update set ${db(row, ...updatable)}`;
  }
}

export async function loadProject(db: Db, projectId: string): Promise<Project> {
  const rows = await db`select * from project where id = ${projectId}`;
  if (!rows[0]) throw notFound('project');
  return rowToProject(rows[0]);
}

export async function loadProjects(db: Db, opts: { includeArchived?: boolean } = {}): Promise<Project[]> {
  const rows = opts.includeArchived
    ? await db`select * from project order by created_at`
    : await db`select * from project where archived_at is null order by created_at`;
  return rows.map(rowToProject);
}

export async function loadContacts(db: Db, opts: { includeArchived?: boolean } = {}): Promise<Contact[]> {
  const rows = opts.includeArchived
    ? await db`select * from contact order by name`
    : await db`select * from contact where archived_at is null order by name`;
  return rows.map(rowToContact);
}

export async function loadDependencies(db: Db, projectId: string): Promise<Dependency[]> {
  const rows = await db`
    select d.from_node, d.to_node from dependency d
    join node a on a.id = d.from_node join node b on b.id = d.to_node
    where a.project_id = ${projectId} and a.deleted_at is null and b.deleted_at is null`;
  return rows.map((r) => ({ fromNode: r.from_node as string, toNode: r.to_node as string }));
}

/** Map of node id -> predecessor ids, as serializeOutline expects. */
export function depsByNode(deps: Dependency[]): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const d of deps) {
    const list = m.get(d.toNode) ?? [];
    list.push(d.fromNode);
    m.set(d.toNode, list);
  }
  return m;
}

export interface NotificationToggles {
  dueSoon?: boolean;
  overdue?: boolean;
  nudgeDue?: boolean;
  digest?: boolean;
}

export interface AccountSettings {
  requireConfirmation?: boolean;
  keyFields?: KeyField[];
  nudgeTemplate?: string;
  /** Push toggles (DESIGN §4.4); change / batch / dependency pushes cannot be turned off. */
  notifications?: NotificationToggles;
}

export interface Account {
  id: string;
  email: string;
  name: string;
  timezone: string;
  settings: AccountSettings;
  hasPassword: boolean;
}

export async function loadAccount(db: Db): Promise<Account> {
  const rows = await db`select * from account limit 1`;
  const r = rows[0];
  if (!r) throw new Error('no account row; run migrate');
  return { id: r.id as string, email: r.email as string, name: r.name as string, timezone: r.timezone as string, settings: (r.settings as AccountSettings) ?? {}, hasPassword: !!r.password_hash };
}

export function confirmationSettings(s: AccountSettings): ConfirmationSettings {
  return {
    requireConfirmation: s.requireConfirmation ?? DEFAULT_SETTINGS.requireConfirmation,
    keyFields: s.keyFields ?? DEFAULT_SETTINGS.keyFields,
  };
}

/** Expire pending changes past their deadline, then return pending ones (optionally for one project or node). */
export async function loadPendingChanges(db: Db, filter: { projectId?: string; nodeId?: string } = {}): Promise<Change[]> {
  await db`update change set status = 'expired', decided_at = now() where status = 'pending' and expires_at < now()`;
  const rows = await db`
    select c.* from change c join node n on n.id = c.node_id
    where c.status = 'pending'
      ${filter.projectId ? db`and n.project_id = ${filter.projectId}` : db``}
      ${filter.nodeId ? db`and c.node_id = ${filter.nodeId}` : db``}
    order by c.created_at`;
  return rows.map(rowToChange);
}

export async function insertActivity(
  db: Db,
  a: { projectId: string; nodeId: string | null; actor: Actor; kind: string; payload?: unknown },
): Promise<void> {
  await db`insert into activity (project_id, node_id, actor_type, kind, payload)
    values (${a.projectId}, ${a.nodeId}, ${a.actor}, ${a.kind}, ${db.json((a.payload ?? {}) as never)})`;
}
