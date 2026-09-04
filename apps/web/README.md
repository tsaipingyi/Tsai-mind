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

## 校验

```sh
pnpm --filter @tsai-mind/web typecheck
pnpm --filter @tsai-mind/web build
pnpm --filter @tsai-mind/web e2e      # Playwright 冒烟测试，用 page.route 模拟后端，截图到 e2e/out/
```

冒烟测试覆盖：导图（建节点、指派、命令面板、拖动改父节点、撤销）、大纲、甘特（条 / 依赖 / 延误渲染，拖条和拖端点各发一条 `update_node`，侧栏依赖增删和循环禁用）、按人看板（列、卡片、拖卡片改负责人、筛选）、Claude 面板（模拟的 SSE 流、工具小片、项目重载）、导出下载、打印页、设置页（`PATCH /api/me`、令牌列表）。截图：`mindmap.png`、`outline.png`、`gantt.png`、`board.png`、`chat.png`、`print.png`、`settings.png`、`today.png`、`projects.png`。

Playwright 使用预装的 Chromium（`/opt/pw-browsers/chromium`），不需要 `playwright install`。
