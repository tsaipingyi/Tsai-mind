# Tsai Mind

Single-user, mind-map-first project manager. Design docs live in `docs/` (DESIGN.md is the source of truth; mcp-tools.md for the Claude/MCP surface; design-system.md for the white-ground / orange-frame visual rules; schema.sql for the database).

## Layout
- `packages/core` — pure TypeScript domain: node types, fractional `rank`, `TreeStore` (apply/inverse ops), rollup of progress/dates/status, outline parse/serialize/plan, Claude confirmation rules, today view. No I/O. Tests: `pnpm --filter @tsai-mind/core test`.
- `apps/server` — Fastify REST + WebSocket + MCP (`/mcp`, Streamable HTTP, bearer PAT) on PostgreSQL. Migrations in `apps/server/migrations`. Local Postgres via `apps/server/scripts/pg.sh`.
- `apps/web` — React + Vite editor (mind map, outline, today, contacts, pending changes). Dev proxy `/api` → `:3000`.
- `deploy/` — Dockerfile + docker-compose for a one-box VPS.

## Rules
- Derived values (rollup) are computed, never stored. Persist raw node fields only.
- Every mutation is an `Op` (see core `types.ts`) applied through `TreeStore.apply` on client and server; the server's `op` table is the sync log and the undo source.
- Claude's edits to key fields (dueDate, startDate, ownerId, delete, status→done) become pending `change` rows; everything else applies directly. Use core `splitPatch` / `opNeedsConfirmation`; never duplicate that logic.
- UI text is Simplified Chinese. Dates are `YYYY-MM-DD` strings end to end.
- Commands: `pnpm install`, `pnpm typecheck`, `pnpm test`, `pnpm dev:server`, `pnpm dev:web`.
