# Tsai Mind 设计文档

> 用思维导图的方式拆项目，用任务系统的方式管人和时间，网页和手机随时改、随时确认，Claude 可以直接读写计划。

配套文档：[Claude 接入与 MCP 工具](mcp-tools.md) · [视觉规范：白底橘框](design-system.md) · [数据库 schema](schema.sql)

## 0. 定位

Tsai Mind 是一个「导图优先」的项目管理工具。项目结构仍然像 XMind 一样用树状导图来拆，但树上的每一个节点都是一个真正的任务对象，带负责人、起止时间、状态和进度。

三个入口，各管一件事：

| 入口 | 管什么 | 典型动作 |
|---|---|---|
| 网页 | 规划 | 拆结构、排期、周会过进度、批量确认 |
| App | 执行与确认 | 看我的任务、改状态、确认别人的调整、接受指派 |
| Claude | 对话式编辑 | 「把上线推到 10/15」「帮我把 Q4 拆出来」「准备周会」 |

三个入口读写同一份数据，走同一套权限和确认规则。

## 1. 为什么不继续用 XMind

| 需求 | XMind 现状 | Tsai Mind 的做法 |
|---|---|---|
| 给每个子任务指定负责人 | 只能靠标签或备注，没有「人」这个对象，无法按人筛选、无法通知 | 节点内建 Owner + 协作者字段，有「我的任务」视图，改负责人会通知并要求对方接受 |
| 管理时间进度 | 有任务信息面板，但没有汇总、没有甘特、没有依赖、没有提醒 | 节点带起止日期和进度，父节点自动汇总，同一棵树可以切成甘特图，逾期自动提醒 |
| 网页和 App 同时调整 | 文件式同步，多人同时改容易覆盖，手机端基本只能看 | 操作日志同步，离线可编辑，冲突按字段级合并，手机端可编辑、可确认 |
| 调整需要「确认」 | 没有审批概念，谁打开文件谁就能改 | 变更提案机制：改别人任务的关键字段要由负责人或项目经理确认 |
| 让 Claude 帮忙改 | 只能导出文件让 Claude 看，改完再手动搬回去 | 自带 MCP 服务器，Claude 直接读写，大改动先出草案再一键应用 |

保留 XMind 的优点：一屏看全局、拖拽即重组、键盘快速录入。并且支持 .xmind 文件导入导出，老项目可以直接搬进来。

## 2. 谁在什么时候用它

先把人和节奏想清楚，功能才有优先级。

**三种人**

- **你（项目经理 / 老板）**：开项目、拆结构、定负责人和日期；每天在手机上过一遍「等我确认」；周会用网页过整棵树。最在乎的是「一眼看到哪里卡住了」和「别人改了什么我知道」。
- **执行成员**：早上在手机上看「我的任务」，做完改状态；要延期就在自己节点上改，或者对别人的节点提提案；被指派了新任务要点「接受」。最在乎的是「别让我填太多东西」。
- **外部查看者（客户、老板的老板）**：只看不改，偶尔评论。

**一周的节奏**

| 时间 | 谁 | 做什么 | 在哪 |
|---|---|---|---|
| 周一 08:00 | 所有人 | 收到周摘要：本周到期、已逾期、等我确认 | 推送 + 邮件 |
| 每天 | 成员 | 改状态、改进度、提延期 | App |
| 每天 | 你 | 处理「等我确认」，通常一分钟 | App 通知卡片 |
| 周三 | 你 | 「Claude，帮我看看开发这条线哪里会延」 | Claude |
| 周五周会 | 你 + 成员 | 网页开导图，过待确认面板，调下周 | 网页 |
| 随时 | 你 | 「把 X 的截止日改到 Y」 | Claude |

## 3. 核心概念与数据模型

### 3.1 对象一览

```
Workspace（团队）
 └─ Project（项目，对应一张导图）
     └─ Node（节点 = 任务，树状）
         ├─ Assignment（负责人 / 协作者 / 审核人）
         ├─ Dependency（前置任务）
         ├─ Change（变更提案，等待确认）
         ├─ Comment（讨论）
         └─ Activity（操作记录，标记是人做的还是经 Claude 做的）
     └─ PlanBatch（Claude 的批量草案，应用前不落到 Node）
Member（成员）
AccessToken（Claude 等外部接入的令牌）
```

