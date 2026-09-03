import type { Contact, ISODate, NewNodeInput, NodeKind, NodePatch, NodeStatus, Op, TNode } from './types.js';
import { NODE_STATUSES } from './types.js';
import type { TreeStore } from './store.js';
import { rankBetween } from './rank.js';
import { shortDate } from './dates.js';

/**
 * Outline format (one node per line, indentation = hierarchy):
 *
 *   - ◆ 上线 [n_e5e5] @蔡 10/10 done 60% ← 前端页面, 接口联调
 *
 * Tokens after the title, in any order: [id], @owner, a date or date range
 * (M/D, YYYY-MM-DD, "a–b"), a status word, NN%, and "← dep1, dep2" which
 * must be last. A leading ◆ marks a milestone, a leading § marks a note.
 */
export interface OutlineLine {
  depth: number;
  id: string | null;
  title: string;
  kind: NodeKind | null;
  owner: string | null; // name as written; null = not specified; '' = explicitly me ("@me")
  startDate: ISODate | null;
  dueDate: ISODate | null;
  hasDates: boolean;
  status: NodeStatus | null;
  progress: number | null;
  deps: string[];
  lineNo: number;
  children: OutlineLine[];
}

export interface ParseOptions {
  /** Year assumed for M/D dates. */
  year: number;
}

export interface ParseResult {
  roots: OutlineLine[];
  errors: { lineNo: number; message: string }[];
}

const DATE_ISO = /^\d{4}-\d{2}-\d{2}$/;
const DATE_MD = /^(\d{1,2})\/(\d{1,2})$/;
const RANGE_SEP = /[–~]|(?<=\d)-(?=\d{1,2}\/)|(?<=\d\/\d{1,2})-(?=\d)/;

