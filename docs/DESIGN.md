# Tsai Mind 设计文档

> 用思维导图的方式拆项目，用任务系统的方式管人和时间，网页和 iPhone 随时改、随时确认，Claude 可以直接读写计划。

配套文档：[Claude 接入与 MCP 工具](mcp-tools.md) · [视觉规范：白底橘框](design-system.md) · [数据库 schema](schema.sql)

## 0. 定位

Tsai Mind 是你一个人用的项目管理工具。项目结构像 XMind 一样用树状导图来拆，但树上的每一个节点都是一个真正的任务对象，带负责人、起止时间、状态和进度。

**只有一个账号：你。** 你指派任务的那些人（同事、外包、供应商）是「联系人」，他们不登录、不装 App，Tsai Mind 是你管他们的本子，不是他们的工作台。以后要是想让他们也进来，把联系人升级成账号就行，数据模型已经留了位置。

三个入口，各管一件事：

| 入口 | 管什么 | 典型动作 |
|---|---|---|
| 网页 | 规划 | 拆结构、排期、周回顾、审草案 |
| iPhone App | 随手改、确认 | 今天要盯什么、改状态、确认 Claude 的调整、一键催办 |
| Claude | 对话式编辑 | 「把上线推到 10/15」「帮我把 Q4 拆出来」「这周谁会延」 |

三个入口读写同一份数据。

## 1. 为什么不继续用 XMind

| 需求 | XMind 现状 | Tsai Mind 的做法 |
|---|---|---|
| 给每个子任务指定负责人 | 只能靠标签或备注，没有「人」这个对象，无法按人筛选 | 节点内建负责人字段，按人筛选、按人看板、一键生成催办消息 |
| 管理时间进度 | 有任务信息面板，但没有汇总、没有甘特、没有依赖、没有提醒 | 节点带起止日期和进度，父节点自动汇总，同一棵树可以切成甘特图，逾期提醒 |
| 网页和 App 同时调整 | 文件式同步，手机端基本只能看 | 操作日志同步，离线可编辑，iPhone 上能改能确认 |
| 调整需要「确认」 | 没有这个概念 | Claude 或批量操作改了关键字段，先进「待确认」，你在 iPhone 上一键确认 |
| 让 Claude 帮忙改 | 只能导出文件让 Claude 看，改完再手动搬回去 | 自带 MCP 服务器，Claude 直接读写，大改动先出草案再一键应用 |

保留 XMind 的优点：一屏看全局、拖拽即重组、键盘快速录入。不做 .xmind 导入，老项目用「贴大纲」或让 Claude 重建。

## 2. 你一周怎么用它

| 时间 | 做什么 | 在哪 |
|---|---|---|
| 周一 08:00 | 收到周摘要：本周到期、已逾期、待确认 | iPhone 推送 |
| 每天早上 | 看「今天」：今天到期的、逾期的、等我确认的 | iPhone |
| 白天随时 | 改状态、改进度、给某人催办 | iPhone |
| 白天随时 | 「把 X 的截止日改到 Y」「Q4 拆一下」 | Claude |
| Claude 改完 | iPhone 收到「Claude 提议把 X 延到 Y」，点确认 | iPhone 通知卡片 |
| 周五 | 网页开导图过一遍，调下周，看关键路径 | 网页 |

## 3. 核心概念与数据模型

### 3.1 对象一览

```
Project（项目，对应一张导图）
 └─ Node（节点 = 任务，树状）
     ├─ Dependency（前置任务）
     ├─ Change（待确认的变更：来自 Claude 或批量操作）
     ├─ Note（备注，时间线式）
     └─ Activity（操作记录，标记是你直接做的还是经 Claude 做的）
 └─ PlanBatch（Claude 的批量草案，应用前不落到 Node）
Contact（联系人：你指派任务的人，不登录）
AccessToken（Claude 接入用的令牌）
```

没有 Workspace、Member、Role。只有一个用户，就是你。

### 3.2 Node：树上的每个节点都是任务