### 3.2 Node：树上的每个节点都是任务

| 字段 | 类型 | 说明 |
|---|---|---|
| id | uuid | 全局唯一，客户端生成，支持离线创建 |
| project_id | uuid | 所属项目 |
| parent_id | uuid 或 null | 父节点，根节点为 null |
| rank | string | 兄弟节点排序用的分数索引（fractional index），移动节点不需要重排其他节点 |
| title | text | 节点标题，导图上显示的文字 |
| description | rich text | 详细说明，用 CRDT 存，多人可同时编辑 |
| kind | enum | `goal` 目标 / `task` 任务 / `milestone` 里程碑 / `note` 备注（不参与进度统计） |
| owner_id | uuid 或 null | 主负责人，一个节点只有一个 |
| status | enum | `todo` / `in_progress` / `blocked` / `review` / `done` |
| progress | 0 到 100 | 叶子节点手动填写或由状态推导；父节点自动汇总 |
| progress_mode | enum | `auto` 由子节点汇总 / `manual` 手动指定 |
| start_date, due_date | date 或 null | 起止日期 |
| date_mode | enum | `auto` 由子节点推导 / `manual` 手动锁定 |
| estimate_hours | number 或 null | 预估工时，作为汇总权重 |
| priority | 1 到 4 | 1 最高 |
| tags | text[] | 自由标签 |
| version | int | 每次修改加一，用于冲突检测；Claude 写操作必须带上 |
| created_by, updated_by, created_at, updated_at | | 审计字段 |
| deleted_at | timestamp 或 null | 软删除，30 天内可恢复 |

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
- 任一子节点 in_progress 或 review，父节点 in_progress
- 否则 todo

叶子节点如果状态改为 done，进度自动设为 100；改回其他状态时保留原进度。

汇总在 core 包里同步计算，客户端本地就能算出来，不等服务器；服务器落库时再算一遍做校验。

### 3.4 负责人与协作者

`Assignment` 表记录人与节点的关系，一个节点可以有多条：

| role | 含义 | 权限 |
|---|---|---|
| owner | 主负责人，唯一 | 直接改本节点和子树的所有字段，确认别人对本节点提出的变更 |
| contributor | 协作者 | 直接改本节点的状态和进度，改其他字段要提变更 |
| reviewer | 审核人 | 节点进入 review 状态时收到通知，可以把它改成 done 或退回 |

负责人继承：新建子节点时默认继承父节点的 owner，可以改。改 owner 时给新负责人发通知，对方在 App 上点「接受」才生效，未接受前节点显示「待接受」，头像虚线描边。三天没接受，提醒指派人。

### 3.5 依赖

`Dependency(from_node, to_node, type)`，目前只做 finish-to-start：前置任务没完成，后续任务显示为「等待中」。前置任务 due_date 往后拖，如果超过后续任务 start_date，后续任务标红并提醒它的负责人。不做自动顺延，因为顺延会连锁改一串别人的日期，这种事应该由人（或 Claude 出草案）来决定。

## 4. 功能设计

### 4.1 视图：一份数据，五种投影

所有视图读同一棵树，切换视图不需要重新组织数据。

| 视图 | 用途 | 网页 | App |
|---|---|---|---|
| 导图 | 规划和拆解，主视图 | 完整编辑 | 查看，单节点编辑，小范围拖动 |
| 大纲 | 快速录入、键盘操作 | 完整编辑 | 完整编辑 |
| 甘特 | 看时间、拖动调日期、看依赖 | 完整编辑 | 查看 |
| 看板 | 按状态或按人分列 | 拖卡片改状态 | 拖卡片改状态 |
| 我的任务 | 每个人自己的待办，按到期日排，跨项目 | 是 | 是，App 的默认首页 |

导图节点上直接显示三样东西：负责人头像、到期日、进度环。逾期的节点日期变红，blocked 的节点边框变红，done 的节点变淡，有待确认变更的节点右上角一个橘点。