function parseDate(tok: string, year: number): ISODate | null {
  if (DATE_ISO.test(tok)) return tok;
  const m = DATE_MD.exec(tok);
  if (m) {
    const mo = Number(m[1]);
    const d = Number(m[2]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return `${year}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  return null;
}

function parseDateToken(tok: string, year: number): { start: ISODate | null; due: ISODate | null } | null {
  // ISO range "2026-09-01–2026-10-10" or "2026-09-01~2026-10-10"; ISO with '-' separator is ambiguous, require – or ~
  const isoRange = /^(\d{4}-\d{2}-\d{2})[–~](\d{4}-\d{2}-\d{2})$/.exec(tok);
  if (isoRange) return { start: isoRange[1]!, due: isoRange[2]! };
  const single = parseDate(tok, year);
  if (single) return { start: null, due: single };
  const parts = tok.split(RANGE_SEP);
  if (parts.length === 2) {
    const a = parseDate(parts[0]!, year);
    const b = parseDate(parts[1]!, year);
    if (a && b) return { start: a, due: b };
  }
  return null;
}

function indentDepth(ws: string): number {
  let d = 0;
  let spaces = 0;
  for (const ch of ws) {
    if (ch === '\t') {
      d++;
      spaces = 0;
    } else {
      spaces++;
      if (spaces === 2) {
        d++;
        spaces = 0;
      }
    }
  }
  return d;
}

export function parseOutline(text: string, opts: ParseOptions): ParseResult {
  const errors: ParseResult['errors'] = [];
  const flat: OutlineLine[] = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  lines.forEach((raw, i) => {
    if (raw.trim() === '') return;
    const lineNo = i + 1;
    const m = /^(\s*)(?:[-*•]\s+)?(.*)$/.exec(raw)!;
    const depth = indentDepth(m[1]!);
    let body = m[2]!.trim();

    const deps: string[] = [];
    const arrow = body.indexOf('←');
    if (arrow >= 0) {
      body
        .slice(arrow + 1)
        .split(/[,，]/)
        .map((s) => s.trim())
        .filter(Boolean)
        .forEach((s) => deps.push(s));
      body = body.slice(0, arrow).trim();
    }

    let kind: NodeKind | null = null;
    if (body.startsWith('◆')) {
      kind = 'milestone';
      body = body.slice(1).trim();
    } else if (body.startsWith('§')) {
      kind = 'note';
      body = body.slice(1).trim();
    }

    const line: OutlineLine = {
      depth,
      id: null,
      title: '',
      kind,
      owner: null,
      startDate: null,
      dueDate: null,
      hasDates: false,
      status: null,
      progress: null,
      deps,
      lineNo,
      children: [],
    };

    // consume trailing tokens right-to-left until one is not recognised
    const tokens = body.split(/\s+/);
    while (tokens.length > 1) {
      const tok = tokens[tokens.length - 1]!;
      const idm = /^\[([^\]]+)\]$/.exec(tok);
      if (idm) {
        line.id = idm[1]!;
        tokens.pop();
        continue;
      }
      if (tok.startsWith('@') && tok.length > 1) {
        line.owner = tok.slice(1) === 'me' || tok.slice(1) === '我' ? '' : tok.slice(1);
        tokens.pop();
        continue;
      }
      const pm = /^(\d{1,3})%$/.exec(tok);
      if (pm) {
        line.progress = Math.min(100, Number(pm[1]));
        tokens.pop();
        continue;
      }
      if ((NODE_STATUSES as readonly string[]).includes(tok)) {
        line.status = tok as NodeStatus;
        tokens.pop();
        continue;
      }
      const dt = parseDateToken(tok, opts.year);
      if (dt) {
        line.startDate = dt.start;
        line.dueDate = dt.due;
        line.hasDates = true;
        tokens.pop();
        continue;
      }
      break;
    }
    // an [id] as the only token means empty title; keep it
    const last = tokens[tokens.length - 1];
    if (tokens.length === 1 && last && /^\[([^\]]+)\]$/.test(last)) {
      line.id = last.slice(1, -1);
      tokens.pop();
    }
    line.title = tokens.join(' ').trim();
    if (!line.title && !line.id) errors.push({ lineNo, message: 'empty title' });
    flat.push(line);
  });

  const roots: OutlineLine[] = [];
  const stack: OutlineLine[] = [];
  for (const line of flat) {
    while (stack.length && stack[stack.length - 1]!.depth >= line.depth) stack.pop();
    if (stack.length === 0) {
      if (line.depth !== 0 && roots.length === 0) {
        // tolerate an outline that starts indented
      }
      roots.push(line);
    } else {
      const parent = stack[stack.length - 1]!;
      if (line.depth > parent.depth + 1) {
        errors.push({ lineNo: line.lineNo, message: `indentation jumps ${line.depth - parent.depth} levels` });
      }
      parent.children.push(line);
    }
    stack.push(line);
  }
  return { roots, errors };
}

export interface SerializeOptions {
  contacts: Contact[];
  year: number;
  /** Include [id] tokens (default true). */
  ids?: boolean;
  /** Dependencies per node id: list of predecessor node ids. */
  deps?: Map<string, string[]>;
  /** Use derived rollup values for parents (progress/dates/status). */
  derived?: Map<string, { progress: number; startDate: ISODate | null; dueDate: ISODate | null; status: NodeStatus; hasChildren: boolean }>;
}

export function serializeOutline(store: TreeStore, rootId: string | null, opts: SerializeOptions): string {
  const names = new Map(opts.contacts.map((c) => [c.id, c.name] as const));
  const out: string[] = [];
  const walk = (n: TNode, depth: number) => {
    const d = opts.derived?.get(n.id);
    const parts: string[] = [];
    let title = n.title;
    if (n.kind === 'milestone') title = `◆ ${title}`;
    if (n.kind === 'note') title = `§ ${title}`;
    parts.push(title);
    if (opts.ids !== false) parts.push(`[${n.id}]`);
    if (n.ownerId) parts.push(`@${names.get(n.ownerId) ?? '?'}`);
    const start = d ? d.startDate : n.startDate;
    const due = d ? d.dueDate : n.dueDate;
    if (start && due && start !== due) parts.push(`${shortDate(start, opts.year)}–${shortDate(due, opts.year)}`);
    else if (due) parts.push(shortDate(due, opts.year));
    else if (start) parts.push(`${shortDate(start, opts.year)}–`);
    const status = d ? d.status : n.status;
    if (status !== 'todo') parts.push(status);
    const progress = d ? d.progress : n.status === 'done' ? 100 : n.progress;
    if (status !== 'done' && status !== 'todo' && progress > 0) parts.push(`${progress}%`);
    else if (status === 'todo' && progress > 0) parts.push(`${progress}%`);
    const deps = opts.deps?.get(n.id);
    if (deps && deps.length) {
      const titles = deps.map((id) => store.get(id)?.title ?? id);
      parts.push(`← ${titles.join(', ')}`);
    }
    out.push(`${'  '.repeat(depth)}- ${parts.join(' ')}`);
    for (const c of store.children(n.id)) walk(c, depth + 1);
  };
  const tops = rootId ? [store.get(rootId)].filter((x): x is TNode => !!x && !x.deletedAt) : store.children(null);
  for (const t of tops) walk(t, 0);
  return out.join('\n');
}

export type PlanMode = 'append' | 'sync' | 'replace';

export interface PlanOptions {
  projectId: string;
  /** Existing node under which the outline's roots are placed. */
  parentId: string;
  mode: PlanMode;
  contacts: Contact[];
  newId: () => string;
  opBase: { clientId: string; actor: Op['actor']; at: string };
  /** When the outline's single root has the same id as parentId, its children are merged into parentId. */
}

export interface PlanResult {
  ops: Op[];
  summary: { create: number; update: number; move: number; delete: number };
  errors: { lineNo: number; message: string }[];
  /** For created nodes: line -> new id. */
  created: { lineNo: number; id: string; title: string }[];
}

/**
 * Turn a parsed outline into ops against the current store.
 * - lines with [id] refer to existing nodes inside parentId's subtree (or parentId itself)
 * - lines without [id] are created
 * - in 'sync' and 'replace' modes existing nodes are updated/moved to match
 * - in 'replace' mode, live descendants of parentId not mentioned are deleted
 * - 'append' mode only creates; existing lines are used for placement
 */
export function planOps(store: TreeStore, parsed: ParseResult, opts: PlanOptions): PlanResult {
  const errors = [...parsed.errors];
  const ops: Op[] = [];
  const summary = { create: 0, update: 0, move: 0, delete: 0 };
  const created: PlanResult['created'] = [];
  const contactsByName = new Map<string, Contact>();
  for (const c of opts.contacts) {
    if (!c.archivedAt) contactsByName.set(c.name, c);
  }
  const mentioned = new Set<string>();
  const parent = store.live(opts.parentId);
  if (!parent) return { ops, summary, errors: [{ lineNo: 0, message: 'parent not found' }], created };

  let seq = 0;
  const mk = (): Pick<Op, 'opId' | 'clientId' | 'projectId' | 'actor' | 'at'> => ({
    opId: `${opts.opBase.clientId}:${opts.opBase.at}:${seq++}`,
    clientId: opts.opBase.clientId,
    projectId: opts.projectId,
    actor: opts.opBase.actor,
    at: opts.opBase.at,
  });

  const resolveOwner = (line: OutlineLine): string | null | undefined => {
    if (line.owner === null) return undefined;
    if (line.owner === '') return null;
    const c = contactsByName.get(line.owner);
    if (!c) {
      const near = [...contactsByName.keys()].filter((n) => n.includes(line.owner!) || line.owner!.includes(n));
      errors.push({ lineNo: line.lineNo, message: `unknown contact "${line.owner}"${near.length ? `, did you mean ${near.join(' / ')}` : ''}` });
      return undefined;
    }
    return c.id;
  };

  // Track the simulated rank ordering per parent so siblings get sensible ranks.
  const lastRankUnder = new Map<string, string | null>();
  const nextRank = (pid: string): string => {
    if (!lastRankUnder.has(pid)) {
      const kids = store.children(pid);
      lastRankUnder.set(pid, kids.length ? kids[kids.length - 1]!.rank : null);
    }
    const r = rankBetween(lastRankUnder.get(pid) ?? null, null);
    lastRankUnder.set(pid, r);
    return r;
  };

  const walk = (line: OutlineLine, pid: string) => {
    let nodeId: string;
    if (line.id) {
      const existing = store.live(line.id);
      if (!existing) {
        errors.push({ lineNo: line.lineNo, message: `node [${line.id}] not found` });
        return;
      }
      if (existing.id !== opts.parentId && !store.isDescendant(existing.id, opts.parentId)) {
        errors.push({ lineNo: line.lineNo, message: `node [${line.id}] is outside the target subtree` });
        return;
      }
      nodeId = existing.id;
      mentioned.add(nodeId);
      if (opts.mode !== 'append' && existing.id !== opts.parentId) {
        const patch: NodePatch = {};
        if (line.title && line.title !== existing.title) patch.title = line.title;
        if (line.kind && line.kind !== existing.kind) patch.kind = line.kind;
        const owner = resolveOwner(line);
        if (owner !== undefined && owner !== existing.ownerId) patch.ownerId = owner;
        if (line.hasDates) {
          if (line.startDate !== existing.startDate) patch.startDate = line.startDate;
          if (line.dueDate !== existing.dueDate) patch.dueDate = line.dueDate;
          if (existing.dateMode === 'auto' && store.children(existing.id).length) patch.dateMode = 'manual';
        }
        if (line.status && line.status !== existing.status) patch.status = line.status;
        if (line.progress !== null && line.progress !== existing.progress && line.status !== 'done') patch.progress = line.progress;
        if (Object.keys(patch).length) {
          ops.push({ ...mk(), type: 'update_node', nodeId, patch, baseVersion: existing.version });
          summary.update++;
        }
        if (existing.parentId !== pid) {
          ops.push({ ...mk(), type: 'move_node', nodeId, parentId: pid, rank: nextRank(pid) });
          summary.move++;
        }
      }
    } else {
      const id = opts.newId();
      const owner = resolveOwner(line);
      const node: NewNodeInput = {
        id,
        projectId: opts.projectId,
        parentId: pid,
        rank: nextRank(pid),
        title: line.title,
        kind: line.kind ?? 'task',
        ownerId: owner === undefined ? (store.live(pid)?.ownerId ?? null) : owner,
        startDate: line.startDate,
        dueDate: line.dueDate,
        status: line.status ?? 'todo',
        progress: line.progress ?? 0,
      };
      ops.push({ ...mk(), type: 'create_node', node });
      summary.create++;
      created.push({ lineNo: line.lineNo, id, title: line.title });
      nodeId = id;
      mentioned.add(id);
    }
    for (const c of line.children) walk(c, nodeId);
  };

  // If the outline has exactly one root and it IS the parent, merge its children into the parent.
  const roots = parsed.roots;
  if (roots.length === 1 && roots[0]!.id === opts.parentId) {
    mentioned.add(opts.parentId);
    for (const c of roots[0]!.children) walk(c, opts.parentId);
  } else {
    for (const r of roots) walk(r, opts.parentId);
  }

  if (opts.mode === 'replace') {
    // delete top-most unmentioned live descendants (deleting a node deletes its subtree)
    const unmentioned = store.descendants(opts.parentId).filter((n) => !mentioned.has(n.id));
    const doomed = new Set(unmentioned.map((n) => n.id));
    for (const n of unmentioned) {
      const parentDoomed = n.parentId !== null && doomed.has(n.parentId);
      if (!parentDoomed) {
        ops.push({ ...mk(), type: 'delete_node', nodeId: n.id });
        summary.delete++;
      }
    }
  }

  return { ops, summary, errors, created };
}
