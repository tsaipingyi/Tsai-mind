---
name: tsai-mind
description: Read and edit the owner's Tsai Mind plans (projects, tasks, owners, dates, progress) that live in the cloud artifact's database. Use whenever the user talks about their projects, tasks, deadlines, who is responsible, or asks to create/change/reschedule a plan in Tsai Mind, e.g. "把上线推到 10/15", "新建一个项目", "这周谁会延", "给接口联调换负责人".
---

# Tsai Mind cloud data

The product runs as a claude.ai artifact page; its data is the artifact database. Artifact URL:

    https://claude.ai/code/artifact/8f2fc173-fffa-4d02-bf1e-0985bc1de260

Use the `Artifact` tool with `read_db` / `write_db` on that `url`. The page subscribes to the database, so a written document shows up on the owner's screen within seconds.

## Documents

| collection / doc | body |
|---|---|
| `projects/<projectId>` | `{project:{id,name,rootNodeId,createdAt,archivedAt}, nodes:[TNode…], dependencies:[{fromNode,toNode}], changes:[…], batches:[…], activity:[…≤200], opLog:[…≤100], serverSeq, updatedAt}` |
| `meta/contacts` | `{contacts:[{id,name,company,email,phone,notes,archivedAt}], updatedAt}` |
| `meta/account` | `{account:{name,timezone,settings}, tokens, firstRun, updatedAt}` |
| `chats/<sessionId>` | in-page Claude conversations; leave alone |

`TNode` is `packages/core/src/types.ts`. Dates are `YYYY-MM-DD`. Derived values (rollup, critical path) are never stored. `updatedAt` must be newer than the stored one or the page ignores the write.

## Workflow (always through the scripts, never hand-edit nodes)

1. Read: `read_db` with `db_op: "list"`, `collection: "projects"`, `out_dir: <scratch>` → one JSON file per project under `<scratch>/projects/`. Also `read_db get meta/contacts` when owners matter.
2. Show the plan: `node scripts/cloud-outline.mjs <scratch>/projects/<id>.json <scratch>/meta/contacts.json` prints the outline with `[id]` tokens (syntax in `docs/mcp-tools.md` §3).
3. Edit: write the changed outline to a file (keep `[id]` on existing lines; new lines have no id; `@名字` must match a contact; `replace` mode deletes unmentioned nodes, so prefer `sync`), then
   `node scripts/cloud-apply.mjs <doc.json> <outline.md> sync <contacts.json> > updated.json`. The script applies the diff through core (rollup rules, cycles, version bumps) and appends op log and activity.
4. Write back: `write_db` with `db_op: "set"`, `collection: "projects"`, `doc_id: <projectId>`, `file_path: updated.json`.
5. New project: `node scripts/cloud-project.mjs "名字" outline.md contacts.json > new.json`; the JSON has `{id, doc}` — write `doc` (save it to its own file first) with `write_db set projects/<id>`.
6. Tell the user what changed in plain words (titles, not ids). Writes from here apply directly; there is no 待确认 step, so confirm destructive changes (deleting nodes, `replace` mode) with the user before writing.

Build core first if `packages/core/dist` is missing: `pnpm --filter @tsai-mind/core build`.