快捷键沿用 XMind 习惯：Tab 加子节点，Enter 加兄弟节点，Delete 删除，方向键移动焦点，空格展开收起，`@` 指派负责人，`/` 打开命令面板。

### 4.2 分任务负责人

- 选中节点按 `@` 弹出成员列表直接指定；把成员头像拖到节点上也可以。
- 按人筛选：点顶部某个头像，导图只高亮这个人的节点，其他节点变淡。
- 「按人看板」：每人一列，看谁的任务多、谁的任务逾期。
- 负载提示：某人本周到期的任务预估工时超过 40 小时，头像旁显示警告。
- 成员离开项目时，名下任务列成清单，逐个转交。

### 4.3 时间进度

- 节点侧栏设置起止日期、预估工时，手动填进度。甘特上拖动条改日期，拖条两端改长度。
- 父节点日期默认自动跟随子节点，也可以锁定（比如客户定死的交付日），锁定后子节点超出范围会警告，锁定字段显示锁图标和「子节点范围 X 到 Y」。
- 里程碑在甘特图上是一个菱形，在导图上是虚线框加 ◆。
- 「关键路径」高亮：从根到最晚 due_date 叶子的那条链，甘特上加粗，导图上连线变粗。第三阶段做。

### 4.4 调整并确认：变更提案

这是和 XMind 最大的区别。规则只有四条：

1. 改自己负责的节点，直接生效。
2. 改别人负责的节点，如果改的是「关键字段」（默认：owner、due_date、start_date、status 改成 done、删除节点），生成一条变更提案，等负责人确认。
3. 项目经理（manager 角色）改任何节点直接生效，但会通知负责人。
4. 非关键字段（title、description、tags、progress）任何协作者都直接改。

哪些字段算关键字段，项目设置里可以调。Claude 做的修改走完全一样的规则。

变更提案 `Change`：

| 字段 | 说明 |
|---|---|
| node_id | 目标节点 |
| field | 改的字段 |
| old_value, new_value | 改前改后 |
| reason | 提案人写的理由 |
| proposed_by, actor_type | 提案人，以及是人直接提的还是经 Claude 提的 |
| status | pending / approved / rejected / withdrawn |
| decided_by, decided_at, decision_note | 谁决定、何时、留言 |

确认流程：

```
协作者在 App 上把「接口联调」的截止日从 9/30 改成 10/5
  → 生成 Change(pending)，节点上显示橘点，导图上其他人看到的仍是 9/30
  → 负责人手机收到推送：「王芳提议把接口联调延后 5 天，理由：后端接口还没出」
  → 负责人在通知卡片上点「确认」或「拒绝」，也可以在网页端的「待确认」列表批量处理
  → 确认后变更真正落到节点，广播给所有人，Activity 记一条
  → 拒绝后提案人收到通知，节点恢复无标记
```

细节：

- 同一节点同一字段只允许一条 pending 提案；再提会提示「已有一条待确认的提案」并显示它。
- 提案 7 天没人处理，提醒负责人；14 天自动过期为 withdrawn，通知提案人。
- 负责人如果在提案期间自己改了同一字段，提案自动作废，通知提案人「负责人已改为 X」。
- 项目经理的「待确认」面板可以多选后一次确认或拒绝，周会用。

### 4.5 通知矩阵

| 事件 | 通知谁 | 渠道 | 可关 |
|---|---|---|---|
| 被指派为负责人 | 被指派人 | 推送 + 邮件 | 否 |
| 有人对我的节点提提案 | 负责人 | 推送 | 否 |
| 我的提案被确认 / 拒绝 | 提案人 | 推送 | 否 |
| 我的节点进入 review | 审核人 | 推送 | 是 |
| 到期前 1 天、当天 | 负责人 | 推送 | 是 |
| 逾期每天 09:00 | 负责人 | 推送 | 是 |
| 逾期 3 天以上 | 项目经理 | 推送 | 是 |
| 前置任务延误影响到我 | 后续任务负责人 | 推送 | 否 |
| 我的节点被评论 | 负责人 | 推送 | 是 |
| Claude 经我的授权做了批量应用 | 我 | 推送 | 否 |
| 周摘要 | 所有人 | 推送 + 邮件 | 是 |