| 字段 | 类型 | 说明 |
|---|---|---|
| id | uuid | 全局唯一，客户端生成，支持离线创建 |
| project_id | uuid | 所属项目 |
| parent_id | uuid 或 null | 父节点，根节点为 null |
| rank | string | 兄弟节点排序用的分数索引，移动节点不需要重排其他节点 |
| title | text | 节点标题 |
| description | text | 详细说明，Markdown |
| kind | enum | `goal` 目标 / `task` 任务 / `milestone` 里程碑 / `note` 备注（不参与进度统计） |
| owner_id | uuid 或 null | 负责人（联系人），一个节点一个；`null` 表示你自己 |
| status | enum | `todo` / `in_progress` / `blocked` / `waiting` / `done`。`waiting` 是「等对方回」，单人管理别人时很常用 |
| progress | 0 到 100 | 叶子手动填或由状态推导；父节点自动汇总 |
| progress_mode | enum | `auto` / `manual` |
| start_date, due_date | date 或 null | 起止日期 |
| date_mode | enum | `auto` / `manual` |
| estimate_hours | number 或 null | 预估工时，作为汇总权重 |
| priority | 1 到 4 | 1 最高 |
| tags | text[] | 自由标签 |
| last_nudged_at | timestamp 或 null | 上次催办时间，节点上显示「3 天前催过」 |
| version | int | 每次修改加一；Claude 写操作必须带上 |
| created_at, updated_at, deleted_at | | 审计与软删除，30 天内可恢复 |

### 3.3 汇总规则

进度汇总（`progress_mode = auto`）：

```
parent.progress = Σ(child.progress × child.weight) / Σ(child.weight)
weight = estimate_hours，缺省时每个子节点权重为 1
kind = note 的节点不计入
```

日期汇总（`date_mode = auto`）：

```
parent.start_date = min(child.start_date)
parent.due_date   = max(child.due_date)
```

状态推导（父节点不能手动改状态）：

- 所有子节点 done，父节点 done
- 任一子节点 blocked，父节点 blocked
- 任一子节点 in_progress 或 waiting，父节点 in_progress
- 否则 todo

叶子改成 done 时进度自动 100。汇总在 core 包里同步计算，网页、iPhone、服务器三处跑同一份代码。

### 3.4 联系人与负责人

`Contact`：name、company、email、phone、avatar、备注。一个节点一个负责人，新建子节点默认继承父节点的负责人。

因为对方不登录，「指派」不需要对方接受，但要能催：

- 节点上有「催办」按钮，生成一条消息：「关于『接口联调』，原定 9/30，现在进度 10%，方便同步一下进展吗？」，iPhone 上走系统分享面板发到微信、iMessage、邮件；网页上复制到剪贴板。消息模板可以改。
- 催过之后节点记 `last_nudged_at`，显示「3 天前催过」，逾期又超过 3 天没催会提醒你。
- 「按人看板」：每人一列，看谁手上任务多、谁逾期多。联系人详情页列出他名下所有任务，跨项目。

### 3.5 依赖

`Dependency(from_node, to_node)`，只做 finish-to-start。前置任务没完成，后续任务显示「等待中」；前置任务往后拖超过后续任务开始日，后续任务标红并提醒你。不做自动顺延，连锁改日期由你或 Claude 出草案决定。

## 4. 功能设计

### 4.1 视图：一份数据，五种投影

| 视图 | 用途 | 网页 | iPhone |
|---|---|---|---|
| 导图 | 规划和拆解，主视图 | 完整编辑 | 查看，单节点编辑，小范围拖动 |
| 大纲 | 快速录入、键盘操作 | 完整编辑 | 完整编辑 |
| 甘特 | 看时间、拖动调日期、看依赖 | 完整编辑 | 查看 |
| 按人看板 | 每人一列 | 拖卡片换负责人 | 查看 |
| 今天 | 今天到期、逾期、待确认、该催的 | 是 | 是，App 的默认首页 |

导图节点上显示三样东西：负责人头像、到期日、进度环。逾期日期变红，blocked 边框变红，done 变淡，待确认的右上角一个橘点。

