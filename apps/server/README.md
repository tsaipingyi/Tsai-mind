# Tsai Mind

一个人用的、导图优先的项目管理工具。项目结构像 XMind 一样用树状导图来拆，树上的每个节点都是真正的任务：有负责人、起止时间、状态和进度。网页规划，iPhone 确认和催办，Claude 直接读写计划。

| 文档 | 内容 |
|---|---|
| [docs/DESIGN.md](docs/DESIGN.md) | 产品与系统设计（主文档） |
| [docs/mcp-tools.md](docs/mcp-tools.md) | Claude 接入：MCP 服务器与工具定义 |
| [docs/design-system.md](docs/design-system.md) | 视觉规范：白底橘框 |
| [docs/schema.sql](docs/schema.sql) | PostgreSQL 数据库 schema |

## 代码结构

| 目录 | 内容 |
|---|---|
| `packages/core` | 纯 TypeScript 领域逻辑：节点类型、排序、TreeStore、汇总规则、大纲解析、确认规则、今天视图 |
| `apps/server` | Fastify REST + WebSocket + MCP（`/mcp`），PostgreSQL |
| `apps/web` | React + Vite 网页端：导图、大纲、今天、联系人、待确认 |
| `deploy/` | Dockerfile 和 docker-compose，单机部署 |

## 本地运行

需要 Node 22、pnpm 10、PostgreSQL 16。

```bash
pnpm install
pnpm --filter @tsai-mind/core build

# 数据库（本机没有 docker 时用自带脚本起一个 PG 16，端口 5433）
apps/server/scripts/pg.sh start
export DATABASE_URL=postgres://postgres@localhost:5433/tsaimind
pnpm --filter @tsai-mind/server migrate

# 生成一个访问令牌（网页登录和 Claude 接入都用它）
pnpm --filter @tsai-mind/server token:create --label "我的 MacBook" --scopes read,write,decide

# 起服务
pnpm dev:server     # http://127.0.0.1:3000
pnpm dev:web        # http://localhost:5173，用上面的令牌登录
```

测试：`pnpm test`（core 单元测试 + server 集成测试，后者需要 5433 上的 `tsaimind_test` 库，`pg.sh start` 会一并创建）。

## 接 Claude

```bash
claude mcp add --transport http tsai-mind http://127.0.0.1:3000/mcp \
  --header "Authorization: Bearer <令牌>"
```

Claude Desktop 在配置里加同一个 URL 和 header。工具清单见 [docs/mcp-tools.md](docs/mcp-tools.md)。Claude 改截止日、开始日、负责人、删除、标记完成会进「待确认」，其他直接生效。

### claude.ai 网页 / iPhone 上的 Claude（自定义连接器，OAuth）

claude.ai 的自定义连接器不能填 header，走的是 OAuth 2.1。服务器自带一个只有你一个用户的授权服务器（`src/oauth.ts`）：动态注册（RFC 7591）、授权码 + PKCE、刷新令牌轮换、吊销，以及 `/.well-known/oauth-protected-resource` 和 `/.well-known/oauth-authorization-server` 两个发现端点。

```bash
# 1. PUBLIC_URL 必须是外网可访问的 https 源（反代前面那个），claude.ai 会用它做 issuer 和回调发现
export PUBLIC_URL=https://tsaimind.example.com

# 2. 设一个授权页用的密码（交互式提示；脚本里可以加 --password）
pnpm --filter @tsai-mind/server password:set

# 3. 起服务，然后在 claude.ai → 设置 → 连接器 → 添加自定义连接器，URL 填
#    https://tsaimind.example.com/mcp
```

claude.ai 会自己注册客户端，然后跳到 `/oauth/authorize`：页面上显示客户端名、三个范围的勾选框（`decide`「允许替我确认变更」默认不勾）和密码框，输入密码点「允许」即可。签出的访问令牌 1 小时过期、刷新令牌 90 天，`GET /api/tokens` 里能看到（`kind: oauth`，带客户端名），`POST /oauth/revoke` 或 `token:revoke` 可以随时吊销。没设密码时授权页会拒绝并提示。

## App 内助手（Claude API）

网页和 iPhone 里的对话入口直接走服务端的 Claude API，用的是和 MCP 完全相同的一套工具（`src/tools/registry.ts`），所以助手改关键字段同样会进「待确认」，其他直接生效，草案先出预览。

```bash
export ANTHROPIC_API_KEY=sk-ant-...     # 不设则助手和 Claude 周摘要都关闭
export ASSISTANT_MODEL=claude-opus-5     # 可选，默认 claude-opus-5
```

请求用自适应思考、流式输出，并开启服务端拒答回退（`fallbacks: "default"`）。系统提示里放账号名、今天日期、三条规则和当前项目的大纲，后面打一个提示缓存断点，对话历史跟在后面。

