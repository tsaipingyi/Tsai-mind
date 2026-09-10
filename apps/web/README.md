# @tsai-mind/web

Tsai Mind 的网页端：React 19 + Vite + TypeScript，纯 CSS（`src/styles.css` 里是 [设计规范](../../docs/design-system.md) 的 token），业务逻辑来自 `@tsai-mind/core`。

## 运行

```sh
pnpm install
pnpm --filter @tsai-mind/core build      # 第一次，或 core 改过之后
pnpm --filter @tsai-mind/server dev      # 后端在 127.0.0.1:3000
pnpm --filter @tsai-mind/web dev         # 打开 http://localhost:5173
```

开发服务器把 `/api` 代理到 `http://127.0.0.1:3000`，`/api/realtime` 以 WebSocket 代理。

登录：在服务器端生成一个访问令牌，粘贴到登录页。

```sh
pnpm --filter @tsai-mind/server token:create
```

令牌保存在浏览器的 `localStorage`（`tsaimind.token`），点「退出」清除。

## 页面

| 路径 | 内容 |
|---|---|
| `/login` | 粘贴令牌 |
| `/` | 今天：逾期、今天到期、待确认、该催的 |
| `/projects` | 项目列表，新建项目（空白或贴大纲） |
| `/projects/:id` | 编辑器：导图 / 大纲 / 甘特 / 按人 四个视图、右侧节点面板（含依赖）、待确认面板、Claude 对话面板 |
| `/projects/:id/print` | 打印页：无界面装饰，项目名、日期、嵌套大纲、缩放到页宽的甘特 SVG；带 `?print=1` 打开时自动弹打印对话框 |
| `/contacts` | 联系人，点开看他名下的任务 |
| `/settings` | 账户名和时区、通知开关、催办模板、关键字段与「Claude 改动需要确认」、只读令牌列表 |

## 编辑器视图

- **导图**：主视图。关键路径（根到最晚截止叶子的那条链，来自 `GET /api/projects/:id` 的 `criticalPath`，本地编辑后用 core 的 `computeCriticalPath` 重算）上的连线加粗到 2.5px。
- **大纲**：键盘录入。
- **甘特**（`editor/Gantt.tsx`，几何在 `editor/ganttLayout.ts`，SVG 在 `editor/GanttChart.tsx`）：左列是大纲行（缩进、折叠箭头和大纲共用同一份折叠状态、负责人头像），右边一个 SVG 时间轴：日网格、周刻度（等宽字 9/1、9/8…）、月份、橘色虚线「今天」。父节点是状态色 25% 的细条，叶子是实心状态色条、已完成部分（进度 %）更深，里程碑是橘色菱形，没日期的行显示「无日期」，在空行上拖一段就创建日期。拖条改起止、拖两端改一端；父节点日期是自动模式时会弹「会把父节点日期改成手动」的确认。依赖画成灰色折线箭头，延误的（`slips`）变红并带说明。关键路径行的条有橘色描边。日 / 周 / 月三档缩放，表头和左列用 `position: sticky` 跟着滚动。选中行跟随全局选择。
- **按人**（`editor/PeopleBoard.tsx`）：每个联系人一列，加「我」和「未分配」（负责人已归档或不存在）。卡片是叶子任务（未完成，或最近 7 天完成的灰显）：标题、路径、截止日（逾期红）、进度环、待确认橘点。列头是数量和预估工时合计，本周到期的预估工时超过 40 小时时出红色角标。拖卡片到另一列 = 改负责人。
- 顶栏的负责人筛选对导图、大纲、甘特、看板都生效；有依赖延误时顶栏出红色「n 处延误」，点击跳到甘特。
- **导出**：「复制大纲」照旧；「导出」菜单里有「下载大纲 .md」和「打印 / PDF」（新标签页打开 `/projects/:id/print?print=1`）。

## 依赖