快捷键沿用 XMind：Tab 加子节点，Enter 加兄弟节点，Delete 删除，方向键移动焦点，空格展开收起，`@` 指派负责人，`/` 命令面板。

### 4.2 时间进度

- 侧栏设置起止日期、预估工时，手动填进度。甘特上拖动条改日期，拖条两端改长度。
- 父节点日期默认跟随子节点，也可以锁定（客户定死的交付日），锁定后显示锁图标和「子节点范围 X 到 Y」，子节点超出会警告。
- 里程碑在甘特上是菱形，在导图上是虚线框加 ◆。
- 关键路径高亮：从根到最晚截止日叶子的那条链。第三阶段做。

### 4.3 调整并确认

单人使用时，「确认」的对象不是别的成员，而是 **Claude 和批量操作**。规则：

1. 你在网页或 iPhone 上直接改，立即生效，不需要确认。所有修改 7 天内可撤销。
2. Claude 改「关键字段」（默认：due_date、start_date、owner、删除节点、标记 done），生成一条待确认变更，iPhone 收到推送，你在通知卡片上点确认或拒绝。
3. Claude 改其他字段（标题、描述、进度、标签、加子任务）直接生效，记进活动流，可撤销。
4. Claude 的批量操作（草案）无论改什么都要确认，一次确认整批。
5. 哪些是关键字段、Claude 要不要全部走确认，设置里可以调；也可以关掉确认，全部直接生效。

变更 `Change`：node_id、field、old_value、new_value、reason、source（`claude` / `batch`）、status（pending / approved / rejected / expired）、decided_at。

细节：

- 同一节点同一字段只允许一条待确认；Claude 再提会拿到已有的那条。
- 待确认 7 天没处理自动过期，通知你。
- 你在待确认期间自己改了同一字段，那条待确认自动作废。
- 网页有「待确认」面板，多选后一次确认。

### 4.4 通知

只发给你一个人，全部在 iPhone 上，能在通知卡片上直接操作。

| 事件 | 卡片上能做什么 | 可关 |
|---|---|---|
| Claude 提议改关键字段 | 确认 / 拒绝 | 否 |
| Claude 草案生成 | 打开预览 | 否 |
| 到期前 1 天、当天 | 标记完成 / 推迟一天 | 是 |
| 逾期每天 09:00 汇总一条 | 打开「今天」 | 是 |
| 逾期超过 3 天且 3 天没催 | 催办（打开分享面板） | 是 |
| 前置任务延误影响后续任务 | 打开节点 | 否 |
| 周摘要（周一 08:00） | 打开「今天」 | 是 |

邮件不做，一个人用推送就够。

### 4.5 搜索与筛选

- 全局搜索：标题、描述、备注，结果带路径。
- 筛选条：负责人、状态、到期范围、标签、「待确认」、「逾期」、「该催了」，可组合、可保存为视图。
- 命令面板（`/`）：所有操作都能打字触发。

### 4.6 新建项目

不做 XMind 导入。新项目三种起法：

- **空白**：只有一个根节点，Tab 开始拆。
- **贴大纲**：把一段缩进的 Markdown 贴进去，每行一个节点，缩进就是层级，行尾可以带 `@负责人`、日期、状态。语法和 Claude 用的大纲格式一样（见 [mcp-tools.md](mcp-tools.md)）。
- **让 Claude 拆**：在 Claude 里说「新建一个项目叫 X，帮我拆到第三层」，Claude 用 `create_project` 带大纲建好。

导出只做大纲 Markdown 和 PDF 报告，不做 .xmind。

## 5. Claude 接入

完整工具定义见 [mcp-tools.md](mcp-tools.md)。三个决定：

**Tsai Mind 自带一个远程 MCP 服务器。** 单人使用，认证用个人访问令牌（PAT）：设置页生成一个令牌，Claude Code 一条命令加上，Claude Desktop 填进配置。claude.ai 网页和手机端的自定义连接器需要 OAuth，第二阶段再补一个只有你一个用户的最小 OAuth 实现。

