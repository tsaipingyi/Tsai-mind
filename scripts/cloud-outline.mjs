#!/usr/bin/env node
// Print a cloud project document as an outline with ids (the same format the app and Claude use).
// Usage: node scripts/cloud-outline.mjs project.json [contacts.json]
import { readFileSync } from 'node:fs';
import { TreeStore, computeRollup, serializeOutline } from '../packages/core/dist/index.js';

const [docFile, contactsFile] = process.argv.slice(2);
if (!docFile) {
  console.error('usage: node scripts/cloud-outline.mjs project.json [contacts.json]');
  process.exit(1);
}
const raw = JSON.parse(readFileSync(docFile, 'utf8'));
const doc = raw.doc ?? raw.data ?? raw;
const contacts = contactsFile ? (JSON.parse(readFileSync(contactsFile, 'utf8')).contacts ?? []) : [];
const store = new TreeStore(doc.nodes);
const derived = computeRollup(store);
const deps = new Map();
for (const d of doc.dependencies ?? []) deps.set(d.toNode, [...(deps.get(d.toNode) ?? []), d.fromNode]);
console.log(serializeOutline(store, doc.project.rootNodeId, { contacts, year: new Date().getFullYear(), derived, deps }));
const pending = (doc.changes ?? []).filter((c) => c.status === 'pending');
if (pending.length) console.log(`\n待确认 ${pending.length} 项：` + pending.map((c) => `${c.field} ${JSON.stringify(c.oldValue)} → ${JSON.stringify(c.newValue)}`).join('；'));