推送内容尽量让人在通知卡片上就能操作：确认、拒绝、接受、标记完成，不用打开 App。

### 4.6 搜索与筛选

- 全局搜索框：搜标题、描述、评论，结果带路径（祖先标题串）。
- 筛选条：负责人、状态、到期范围、标签、「有待确认」、「逾期」，可组合，可保存为视图。
- 命令面板（`/`）：所有操作都能打字触发，「指派给陈小明」「改到下周五」。

### 4.7 XMind 导入导出

`.xmind` 文件是一个 zip，新版里面是 `content.json`，旧版是 `content.xml`。导入时：

| XMind | Tsai Mind |
|---|---|
| sheet | project |
| topic 树 | node 树，children 顺序转成 rank |
| topic.title | title |
| notes | description |
| markers `task-*` | progress（task-start 0、task-quarter 25、task-half 50、task-3quar 75、task-done 100） |
| markers `priority-*` | priority |
| labels | tags |
| 关联线 | dependency（导入后需人工确认方向） |

负责人和日期 XMind 里没有，导入后在「未分配」筛选里批量补，或者让 Claude 按大纲补。导出回 .xmind 时把负责人和日期写进 notes 首行，保证信息不丢。

## 5. Claude 接入

完整的工具定义见 [mcp-tools.md](mcp-tools.md)。这里只说设计上的三个决定。

**Tsai Mind 自带一个远程 MCP 服务器。** 你在 claude.ai、Claude Code、Claude Desktop 或 Cowork 里把它加成连接器，登录一次，之后就能用自然语言读写计划。这和你现在用 Addness 连接器是同一种方式。

**Claude 走和你一样的规则。** 令牌代表你这个人，Claude 做的事按你的权限执行；改别人的关键字段一样变成提案。所以不需要为 Claude 单独设计一套安全策略，也不用担心 Claude 越权。活动流里 Claude 做的事显示为「蔡（经 Claude）」，可以单独筛出来看。

**大改动先出草案，你一次确认。** 「帮我把 Q4 拆出来」会生成几十个节点，这类操作不直接落库，而是生成一个草案批次，网页或 App 上显示对比图，橘色标出新增和修改，你点一次「应用」才生效。小改动（改一个字段、加一个子任务）直接生效。

大纲格式是关键：`get_tree` 能把项目输出成一段缩进的 Markdown，Claude 读一遍就理解整个项目；改完再用同一格式交回来，系统做 diff。这比让 Claude 一个节点一个节点调工具快得多，也更容易检查。

第三阶段在网页和 App 里加一个对话入口，用的是同一套工具，服务端直接调 Claude API。周摘要邮件也由这条链路生成。

## 6. 网页 + App 同步

### 6.1 总体

```
网页 (React)          App (React Native)        Claude (MCP 客户端)
   │ core 包              │ core 包                  │
   │ IndexedDB            │ SQLite                   │ OAuth 2.1
   └────────┬─────────────┘                          │
            │ WebSocket（实时）+ HTTPS                │ HTTPS /mcp
     API 服务 (Node.js)  ◄──────────────────────── MCP 服务（同一进程）
            │
   PostgreSQL（数据）  Redis（在线状态、广播）  对象存储（附件）
            │
   推送：APNs / FCM / 邮件
```

### 6.2 离线优先与冲突

- 客户端所有修改先写本地库，再放进「待发送操作队列」，UI 立刻响应。
- 每个操作是一条 `Op`：`{op_id, client_id, project_id, type, payload, base_version, actor_type}`。type 包括 `create_node`、`update_field`、`move_node`、`delete_node`、`propose_change`、`decide_change`、`apply_plan_batch`。
- 服务器按项目串行应用 Op，分配全局递增的 `server_seq`，然后广播给该项目所有在线客户端。客户端保存收到的最大 `server_seq`，重连时从这个位置补拉。
- MCP 服务和网页走同一条 Op 管道，所以 Claude 改完，网页和 App 上立刻看到。

