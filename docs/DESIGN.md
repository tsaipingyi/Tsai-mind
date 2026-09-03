# Tsai Mind 设计文档

> 用思维导图的方式拆项目，用任务系统的方式管人和时间，网页和手机随时改、随时确认。

## 0. 一句话定位

Tsai Mind 是一个「导图优先」的项目管理工具：项目结构仍然像 XMind 一样用树状导图来拆，但树上的每一个节点都是一个真正的任务对象，带负责人、起止时间、状态和进度。网页端负责规划和大范围调整，手机 App 负责随时看、快速改、确认别人的调整。两端共享一套实时同步引擎。

## 1. 为什么不继续用 XMind

| 需求 | XMind 现状 | Tsai Mind 的做法 |
|---|---|---|
| 给每个子任务指定负责人 | 只能靠标签或备注，没有「人」这个对象，无法按人筛选、无法通知 | 节点内建 Owner + 协作者字段，有「我的任务」视图，改负责人会通知并要求对方接受 |
| 管理时间进度 | 有任务信息面板，但没有汇总、没有甘特、没有依赖、没有提醒 | 节点带起止日期和进度，父节点自动汇总，同一棵树可以切成甘特图，逾期自动提醒 |
| 网页和 App 同时调整 | 文件式同步，多人同时改容易覆盖，手机端基本只能看 | 操作日志同步，离线可编辑，冲突按字段级合并，手机端可编辑、可确认 |
| 调整需要「确认」 | 没有审批概念，谁打开文件谁就能改 | 变更提案机制：改别人任务的关键字段要由负责人或项目经理确认 |

保留 XMind 的优点：一屏看全局、拖拽即重组、键盘快速录入。并且支持 .xmind 文件导入导出，老项目可以直接搬进来。

## 2. 核心概念与数据模型

### 2.1 对象一览

```
Workspace（团队）
 └─ Project（项目，对应一张导图）
     └─ Node（节点 = 任务，树状）
         ├─ Assignment（负责人 / 协作者 / 审核人）
         ├─ Dependency（前置任务）
         ├─ Change（变更提案，等待确认）
         ├─ Comment（讨论）
         └─ Activity（操作记录）
Member（成员）
```

### 2.2 Node：树上的每个节点都是任务

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
| version | int | 每次修改加一，用于冲突检测 |
| created_by, updated_by, created_at, updated_at | | 审计字段 |
| deleted_at | timestamp 或 null | 软删除，可恢复 |

### 2.3 汇总规则

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

### 2.4 负责人与协作者

`Assignment` 表记录人与节点的关系，一个节点可以有多条：

| role | 含义 | 权限 |
|---|---|---|
| owner | 主负责人，唯一 | 直接改本节点和子树的所有字段，确认别人对本节点提出的变更 |
| contributor | 协作者 | 直接改本节点的状态和进度，改其他字段要提变更 |
| reviewer | 审核人 | 节点进入 review 状态时收到通知，可以把它改成 done 或退回 |

负责人继承：新建子节点时默认继承父节点的 owner，可以改。改 owner 时给新负责人发通知，对方在 App 上点「接受」才生效，未接受前节点显示「待接受」。

### 2.5 依赖

`Dependency(from_node, to_node, type)`，目前只做 finish-to-start：前置任务没完成，后续任务显示为「等待中」。前置任务 due_date 往后拖，如果超过后续任务 start_date，后续任务标红并提醒它的负责人。

## 3. 功能设计

### 3.1 视图：一份数据，五种投影

所有视图读同一棵树，切换视图不需要重新组织数据。

| 视图 | 用途 | 网页 | App |
|---|---|---|---|
| 导图 | 规划和拆解，主视图 | 完整编辑 | 查看，单节点编辑，小范围拖动 |
| 大纲 | 快速录入、键盘操作 | 完整编辑 | 完整编辑 |
| 甘特 | 看时间、拖动调日期、看依赖 | 完整编辑 | 查看 |
| 看板 | 按状态或按人分列 | 拖卡片改状态 | 拖卡片改状态 |
| 我的任务 | 每个人自己的待办，按到期日排 | 是 | 是，App 的默认首页 |

导图节点上直接显示三样东西：负责人头像、到期日、进度环。逾期的节点日期变红，blocked 的节点边框变红，done 的节点变淡。

### 3.2 分任务负责人

- 在导图上选中节点，按 `@` 弹出成员列表，直接指定负责人。
- 拖一个成员头像到节点上，也能指定。
- 按人筛选：点顶部某个头像，导图只高亮这个人的节点，其他节点变淡。
- 「按人看板」视图：每人一列，看谁的任务多、谁的任务逾期。
- 成员离开项目时，他名下的任务列成清单，要求逐个转交。

### 3.3 时间进度

