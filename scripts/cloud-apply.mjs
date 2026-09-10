#!/usr/bin/env node
// Apply an outline (append | sync | replace) to a cloud project document and print the updated document.
// Usage: node scripts/cloud-apply.mjs project.json outline.md [sync|append|replace] [contacts.json] > updated.json
// The outline uses [id] tokens from cloud-outline.mjs for existing nodes; lines without [id] are created.
// Write the result back with the Artifact tool: write_db set, collection "projects", doc_id = project id, file_path = updated.json
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { TreeStore, parseOutline, planOps } from '../packages/core/dist/index.js';

const [docFile, outlineFile, modeArg = 'sync', contactsFile] = process.argv.slice(2);
if (!docFile || !outlineFile) {
  console.error('usage: node scripts/cloud-apply.mjs project.json outline.md [sync|append|replace] [contacts.json]');
  process.exit(1);
}
const raw = JSON.parse(readFileSync(docFile, 'utf8'));
const doc = raw.doc ?? raw.data ?? raw;
const contacts = contactsFile ? (JSON.parse(readFileSync(contactsFile, 'utf8')).contacts ?? []) : [];
const now = new Date().toISOString();
const store = new TreeStore(doc.nodes);
const parsed = parseOutline(readFileSync(outlineFile, 'utf8'), { year: new Date().getFullYear() });
const plan = planOps(store, parsed, {
  projectId: doc.project.id,
  parentId: doc.project.rootNodeId,
  mode: modeArg,
  contacts,
  newId: () => randomUUID(),
  opBase: { clientId: 'claude-code', actor: 'user', at: now },
});
if (plan.errors.length) console.error('outline warnings:', JSON.stringify(plan.errors));
let seq = Number(doc.serverSeq ?? 0);
let actId = Math.max(1000, ...(doc.activity ?? []).map((a) => Number(a.id) || 0));
const opLog = [...(doc.opLog ?? [])];
const activity = [...(doc.activity ?? [])];
const describe = (op, before) => {
  if (op.type === 'create_node') return { kind: 'node_created', nodeId: op.node.id, payload: { parentId: op.node.parentId, projectId: doc.project.id, title: op.node.title } };
  if (op.type === 'update_node') {
    const fields = {};
    for (const [k, v] of Object.entries(op.patch)) fields[k] = { from: before?.[k] ?? null, to: v };
    return { kind: 'field_changed', nodeId: op.nodeId, payload: { projectId: doc.project.id, title: before?.title, fields } };
  }
  if (op.type === 'move_node') return { kind: 'moved', nodeId: op.nodeId, payload: { projectId: doc.project.id, title: before?.title, parentId: op.parentId } };
  if (op.type === 'delete_node') return { kind: 'deleted', nodeId: op.nodeId, payload: { projectId: doc.project.id, title: before?.title } };
  return { kind: op.type, nodeId: op.nodeId, payload: { projectId: doc.project.id } };
};
for (const op of plan.ops) {
  const before = op.type === 'create_node' ? null : { ...store.get(op.nodeId) };
  const inverse = store.inverseOf(op);
  const r = store.apply(op, now);
  if (!r.ok) {
    console.error('op failed:', op.type, r.message);
    continue;
  }
  seq += 1;
  const fixed = { ...op, opId: randomUUID() };
  opLog.push({ op: fixed, inverse: inverse ? { ...inverse, opId: fixed.opId + ':undo' } : null, receivedAt: now, serverSeq: seq, undoneBy: null });
  actId += 1;
  activity.push({ actor: 'claude', createdAt: now, id: actId, ...describe(op, before) });
}
const cutoff = Date.now() - 30 * 86400000;
const nodes = [...store.nodes.values()].filter((n) => !n.deletedAt || Date.parse(n.deletedAt) > cutoff);
const out = { ...doc, nodes, opLog: opLog.slice(-100), activity: activity.slice(-200), serverSeq: seq, updatedAt: new Date().toISOString() };
console.error(`applied: ${JSON.stringify(plan.summary)}; serverSeq ${doc.serverSeq ?? 0} → ${seq}`);
process.stdout.write(JSON.stringify(out, null, 1));