| 冲突类型 | 处理 |
|---|---|
| 同一普通字段两人同时改 | 字段级最后写入者胜；被覆盖的一方收到提示并能一键恢复 |
| description 富文本 | Yjs CRDT，天然合并 |
| move_node 形成环 | 服务器拒绝，客户端回滚 |
| 一人删除、一人编辑 | 删除胜出，但节点进回收站 30 天，编辑内容保留在恢复后的节点上 |
| 关键字段 | 走 propose_change，本来就不直接改节点，不会和别人冲突 |
| Claude 基于旧版本写入 | `version` 不符直接拒绝并返回最新内容，Claude 重读再改 |

### 6.3 权限

| 角色 | 能力 |
|---|---|
| admin | 团队设置、成员管理、令牌管理 |
| manager | 项目内一切直接生效，确认任何变更，改项目设置 |
| member | 编辑自己负责的节点，给别人的节点提变更，新建子任务 |
| viewer | 只读，可评论 |

权限判断放在 core 包里：客户端先判断给出正确的 UI（按钮变成「提议修改」），服务器再判断一次做最终把关，MCP 服务复用同一份代码。

## 7. 视觉：白底橘框

完整 token 和组件规范见 [design-system.md](design-system.md)。原则四条：

1. 白是底，橘是框。页面纯白，节点、卡片、面板用橘色描边分层，不用大面积橘色填充。
2. 橘色只出现在四种地方：节点边框、当前选中、待确认标记、主要按钮。
3. 任务状态用一套独立的低饱和色（灰、蓝、红、紫、绿），不和橘色打架。
4. 不用阴影表达层级，用线和留白。深色模式第一版不做。

界面文字 Noto Sans SC，日期和百分比用等宽字体对齐。

## 8. 技术选型

| 层 | 选择 | 理由 |
|---|---|---|
| 网页 | React + TypeScript + Vite | 导图用 SVG + 自写树布局，甘特用 Canvas |
| App | React Native（Expo） | 和网页共享 core 包，一套人维护两端 |
| 仓库 | pnpm monorepo | `packages/core`、`apps/web`、`apps/mobile`、`apps/api`、`apps/mcp` |
| 后端 | Node.js（Fastify）+ TypeScript | core 包在服务器上复用做校验 |
| MCP 服务 | 官方 TypeScript MCP SDK，Streamable HTTP | 和 API 同一进程部署，共享数据层 |
| 数据库 | PostgreSQL | 树用 parent_id + rank，递归 CTE 查子树 |
| 实时 | WebSocket + Redis pub/sub | 多实例时通过 Redis 广播 |
| 富文本协作 | Yjs | 成熟的 CRDT |
| 认证 | 邮箱魔法链接 + Google 登录；对外 OAuth 2.1 | 不用记密码 |
| App 内助手 | Claude API，`claude-opus-5`，tool runner | 复用 MCP 的同一套工具函数 |
| 推送 | Expo Notifications + 邮件（Resend 或 SES） | |
| 部署 | Docker，单机起步，数据库用托管 | |

想更快出第一版，可以用 Supabase 替代自建后端：Postgres、Realtime、Auth 都现成。代价是同步引擎的冲突逻辑和 MCP 的 OAuth 要自己在 Edge Function 里补，后者比较绕，所以如果 Claude 接入是优先项，建议直接自建。

## 9. API 草案

REST 负责查询和一次性操作，WebSocket 负责推送 Op，MCP 在 `/mcp`。

```
GET    /projects                          我的项目列表
POST   /projects/import-xmind             上传 .xmind 导入
GET    /projects/:id/export.xmind         导出

GET    /projects/:id/tree                 整棵树（含 assignment、待确认数量）
GET    /projects/:id/outline              大纲格式（Markdown，和 MCP 的 get_tree 一致）
GET    /projects/:id/ops?since=:seq       补拉操作日志
POST   /projects/:id/ops                  批量提交 Op（离线队列上传）
GET    /projects/:id/activity?since=      活动流

PATCH  /nodes/:id                         改字段；触发关键字段规则时返回 202 和 change_id
POST   /nodes/:id/move                    {parent_id, rank}
DELETE /nodes/:id                         软删除
POST   /nodes/:id/assignments             {member_id, role}
POST   /assignments/:id/accept            新负责人接受

GET    /changes?status=pending&mine=1     等我确认的
POST   /changes/:id/approve | reject      {note}
POST   /changes/batch                     [{id, decision, note}]

POST   /projects/:id/plan-batches         {parent_id, outline, mode} → 草案
GET    /plan-batches/:id                  diff
POST   /plan-batches/:id/apply | discard

GET    /me/tasks?range=week               我的任务
GET    /me/digest                         周摘要
GET    /me/tokens  POST  DELETE           个人访问令牌

WS     /realtime
  → {type:"subscribe", project_id}
  ← {type:"op", server_seq, op}
  ← {type:"presence", members:[...]}       谁在线、谁在看哪个节点

MCP    /mcp                               Streamable HTTP
       /.well-known/oauth-protected-resource
       /oauth/authorize  /oauth/token  /oauth/register
```