- 节点侧栏设置起止日期、预估工时，手动填进度。
- 甘特图直接从树生成，缩进关系就是父子关系。拖动条改日期，拖条两端改长度。
- 父节点日期默认自动跟随子节点，也可以锁定（比如客户定死的交付日），锁定后子节点超出范围会警告。
- 里程碑在甘特图上是一个菱形，在导图上是一个旗子图标。
- 提醒规则（项目级可配）：到期前 1 天、到期当天、逾期每天早上，推送给负责人；逾期 3 天以上同时推送给项目经理。
- 每周一早上给每个人一份摘要：本周到期、已逾期、等我确认的变更。

### 3.4 调整并确认：变更提案

这是和 XMind 最大的区别。规则：

1. 改自己负责的节点，直接生效。
2. 改别人负责的节点，如果改的是「关键字段」（默认：owner、due_date、start_date、status 改成 done、删除节点），生成一条变更提案，等负责人确认。
3. 项目经理（manager 角色）改任何节点直接生效，但会通知负责人。
4. 非关键字段（title、description、tags、progress）任何协作者都直接改。

哪些字段算关键字段，项目设置里可以调。

变更提案 `Change`：

| 字段 | 说明 |
|---|---|
| node_id | 目标节点 |
| field | 改的字段 |
| old_value, new_value | 改前改后 |
| reason | 提案人写的理由 |
| proposed_by | 提案人 |
| status | pending / approved / rejected / withdrawn |
| decided_by, decided_at, decision_note | 谁决定、何时、留言 |

确认流程：

```
协作者在 App 上把「接口联调」的截止日从 9/10 改成 9/15
  → 生成 Change(pending)，节点上显示一个待确认标记，导图上其他人看到的仍是 9/10
  → 负责人手机收到推送：「小王提议把接口联调延后 5 天，理由：后端接口还没出」
  → 负责人在通知卡片上点「确认」或「拒绝」，也可以在网页端的「待确认」列表批量处理
  → 确认后变更真正落到节点，广播给所有人，Activity 记一条
  → 拒绝后提案人收到通知，节点恢复无标记
```

待确认的提案在导图节点上显示为一个小黄点，点开能看 diff。项目经理有「待确认」面板，周会时一次过一遍。

### 3.5 网页和 App

网页端（React）：完整功能，主要用来规划、拆解、排期、周会过进度。

App（React Native，iOS + Android）：

- 首页是「我的任务」和「等我确认」两个列表
- 点任务进节点详情：改状态、拖进度、写评论、加子任务
- 导图视图支持缩放和查看，长按节点弹出编辑菜单
- 推送通知，通知卡片上直接能点确认
- 离线可以改，联网后自动同步

两端共享一个 TypeScript 的 `core` 包：数据模型、汇总规则、权限判断、同步引擎，保证两端行为一致。

### 3.6 XMind 导入导出

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

负责人和日期 XMind 里没有，导入后在「未分配」筛选里批量补。导出回 .xmind 时把负责人和日期写进 notes 首行，保证信息不丢。

## 4. 同步架构

### 4.1 总体

```
网页 (React)          App (React Native)
   │ core 包              │ core 包
   │ IndexedDB            │ SQLite
   └────────┬─────────────┘
            │ WebSocket（实时）+ HTTPS（拉取、认证、文件）
     API 服务 (Node.js)
            │
   PostgreSQL（数据）  Redis（在线状态、广播）  对象存储（附件）
            │
   推送：APNs / FCM / 邮件
```

### 4.2 离线优先与冲突

- 客户端所有修改先写本地库，再放进「待发送操作队列」，UI 立刻响应。
- 每个操作是一条 `Op`：`{op_id, client_id, project_id, seq, type, payload, base_version}`。type 包括 `create_node`、`update_field`、`move_node`、`delete_node`、`propose_change`、`decide_change`。
- 服务器按项目串行应用 Op，分配全局递增的 `server_seq`，然后广播给该项目所有在线客户端。客户端保存收到的最大 `server_seq`，重连时从这个位置补拉。
- 冲突处理：
  - 普通字段：字段级最后写入者胜（比较服务器接收时间），被覆盖的一方收到提示「你对 X 的修改被 Y 覆盖」并能一键恢复。
  - description 富文本：用 Yjs CRDT，天然合并。
  - move_node：服务器校验不会形成环（把父节点移到自己子树下），会则拒绝并让客户端回滚。
  - 删除与编辑冲突：删除胜出，但节点进回收站，30 天内可恢复，编辑内容保留在恢复后的节点上。
- 关键字段走变更提案时，Op 类型是 `propose_change` 而不是 `update_field`，所以不会和别人直接冲突。

### 4.3 权限

| 角色 | 能力 |
|---|---|
| admin | 团队设置、成员管理、计费 |
| manager | 项目内一切直接生效，确认任何变更，改项目设置 |
| member | 编辑自己负责的节点，给别人的节点提变更，新建子任务 |
| viewer | 只读，可评论 |

权限判断放在 `core` 包里，客户端先判断给出正确的 UI（比如按钮变成「提议修改」），服务器再判断一次做最终把关。

## 5. 技术选型建议

