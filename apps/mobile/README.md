# Tsai Mind · iPhone App

`@tsai-mind/mobile` — Expo (SDK 57) + expo-router + React Native, no UI kit. It talks to the same REST/WebSocket API as the web app and shares `@tsai-mind/core` (tree ops, rollup, dates) as a workspace dependency.

## Layout

```
app/                    expo-router screens
  _layout.tsx           root stack, auth gate, push bootstrap
  login.tsx             server URL + token
  settings.tsx          account, sync state, notification toggles + 催办模板 (synced via PATCH /api/me), 退出 (modal)
  (tabs)/index.tsx      今天  — 逾期 / 今天到期 / 明天到期 / 待确认 / 该催的
  (tabs)/pending.tsx    待确认 — all pending changes + draft batches, badge on the tab
  (tabs)/projects.tsx   项目  — list with overdue / pending counts
  (tabs)/claude.tsx     Claude — assistant session list (swipe left to delete), 新对话
  chat/[id].tsx         one conversation (`new` or a session id; ?projectId= scopes it, ?prefill= seeds the input)
  project/[id].tsx      read-only mind map (react-native-svg) ⇄ outline list; critical path; 问 Claude in the header
  node/[id].tsx         node detail: title, owner, status pills, progress, dates, 依赖 (前置/后续, 等待中, 延误), 催办, 问 Claude, pending, activity
src/
  api/                  client.ts + types.ts mirror apps/web/src/api; sse.ts streams the assistant reply (parser unit tested)
  state/assistant.ts    sessions + per-chat messages, streaming deltas / tool events into the last assistant bubble
  components/Chat.tsx   message bubbles and the「调用 update_node · 待确认」tool chips
  sync/queue.ts         persisted offline op queue (React-free, unit tested)
  sync/snapshot.ts      last-seen project trees for offline start
  sync/runtime.ts       wires queue + snapshots + NetInfo to the app
  sync/realtime.ts      WebSocket /api/realtime with reconnect + catch-up
  state/                zustand stores: session, project (TreeStore + optimistic ops), pending, today, settings
  components/           TaskRow (swipe), PendingCard, BatchCard, MindMap, OutlineList, DateField, ui
  push.ts               permissions, Expo push token → POST /api/devices, categories + action handling
e2e/                    Playwright smoke run against the web export (fixtures, iPhone viewport screenshots)
```

## Run it

```sh
pnpm install                                  # repo root
pnpm --filter @tsai-mind/core build           # once, so dist/ exists
pnpm --filter @tsai-mind/mobile typecheck
pnpm --filter @tsai-mind/mobile test          # offline-queue + SSE parser unit tests (vitest)
```

### On a real iPhone with Expo Go (day-to-day development)

1. Install **Expo Go** from the App Store.
2. Start the API: `pnpm dev:server` (listens on `:3000`).
3. `pnpm --filter @tsai-mind/mobile start`, scan the QR code with the Camera app.
4. In the login screen enter the server URL **using your Mac's LAN IP** (e.g. `http://192.168.1.20:3000` — `127.0.0.1` is the phone itself) and paste a token created in the web app.

Metro is configured for the pnpm workspace (`metro.config.js`: `watchFolders` = repo root, `nodeModulesPaths`, symlinks on), so `@tsai-mind/core` resolves from `packages/core/dist`.

Caveat: **push notifications do not work in Expo Go** (remote notifications were removed from Expo Go in SDK 53). Everything else — offline editing, swipe actions, share-sheet 催办, mind map — works there. `src/push.ts` detects Expo Go / simulator / web and turns itself into a no-op.

### Development build / TestFlight (the real thing, with push)

Prerequisites: an Apple Developer account, `npm i -g eas-cli`, `eas login`.

1. `app.json` → set `expo.ios.bundleIdentifier` (currently `app.tsaimind.ios`) to an identifier you own, and `expo.extra.eas.projectId` (run `eas init` to create/link the project; it fills this in).
2. Credentials: `eas credentials -p ios` → let EAS manage the distribution certificate, provisioning profile and the **APNs key**. The APNs key is what lets Expo's push service deliver to this bundle id; `expo-notifications` needs the `aps-environment` entitlement and `remote-notification` background mode, both already in `app.json`.
3. Development build on device: `eas build -p ios --profile development` then `eas build:run -p ios` (or install from the QR). Start Metro with `pnpm --filter @tsai-mind/mobile start --dev-client`.
4. TestFlight: `eas build -p ios --profile production` and `eas submit -p ios`. Create an `eas.json` (`eas build:configure`) with `development` (developmentClient: true, distribution: internal) and `production` profiles.
5. First launch after login the app asks for notification permission, fetches the Expo push token and calls `POST /api/devices {platform:'ios', pushToken, name}`. The server sends pushes with `data.kind` ∈ {change, batch, due, nudge, digest, dependency_slip} and a matching `categoryId` (`dependency` for slips); the app registers those categories with actions: `change` → 确认 / 拒绝 (calls `/api/changes/:id/approve|reject`), `due` → 标记完成 / 推迟一天 (`/api/nodes/:id/done`, `/api/nodes/:id/postpone {days:1}`), `batch`/`nudge`/`digest` open 待确认 / the node / 今天, `dependency_slip` opens the successor node (`data.nodeId`, falling back to `data.toNode`).

