/**
 * Cloud mode: the app runs as a claude.ai Artifact page with no server. The in-memory DemoServer
 * answers every /api route; `src/cloud/persist.ts` writes its state through to the artifact's `db`
 * capability, `src/cloud/assistant.ts` drives the chat with the `sample` capability, and outline
 * export goes through `downloads`. Enabled only by the `build:cloud` bundle (VITE_CLOUD=true) — a
 * cloud build always behaves as cloud, even before any capability resolves.
 */
export const isCloud: boolean = import.meta.env.VITE_CLOUD === 'true';

/** Document ids under the artifact db (see persist.ts for the layout). */
export const CLOUD_DOCS = {
  account: 'meta/account',
  contacts: 'meta/contacts',
  projects: 'projects',
  chats: 'chats',
} as const;
