#!/usr/bin/env node
// Build a `projects/<id>` document for the Tsai Mind cloud artifact from a name and an outline.
// Usage: node scripts/cloud-project.mjs "项目名" outline.md [contacts.json] [--no-history] > project.json
// Documents must stay under ~240 KiB; pass --no-history for big imports (drops the undo log).
//   then write it with the Artifact tool: write_db set, collection "projects", doc_id = <id from the JSON>.
// The outline syntax is the one in docs/mcp-tools.md (indent = hierarchy, @负责人, 9/1–9/12, status, NN%).
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { TreeStore, firstRank, parseOutline, planOps } from '../packages/core/dist/index.js';

const [name, outlineFile, contactsJson, ...flags] = process.argv.slice(2);
const noHistory = flags.includes('--no-history'); // skip the op log for large wholesale imports (keeps the doc small)
if (!name) {
  console.error('usage: node scripts/cloud-project.mjs "项目名" [outline.md] [contacts.json]');
  process.exit(1);
}
const outline = outlineFile ? readFileSync(outlineFile, 'utf8') : '';
const contactsRaw = contactsJson ? JSON.parse(readFileSync(contactsJson, 'utf8')) : [];
const contacts = Array.isArray(contactsRaw) ? contactsRaw : (contactsRaw.contacts ?? []);
const now = new Date().toISOString();
const projectId = randomUUID();
const rootId = randomUUID();
const store = new TreeStore();
const root = {
  id: rootId, projectId, parentId: null, rank: firstRank(), title: name, description: '', kind: 'goal', ownerId: null,
  status: 'todo', progress: 0, progressMode: 'auto', startDate: null, dueDate: null, dateMode: 'auto', estimateHours: null,
  priority: 3, tags: [], lastNudgedAt: null, version: 1, createdAt: now, updatedAt: now, deletedAt: null,
};
store.nodes.set(rootId, root);
const activity = [{ actor: 'user', createdAt: now, id: 1000, kind: 'node_created', nodeId: rootId, payload: { parentId: null, project: true, projectId, title: name } }];
const opLog = [];
let seq = 0;
if (outline.trim()) {
  const parsed = parseOutline(outline, { year: new Date().getFullYear() });
  const plan = planOps(store, parsed, { projectId, parentId: rootId, mode: 'append', contacts, newId: () => randomUUID(), opBase: { clientId: 'claude-code', actor: 'user', at: now } });
  if (plan.errors.length) console.error('outline warnings:', JSON.stringify(plan.errors));
  for (const op of plan.ops) {
    const inverse = store.inverseOf(op);
    const r = store.apply(op, now);
    if (!r.ok) { console.error('op failed', r.message); continue; }
    seq += 1;
    const fixed = { ...op, opId: randomUUID() };
    opLog.push({ op: fixed, inverse: inverse ? { ...inverse, opId: fixed.opId + ':undo' } : null, receivedAt: now, serverSeq: seq, undoneBy: null });
    if (op.type === 'create_node') activity.push({ actor: 'user', createdAt: now, id: 1000 + seq, kind: 'node_created', nodeId: op.node.id, payload: { parentId: op.node.parentId, projectId, title: op.node.title } });
  }
}
const doc = {
  project: { id: projectId, name, rootNodeId: rootId, createdAt: now, archivedAt: null },
  nodes: [...store.nodes.values()],
  dependencies: [], changes: [], batches: [], activity: noHistory ? activity.slice(0, 1) : activity.slice(-200), opLog: noHistory ? [] : opLog.slice(-100), serverSeq: seq, updatedAt: new Date().toISOString(),
};
process.stdout.write(JSON.stringify({ id: projectId, doc }, null, 1));