```
GET    /api/assistant/status                       {configured, model}
GET    /api/assistant/sessions                     [{id, title, projectId, updatedAt, lastText}]
POST   /api/assistant/sessions {projectId?}        新会话
GET    /api/assistant/sessions/:id                 {session, messages:[{id, role, text, toolCalls:[{name, input, resultText, isError}]}]}
DELETE /api/assistant/sessions/:id
POST   /api/assistant/sessions/:id/messages {text, projectId?}   → text/event-stream
       event: text   data: {"delta":"…"}
       event: tool   data: {"name":"update_node","input":{…},"result":{…}}   每完成一次工具调用一条；结果超过 2 KB 时是 {truncated:true, text}
       event: done   data: {"messageId":"…","text":"完整回复"}
       event: error  data: {"message":"…"}
```

没配 key 时发消息返回 503 `{error:"assistant_unconfigured"}`。工具以 actor `claude` 和当前令牌的范围运行（令牌没有 `decide` 就看不到 `decide_change` / `apply_plan_batch`），一轮最多 12 次工具调用。会话标题取第一条消息的前 30 个字；每一轮的内容块（含 tool_use / tool_result）原样存进 `assistant_message`，下一轮原样回放。

## 设置

```
PATCH /api/me {name?, timezone?, settings?: {notifications?: {dueSoon, overdue, nudgeDue, digest}, nudgeTemplate?, keyFields?, requireConfirmation?}}
```

返回合并后的账号。`requireConfirmation: false` 时 Claude 的所有修改直接生效；`keyFields` 从 `dueDate` / `startDate` / `ownerId` / `delete` / `status_done` 里挑哪些要确认。这两项和 core 的 `splitPatch` / `opNeedsConfirmation` 是同一套规则，MCP 和助手都遵守。`nudgeTemplate` 传 `null` 恢复默认催办模板。

## 推送到 iPhone

`src/push.ts` 用 Expo 推送服务发通知（`EXPO_ACCESS_TOKEN` 可选）。App 拿到 Expo push token 后注册设备：

```
POST   /api/devices        {platform:"ios", pushToken:"ExponentPushToken[...]", name?}   按 pushToken 去重
GET    /api/devices
DELETE /api/devices/:id
```

每条推送都带 `data: {kind, nodeId?, changeId?, batchId?, projectId?, notificationId}` 和 `categoryId`，App 按类别挂通知动作：

| categoryId | 什么时候 | 卡片动作 → 调用 |
|---|---|---|
| `change` | Claude 提议改关键字段（每个节点一条） | 确认 / 拒绝 → `POST /api/changes/:id/approve` / `reject` |
| `batch` | Claude 生成草案 | 打开预览 |
| `due` | 每天 09:00 「今天到期 n 项、逾期 m 项」 | 完成 / 推迟一天 → `POST /api/nodes/:id/done` / `postpone {days}` |
| `nudge` | 每天 09:00 「该催了：…」 | 打开 |
| `digest` | 周一 08:00 「本周计划」：配置了 `ANTHROPIC_API_KEY` 时由 Claude 根据这一周的逾期、本周到期、待确认、该催办、上周完成数写成 3–5 行；没配或出错时退回「本周到期 n、逾期 m、待确认 k」 | 打开 |
| `dependency` | 一条 op 提交后，某个前置任务的截止日刚刚越过后续任务的开始日：「「前置」延到 10/5，晚于「后续」的开始日 9/15，晚 20 天」；同一对节点、同样的日期不会重复推，日期再往后挪才会再推一次 | 打开节点 |

定时任务（`src/scheduler.ts`）每分钟按 `TZ_NAME` 检查一次，发过的会记在 `notification` 表（kind + 日期），重启不会重发。`account.settings.notifications` 里 `dueSoon` / `overdue` / `nudgeDue` / `digest` 四个开关默认开；变更和草案的推送不能关。手动触发：`POST /api/notifications/run?kind=daily|weekly`（需要 `decide` 范围）。周摘要的正文存在 `notification.payload.text`，`payload.source` 标记是 `claude` 还是 `template`。

依赖相关：`POST /api/dependencies` 和 MCP / 助手的 `add_dependency` 会拒绝形成循环的依赖（409 `dependency_cycle`）；`GET /api/projects/:id` 和 `get_tree`（json）额外返回 `criticalPath`（从根一路沿最晚截止的子节点走到叶子的节点 id）和 `slips`（当前所有延误的依赖），都是算出来的，不存库。`GET /api/notifications?unread=1`、`POST /api/notifications/:id/read` 给 App 读列表和标已读。

## 部署

`deploy/docker-compose.yml`：Postgres + server + 每日备份。复制 `deploy/.env.example` 为 `deploy/.env` 填好后 `docker compose -f deploy/docker-compose.yml up -d`，前面放一个 TLS 反代。