## 10. 分阶段路线

### 第一阶段：能替代 XMind，Claude 能读能改（约 7 周）

- 导入 .xmind
- 导图 + 大纲视图，XMind 同款快捷键，白底橘框
- 负责人、起止日期、状态、进度，自动汇总
- 「我的任务」视图
- 网页端，多人实时同步（先不做离线）
- 邮箱登录，团队邀请
- MCP 服务器：读工具全部、单节点写工具、OAuth 接入 claude.ai 和 Claude Code

验收：把现有 XMind 项目导进来，团队在网页上用一周不需要再打开 XMind；你在 claude.ai 里能问「这周谁的任务最多」并让 Claude 改一个日期。

### 第二阶段：手机、确认流程、Claude 草案（约 6 周）

- App：我的任务、等我确认、节点详情、改状态和进度、评论、推送
- 变更提案与确认，批量确认面板，提案过期与作废规则
- 负责人接受机制
- 通知矩阵、逾期提醒、周摘要
- 离线队列
- MCP：`draft_plan` / `apply_plan_batch`，草案预览页

验收：周会上你用「待确认」面板过完一周的调整；成员在手机上确认被指派的任务；你让 Claude 拆一个季度计划并在手机上一键应用。

### 第三阶段：时间管理深化、App 内助手（约 5 周）

- 甘特视图，拖动改日期，关键路径
- 依赖与延误提醒
- 按人看板、负载提示
- 网页和 App 内的 Claude 对话入口，周摘要由 Claude 生成
- 导出 .xmind、导出 PDF 报告

之后按需要：Google Calendar 同步、项目模板、跨项目视图、深色模式。

## 11. 风险与取舍

- 导图在手机上的编辑体验天生受限，所以 App 的定位是「看、改状态、确认」，不追求在手机上重排整棵树。
- 变更确认会增加摩擦，所以默认只对 4 个关键字段生效，负责人改自己的节点永远不需要确认，项目经理直接生效。
- 自动汇总和手动锁定并存会让人困惑，锁定的字段要有明确的锁图标，并显示子节点范围。
- Claude 批量改动的风险是「一句话删掉半棵树」，所以 `replace` 模式的草案必须在预览页勾选删除确认，而且所有删除都是软删除。
- MCP 的 OAuth 实现是第一阶段里最容易低估的一块，动态注册和元数据端点要一次做对，不然 claude.ai 添加连接器会失败得很隐晦。建议第一周就把这条链路打通。
- 先做网页再做 App：规划的大头在网页端，App 的价值要等有变更提案之后才体现。

## 12. 需要你拍板的事

1. **团队规模**：第一版按单团队 20 人以内设计，不做多团队切换。如果一开始就要给多个客户各开一个空间，数据模型不变，但登录和邀请流程要多一层。
2. **自建还是 Supabase**：Claude 接入是优先项的话建议自建（见第 8 节）。
3. **域名**：文档里暂用 `tsaimind.app`，MCP 端点 `mcp.tsaimind.app/mcp`。
4. **Claude 的 `decide` 权限**：默认授权页不勾选，也就是 Claude 不能替你确认提案，只能替你提。要不要放开由你定。
5. **周摘要发送时间**：暂定周一 08:00，按团队时区。
6. **App 先出哪个平台**：Expo 两端同时出没有额外成本，但上架审核 iOS 更慢，建议先 TestFlight 内测。