| 层 | 选择 | 理由 |
|---|---|---|
| 网页 | React + TypeScript + Vite | 生态成熟，导图渲染用 SVG + 自写布局算法（树布局不复杂），甘特用 Canvas |
| App | React Native（Expo） | 和网页共享 core 包和大部分业务代码，一套人能维护两端 |
| 共享 | pnpm monorepo：`packages/core`、`apps/web`、`apps/mobile`、`apps/api` | |
| 后端 | Node.js（Fastify）+ TypeScript | 和前端同语言，core 包能在服务器上复用做校验 |
| 数据库 | PostgreSQL | 树用 parent_id + rank，配合递归 CTE 查子树 |
| 实时 | WebSocket（ws 库）+ Redis pub/sub | 多实例时通过 Redis 广播 |
| 富文本协作 | Yjs | 成熟的 CRDT |
| 认证 | 邮箱魔法链接 + Google 登录 | 不用记密码 |
| 推送 | Expo Notifications（封装 APNs / FCM）+ 邮件（Resend 或 SES） | |
| 部署 | Docker，单台机器起步；数据库用托管服务 | |

如果想更快出第一版，可以用 Supabase 替代自建后端：Postgres + Realtime + Auth 都有，等规模上来再迁移。代价是同步引擎的冲突逻辑要自己在 Edge Function 里补。

## 6. API 草案

REST 负责查询和一次性操作，WebSocket 负责推送 Op。

```
GET    /projects                          我的项目列表
POST   /projects                          新建项目
POST   /projects/import-xmind             上传 .xmind 导入
GET    /projects/:id/export.xmind         导出

GET    /projects/:id/tree                 整棵树（含 assignment、pending change 数量）
GET    /projects/:id/ops?since=:seq       补拉操作日志
POST   /projects/:id/ops                  批量提交 Op（离线队列上传）

GET    /nodes/:id                         节点详情（description、comments、activity）
PATCH  /nodes/:id                         改字段；如触发关键字段规则，返回 202 和 change_id
POST   /nodes/:id/move                    {parent_id, rank}
DELETE /nodes/:id                         软删除

POST   /nodes/:id/assignments             {member_id, role}
DELETE /nodes/:id/assignments/:member_id
POST   /assignments/:id/accept            新负责人接受

GET    /changes?status=pending&mine=1     等我确认的
POST   /changes/:id/approve               {note}
POST   /changes/:id/reject                {note}
POST   /changes/batch                     [{id, decision, note}]

GET    /me/tasks?range=week               我的任务
GET    /me/digest                         周摘要

WS     /realtime
  → {type:"subscribe", project_id}
  ← {type:"op", server_seq, op}
  ← {type:"presence", members:[...]}       谁在线、谁在看哪个节点
```

数据库 schema 见 `docs/schema.sql`。

## 7. 界面要点

- 导图节点：标题一行，下面一行小字放「头像 · 9/15 · 60%」。待确认变更显示黄点，逾期日期红色，done 整体 50% 透明度。
- 节点侧栏：从上到下是负责人、状态、进度滑块、起止日期、预估工时、依赖、描述、评论。App 上是同样顺序的一页。
- 「等我确认」卡片：一句话描述（谁 想把 什么 从 A 改成 B）、理由、两个按钮。
- 快捷键沿用 XMind 习惯：Tab 加子节点，Enter 加兄弟节点，Delete 删除，方向键移动焦点，空格展开收起。

## 8. 分阶段路线

### 第一阶段：能替代 XMind（约 6 周）

- 导入 .xmind
- 导图 + 大纲视图，XMind 同款快捷键
- 节点负责人、起止日期、状态、进度，自动汇总
- 「我的任务」视图
- 网页端，多人实时同步（先不做离线）
- 邮箱登录，团队邀请

验收：把现有 XMind 项目导进来，团队在网页上用一周，不需要再打开 XMind。

### 第二阶段：手机和确认流程（约 6 周）

- App：我的任务、节点详情、改状态和进度、评论、推送
- 变更提案与确认，批量确认面板
- 负责人接受机制
- 逾期提醒、周摘要
- 离线队列

验收：周会上项目经理用「待确认」面板过完一周的调整；成员在手机上确认自己被指派的任务。

### 第三阶段：时间管理深化（约 4 周）

- 甘特视图，拖动改日期
- 依赖与延误传播
- 里程碑
- 按人看板、负载视图
- 导出 .xmind、导出 PDF 报告

之后按需要考虑：日历同步（Google Calendar）、模板、跨项目视图、API 开放。

## 9. 风险与取舍

- 导图在手机上的编辑体验天生受限，所以 App 的定位是「看、改状态、确认」，不追求在手机上重排整棵树。
- 变更确认会增加摩擦，所以默认只对 4 个关键字段生效，而且负责人改自己的节点永远不需要确认。
- 自动汇总和手动锁定并存会让人困惑，界面上锁定的字段要有明确的锁图标，并显示「子节点范围是 X 到 Y」。
- 先做网页再做 App，是因为规划的大头在网页端，而 App 的价值要等有变更提案之后才体现。