侧栏「依赖」一节列出前置任务（可 × 移除）、「添加前置」搜索框（按标题搜本项目节点，会形成循环的选项用 core 的 `dependencyWouldCycle` 判断后禁用）和只读的后续任务；前置未完成时显示「等待中：前置任务未完成」（core `isWaitingOnDependency`）。调用 `POST/DELETE /api/dependencies`，成功后重新拉一次项目取依赖和延误。

## Claude 对话

顶栏「Claude」按钮或 `⌘J / Ctrl+J` 打开右侧面板（`editor/ChatPanel.tsx`，状态在 `state/chat.ts`）。会话默认只看本项目（`GET /api/assistant/sessions?projectId=`），标题由服务器生成。发送走 `POST /api/assistant/sessions/:id/messages`，用 `fetch` + `ReadableStream` 解析 `text/event-stream`（事件 `text` / `tool` / `done` / `error`）。文本按轻量 Markdown 渲染（段落、列表、粗体、行内代码）；工具调用显示成橘框小片「调用 update_node · 接口联调 · 待确认」，点开看 JSON。回复里有改动节点的工具调用时，面板会拉一次 ops（`syncOps`）让导图更新；产生待确认 / 草案时整个项目重载。服务器没配 API 密钥（`GET /api/assistant/status` 的 `configured=false` 或 503 `assistant_unconfigured`）时显示说明，提示设置 `ANTHROPIC_API_KEY`。

## 快捷键（编辑器里选中节点后）

| 键 | 动作 |
|---|---|
| Tab | 加子节点并开始输入标题 |
| Enter | 加兄弟节点 |
| Delete / Backspace | 删除（有子节点时会确认） |
| ↑ ↓ ← → | 移动选择 |
| 空格 | 展开 / 收起 |
| F2 或双击 | 改标题，Esc 取消 |
| @ | 指派负责人 |
| / | 命令面板 |
| ⌘Z / Ctrl+Z | 撤销自己的上一步 |
| ⌘J / Ctrl+J | 打开 / 关闭 Claude 对话面板 |

导图里：拖动背景平移，Ctrl/⌘ + 滚轮缩放，右下角有 +/−/适应；把节点拖到另一个节点上可以改父节点。

## 状态模型

每个打开的项目在内存里有一个 core 的 `TreeStore`。所有编辑先本地 `store.apply`（乐观更新），150ms 内的操作合并成一次 `POST /api/projects/:id/ops`。WebSocket 收到的 op 如果是自己发的就跳过，否则本地应用。服务器拒绝某个 op（版本冲突等）时重新拉取项目并弹提示。

## 云端模式

`pnpm --filter @tsai-mind/web build:cloud` 生成 `dist-cloud/index.html`：一个没有后端的单文件页面，作为 claude.ai 的 Artifact 发布（声明 `capabilities: { db: {}, sample: {}, downloads: {} }`）。代码在 `src/cloud/`，构建时 `VITE_CLOUD=true`。