### Server URL and token

- Default server is `https://tsaimind.app`; the login screen accepts any `http(s)://host[:port]`.
- The token is a personal access token from the web app (`Authorization: Bearer …`), validated with `GET /api/me` before it is stored in the iOS keychain (`expo-secure-store`). The server URL is stored in AsyncStorage. 退出 in settings deletes the token.
- Notification toggles and the 催办模板 live in `account.settings` on the server: they are read from `GET /api/me` (on login / bootstrap) and written with `PATCH /api/me {settings:{notifications, nudgeTemplate}}`. `src/state/settings.ts` keeps a local copy so the screen works offline; an edit that could not be sent is marked dirty and retried when the network comes back or the app returns to the foreground (the server copy is not applied over a dirty local edit).

## Claude tab (phase 3)

- `GET /api/assistant/status` gates the tab: `{configured:false}` (or a 404/503 from an older server) shows「服务器还没配置 ANTHROPIC_API_KEY」instead of the session list.
- Sessions: `GET/POST /api/assistant/sessions`, `GET/DELETE /api/assistant/sessions/:id` (`{session, messages:[{id, role, text, toolCalls:[{name,input,resultText}]}]}`). The list is cached like the other lists for offline start.
- Sending: `POST /api/assistant/sessions/:id/messages {text, projectId?}` answers with `text/event-stream`; `src/api/sse.ts` reads it through `XMLHttpRequest.onprogress` (RN `fetch` does not stream reliably) with a `fetch` + reader fallback when there is no XHR, and hands `text` deltas / `tool` events / `done` / `error` to `src/state/assistant.ts`, which appends them to the streaming assistant bubble. A 503 `assistant_unconfigured` turns into the same empty state.
- Entry points: the tab's 新对话, 问 Claude in the project header (`/chat/new?projectId=…` — the「在项目 X 中」chip), and 问 Claude on a node (prefills「关于「节点标题」：」).

## Dependencies and schedule

`GET /api/projects/:id` may include `criticalPath` (root-first node ids) and `slips` (`{fromNode,toNode,fromDue,toStart,days}`); the store takes them when present and otherwise computes the same values with core `computeCriticalPath` / `findDependencySlips`, and recomputes locally after every op so offline edits stay consistent. The map draws critical-path connectors 2.5px solid orange, the outline shows a small orange ◆ on those rows, and node detail lists 前置任务 / 后续任务 with「等待中：前置任务未完成」(core `isWaitingOnDependency`) and a red「延误 n 天」line when the node is the successor of a slip.

## Offline behaviour

- Every edit is a core `Op` applied to the in-memory `TreeStore` immediately and enqueued in `src/sync/queue.ts` (AsyncStorage-backed FIFO, dedupe by `opId`, one request per project batch, order preserved across projects).
- The queue flushes when NetInfo reports connectivity or a request succeeds; a fetch/5xx failure flips it offline and keeps the ops. A per-op rejection (409 version conflict, cycle, …) drops that op and reloads the project from the server.
- The last tree of each opened project is snapshotted; the app opens it offline and replays the unsent ops on top. 今天 / 待确认 / 项目 lists fall back to their last responses with an offline banner.
- Incoming WebSocket ops are applied like the web (`serverSeq` guard, own ops recognised by `opId`).

## Web export (used for the visual check)

```sh
pnpm --filter @tsai-mind/mobile export:web             # → apps/mobile/dist
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers pnpm --filter @tsai-mind/mobile e2e
```

`e2e/run.mjs` serves `dist/`, mocks `/api/**` with the fixtures (project 官网改版 with a dependency slip and a critical path, one pending change, one overdue node, two assistant sessions, a canned SSE reply), logs in, walks 今天 → 待确认 → 项目 → 导图/大纲 → 节点 → 问 Claude → Claude 标签 → 对话 (streamed reply with a「调用 update_node · 待确认」chip) → 设置 (asserts the `PATCH /api/me` bodies) at 390×844 and writes screenshots to `e2e/out/`. Native-only modules (SecureStore, notifications, date picker, NetInfo) are loaded lazily behind `Platform` checks so the web bundle never touches them.