**Claude 改关键字段要你确认，其他直接生效。** 见 4.3。活动流里 Claude 做的事标记「经 Claude」，可以单独筛出来看，都可撤销。

**大改动先出草案。** 「帮我把 Q4 拆出来」生成一个草案批次，网页或 iPhone 上显示对比图，橘色标出新增和修改，点一次「应用」才生效。

大纲格式是关键：`get_tree` 把项目输出成一段缩进的 Markdown，Claude 读一遍就理解整个项目；改完用同一格式交回来，系统做 diff。

第三阶段在网页和 iPhone 里加一个对话入口，用同一套工具，服务端直接调 Claude API。周摘要也由 Claude 生成。

## 6. 网页 + iPhone 同步

```
网页 (React)          iPhone (React Native)     Claude (MCP 客户端)
   │ core 包              │ core 包                  │
   │ IndexedDB            │ SQLite                   │ PAT
   └────────┬─────────────┘                          │
            │ WebSocket + HTTPS                       │ HTTPS /mcp
     API + MCP 服务 (Node.js，同一进程)
            │
   PostgreSQL     推送：APNs
```

- 客户端所有修改先写本地库，再进「待发送队列」，UI 立刻响应。iPhone 离线能改，联网后自动同步。
- 每个操作是一条 `Op`：`{op_id, client_id, project_id, type, payload, base_version, actor}`。服务器按项目串行应用，分配递增的 `server_seq`，广播给在线客户端。客户端记住最大 seq，重连时补拉。
- 只有一个用户，冲突只会发生在「网页和 iPhone 同时改」或「Claude 用旧版本写」：
  - 同一字段：最后写入者胜，另一端收到提示可一键恢复。
  - move_node 形成环：服务器拒绝，客户端回滚。
  - Claude `version` 不符：拒绝并返回最新内容，Claude 重读再改。
- 不需要 Redis、不需要 CRDT。描述字段是普通文本，最后写入者胜。

## 7. 视觉：白底橘框

完整规范见 [design-system.md](design-system.md)。原则四条：

1. 白是底，橘是框。页面纯白，节点、卡片、面板用橘色描边分层，不用大面积橘色填充。
2. 橘色只出现在四种地方：节点边框、当前选中、待确认标记、主要按钮。
3. 任务状态用一套独立的低饱和色，不和橘色打架。
4. 不用阴影表达层级，用线和留白。深色模式第一版不做。

## 8. 技术选型

| 层 | 选择 | 理由 |
|---|---|---|
| 网页 | React + TypeScript + Vite | 导图用 SVG + 自写树布局，甘特用 Canvas |
| iPhone | React Native（Expo），只出 iOS | 和网页共享 core 包；TestFlight 自用不上架 |
| 仓库 | pnpm monorepo | `packages/core`、`apps/web`、`apps/mobile`、`apps/server` |
| 后端 | Node.js（Fastify）+ TypeScript，API 和 MCP 同一进程 | core 包在服务器复用 |
| MCP | 官方 TypeScript MCP SDK，Streamable HTTP，PAT 认证 | |
| 数据库 | PostgreSQL | 树用 parent_id + rank，递归 CTE |
| 实时 | WebSocket | 单实例，不需要 Redis |
| 登录 | 邮箱魔法链接，只有你一个账号 | |
| 推送 | Expo Notifications（APNs） | |
| App 内助手 | Claude API，`claude-opus-5`，tool runner | 复用 MCP 的工具函数 |
| 部署 | 一台小 VPS，Docker Compose 起 Postgres + server；每天备份到对象存储 | 数据在自己手里 |

Supabase 不再有明显优势：单用户登录很简单，MCP 用 PAT，自建反而少一层。

## 9. API 草案