- **同一套内存服务器**：和演示模式一样，`/api/*` 由 `src/demo/mockApi.ts` 的 `DemoServer` 在页面里回答（HashRouter、固定令牌、无 WebSocket）；`isDemo` 在云端也为真，`isCloud` 区分两者。云端不种演示数据，首次打开只建一个「我的第一个项目」（三个节点）。
- **持久化**（`src/cloud/persist.ts`）：状态写进 Artifact 的 `db`。文档布局 `meta/account`（账户、设置、令牌、`firstRun`）、`meta/contacts`、`projects/<id>`（项目、节点含 30 天内删除的、依赖、待确认、草案、最近 200 条活动、最近 100 条 op 及其逆操作、`serverSeq`）、`chats/<sessionId>`。每次改动后按文档 400ms 防抖整份 `set()`；`unavailable` 重试一次，其它错误显示在状态里；页面隐藏 / 卸载时尽力冲刷。单个项目文档超过 240 KB 时拒绝写入并提示 `project_too_large`，内存里的状态照常。`onSnapshot` 订阅 `projects`、`meta/*`、`chats`：别的设备写入的、已确认且 `updatedAt` 更新的文档会替换内存里的项目，并在 `window` 上派发 `tsaimind:project-changed`（`detail = { projectId, removed }`），App 收到后重载当前项目。拿不到 `db`（`claude.use('db')` 为 null）时进入「离线」：只在内存里运行，刷新即丢。
- **状态**：`useCloudStatus()` → `{ state: 'loading' | 'ready' | 'saving' | 'offline' | 'error', message?, firstRun, savedAt, saved }`，`CLOUD_STATE_LABEL` 给出中文；布局里的小药丸消费它，`main.tsx` 在没有消费者时渲染一个兜底的 `#cloud-status`。
- **Claude**（`src/cloud/assistant.ts`）：`POST /api/assistant/sessions/:id/messages` 仍然是 SSE，但由 `sample(turns, { onText, tools, cache: false, signal, modelTier: 'default' })` 驱动。第一条 user 轮是中文说明（用户是谁、今天日期、关键字段要确认、先 `get_tree` 再改、用大纲里的节点 id、回答简短）加当前项目的大纲（带派生值，最多约 2 万字），然后是保存的历史（最多 30 轮，总量控制在 56 KiB 内），最后是新消息。`limits().tools` 存在时提供页面工具（`src/cloud/tools.ts`，名字和说明与 `apps/server/src/tools/registry.ts` 一致：list_projects、get_tree、get_node、search_nodes、today、create_node、update_node、move_node、delete_node、set_owner、list_contacts、create_contact、add_dependency、nudge、draft_plan、list_pending_changes），每个工具以 `actor: 'claude'` 调用 `DemoServer`，所以关键字段照样进「待确认」；结果压缩到约 4 KB（get_tree 8 KB）。没有工具时说明里告诉 Claude 只能建议。`GET /api/assistant/status` 返回 `{ configured, model: 'claude.ai 内置', message? }`；拒绝码映射成中文（not_granted「你没有允许这个页面使用 Claude」、rate_limited「用得太快了，稍后再试」、refused「Claude 拒绝了这个请求」、cancelled 静默……），已流出的文字保留。
- **导出**：`exportOutline(projectId)`（`src/cloud/export.ts`）在云端用 `downloads.save({ filename: '<项目名>.md', data })`，别的构建走 Blob 链接。
- **冒烟测试**：`pnpm --filter @tsai-mind/web e2e:cloud`（先 `build:cloud`）。`e2e/cloud.mjs` 用 `page.addInitScript` 装一个假的 `window.claude`（`db` 用内存 Map + localStorage、`sample` 按脚本流式回答并调用一次 `update_node`、`downloads` 记录调用），覆盖首次种子、Tab 建节点后刷新仍在、Claude 流式 / 工具小片 / 待确认 / 确认生效、导出、跨设备快照、`db` 为 null 时的离线模式。截图 `e2e/out/cloud.png`、`cloud-chat.png`、`cloud-offline.png`。

## 校验

```sh
pnpm --filter @tsai-mind/web typecheck
pnpm --filter @tsai-mind/web build
pnpm --filter @tsai-mind/web e2e      # Playwright 冒烟测试，用 page.route 模拟后端，截图到 e2e/out/
pnpm --filter @tsai-mind/web build:demo && python3 -m http.server 8765 -d dist-demo &  # 然后 node e2e/demo.mjs
pnpm --filter @tsai-mind/web build:cloud && pnpm --filter @tsai-mind/web e2e:cloud
```

冒烟测试覆盖：导图（建节点、指派、命令面板、拖动改父节点、撤销）、大纲、甘特（条 / 依赖 / 延误渲染，拖条和拖端点各发一条 `update_node`，侧栏依赖增删和循环禁用）、按人看板（列、卡片、拖卡片改负责人、筛选）、Claude 面板（模拟的 SSE 流、工具小片、项目重载）、导出下载、打印页、设置页（`PATCH /api/me`、令牌列表）。截图：`mindmap.png`、`outline.png`、`gantt.png`、`board.png`、`chat.png`、`print.png`、`settings.png`、`today.png`、`projects.png`。

Playwright 使用预装的 Chromium（`/opt/pw-browsers/chromium`），不需要 `playwright install`。