```
GET    /projects                          项目列表
POST   /projects                          {name, outline?} 空白或贴大纲
GET    /projects/:id/export.md            导出大纲 Markdown
GET    /projects/:id/tree                 整棵树
GET    /projects/:id/outline              大纲格式（和 MCP get_tree 一致）
GET    /projects/:id/ops?since=:seq       补拉操作日志
POST   /projects/:id/ops                  批量提交 Op
GET    /projects/:id/activity?since=      活动流

PATCH  /nodes/:id                         改字段
POST   /nodes/:id/move                    {parent_id, rank}
DELETE /nodes/:id                         软删除
POST   /nodes/:id/nudge                   生成催办消息，记 last_nudged_at
POST   /ops/:id/undo                      撤销

GET    /contacts  POST  PATCH  DELETE     联系人
GET    /contacts/:id/nodes                某人名下所有任务

GET    /changes?status=pending            待确认
POST   /changes/:id/approve | reject
POST   /changes/batch                     [{id, decision}]

POST   /projects/:id/plan-batches         {parent_id, outline, mode} → 草案
GET    /plan-batches/:id
POST   /plan-batches/:id/apply | discard

GET    /today                             今天：到期、逾期、待确认、该催的
GET    /digest                            周摘要
GET    /tokens  POST  DELETE              个人访问令牌

WS     /realtime                          {type:"op", server_seq, op}
MCP    /mcp                               Streamable HTTP，Authorization: Bearer <PAT>
```

## 10. 分阶段路线

### 第一阶段：网页替代 XMind，Claude 能读能改（已完成）

- 新建项目：空白或贴大纲
- 导图 + 大纲视图，XMind 同款快捷键，白底橘框
- 联系人、负责人、起止日期、状态、进度，自动汇总
- 「今天」视图
- 网页端，多设备实时同步
- MCP：全部读工具、单节点写工具、PAT 认证、Claude Code 和 Claude Desktop 接入
- 一台 VPS 部署，每日备份

验收：把手上的项目用贴大纲建进来，一周不再打开 XMind；在 Claude Code 里让 Claude 改一个日期、加三个子任务。

### 第二阶段：iPhone、确认、草案（已完成，待真机验证）

- iPhone App（Expo，TestFlight）：今天、待确认、节点详情、改状态和进度、催办分享、导图查看
- 待确认机制与推送，通知卡片上直接确认
- 撤销
- 离线队列
- MCP：`draft_plan` / `apply_plan_batch`，草案预览页（已完成，随第一阶段一起做了）
- 最小 OAuth（单用户），接 claude.ai 自定义连接器（已完成）

验收：Claude 在 Claude Code 里改截止日，iPhone 弹通知，卡片上点确认，网页上看到生效；让 Claude 拆一个季度计划，iPhone 上一键应用。

### 第三阶段：时间管理深化、App 内助手（已完成，待真机验证）

- 甘特视图，拖动改日期，关键路径
- 依赖与延误提醒
- 按人看板
- 网页和 iPhone 内的 Claude 对话入口，周摘要由 Claude 生成
- 导出大纲 Markdown、PDF 报告

之后按需要：iOS 桌面小组件（今天到期）、Google Calendar 同步、项目模板、深色模式、让同事登录。

## 11. 风险与取舍

- iPhone 上的导图编辑体验天生受限，所以 App 的定位是「今天、改状态、确认、催办」，不追求在手机上重排整棵树。
- Claude 改关键字段要确认，会有一点摩擦；但确认只是通知卡片上点一下，而且可以在设置里关掉。
- Claude 批量改动的风险是「一句话删掉半棵树」，所以 replace 模式必须在预览页勾选删除确认，所有删除都是软删除。
- 只出 iOS 意味着安卓上只能用网页，网页要做好手机浏览器的响应式。
- 单 VPS 单实例是单点，靠每日备份兜底；一个人用，可以接受。

## 12. 已定的事

| 事项 | 决定 |
|---|---|
| 使用者 | 你一个人，一个账号；负责人是不登录的联系人 |
| App | 只出 iOS，TestFlight 自用 |
| 后端 | 自建，一台 VPS，Docker Compose |
| Claude 认证 | 第一阶段 PAT；第二阶段加单用户 OAuth 接 claude.ai |
| Claude 权限 | 关键字段走确认，其他直接生效，设置里可调 |
| 周摘要 | 周一 08:00，只推送不发邮件 |
| 域名 | 暂用 `tsaimind.app`，MCP 端点 `/mcp` |
