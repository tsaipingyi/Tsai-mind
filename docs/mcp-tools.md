# Claude 接入：MCP 服务器与工具定义

目标：你在 Claude Code、Claude Desktop 或 claude.ai 里说一句「把官网改版的上线时间推到 10 月 15 号，顺便把接口联调交给陈小明」，Claude 直接改到 Tsai Mind 里，关键字段的改动会推到你的 iPhone 上让你点一下确认，改完网页和手机上都能看到。

做法是 Tsai Mind 自己提供一个远程 MCP 服务器（Model Context Protocol），你把它当作一个连接器加到 Claude 里，和你现在用 Addness 连接器的方式一样。

## 1. 接入方式

单人使用，认证以个人访问令牌（PAT）为主：在 Tsai Mind 设置页生成一个令牌，可以起名、设到期日、设范围。

| 入口 | 怎么接 | 阶段 |
|---|---|---|
| Claude Code | `claude mcp add --transport http tsai-mind https://tsaimind.app/mcp --header "Authorization: Bearer <令牌>"` | 第一阶段 |
| Claude Desktop | 配置文件里加同一个 URL 和 header | 第一阶段 |
| claude.ai 网页 / iPhone 上的 Claude | 设置 → 连接器 → 添加自定义连接器，需要 OAuth 授权页 | 第二阶段，做一个只有你一个用户的最小 OAuth 2.1 实现 |
| Tsai Mind 自己的 App 内助手 | 服务端用 Claude API 调同一套工具，不经 MCP | 第三阶段 |

服务器规格：

- 传输：MCP Streamable HTTP，单一端点 `/mcp`。
- 范围（scope）：`read`、`write`、`decide`。`decide` 才能替你确认待确认项，默认不给；Claude 只提不批。
- 令牌可随时吊销，吊销后下次请求即失效。

## 2. 三条设计原则

1. **关键字段要你确认，其他直接生效。** Claude 改截止日、开始日、负责人、删除节点、标记完成，会生成一条待确认，iPhone 收到推送，通知卡片上点确认。改标题、描述、进度、标签、加子任务直接生效，记进活动流，7 天内可撤销。哪些算关键字段在设置里可以调，也可以整个关掉确认。
2. **大改动先出草案，你一次确认。** 「帮我把下季度的计划拆出来」这类会一次生成几十个节点的操作，不直接落库，而是生成一个「草案批次」。你在网页或 iPhone 上看到一张对比图，橘色标出新增和修改，点一次「应用」才生效。
3. **每个写操作都有前提版本。** 修改节点必须带上读取时拿到的 `version`，版本对不上就拒绝并返回最新内容，避免 Claude 基于过期信息覆盖你刚在手机上改的东西。

## 3. 工具列表

工具名用动词开头，参数用 JSON。所有返回都带 `version`，写操作返回更新后的对象，或 `{status: "pending", change_id}`。

### 读

| 工具 | 参数 | 返回 |
|---|---|---|
| `list_projects` | 无 | 项目列表：id、名称、根节点标题、逾期数、待确认数 |
| `get_tree` | `project_id`, `depth?`, `format?`（`json` 或 `outline`） | 整棵树。`outline` 是缩进的 Markdown 大纲，每行带 `[id]`、负责人、日期、状态、进度 |
| `get_node` | `node_id` | 节点全部字段、依赖、备注、最近 20 条活动、待确认变更、上次催办时间 |
| `search_nodes` | `query`, `project_id?`, `owner?`, `status?`, `due_before?`, `due_after?`, `overdue?` | 匹配的节点，每条带路径 |
| `today` | 无 | 今天到期、逾期、待确认、该催的 |
| `list_pending_changes` | `project_id?` | 待确认列表 |
| `get_activity` | `project_id`, `since?` | 活动流，周回顾用 |
| `list_contacts` | `query?` | 联系人，Claude 用来把名字对到 id |
| `contact_workload` | `contact_id` | 某人名下所有任务，跨项目 |

### 写：单个节点

| 工具 | 参数 | 行为 |
|---|---|---|
| `create_node` | `parent_id`, `title`, `kind?`, `owner_id?`, `start_date?`, `due_date?`, `estimate_hours?`, `priority?`, `description?`, `after_id?` | 新建，默认继承父节点负责人。直接生效 |
| `update_node` | `node_id`, `version`, `patch: {...}`, `reason?` | 改字段。关键字段返回 `pending`，其他直接生效。`version` 不符返回 409 和最新节点 |
| `move_node` | `node_id`, `version`, `new_parent_id`, `after_id?` | 移动。形成环时拒绝。直接生效 |
| `delete_node` | `node_id`, `version`, `reason?` | 软删除。关键操作，走确认 |
| `set_owner` | `node_id`, `version`, `contact_id` 或 `null`, `reason?` | 改负责人。关键字段，走确认 |
| `add_dependency` / `remove_dependency` | `from_node_id`, `to_node_id` | 直接生效 |
| `add_note` | `node_id`, `body` | 加一条备注，署名「经 Claude」 |
| `nudge` | `node_id`, `template?` | 生成催办消息文本并记 `last_nudged_at`，返回文本让 Claude 转给你或直接读给你 |
| `undo` | `op_id` | 撤销一条 Claude 自己做的操作 |

### 写：待确认

| 工具 | 参数 | 行为 |
|---|---|---|
| `decide_change` | `change_id`, `decision`（`approve` / `reject`）, `note?` | 需要 `decide` 范围，默认没有 |
| `withdraw_change` | `change_id` | 撤回 Claude 自己提的待确认 |

### 写：批量草案

| 工具 | 参数 | 行为 |
|---|---|---|
| `draft_plan` | `project_id`, `parent_id`, `outline`, `mode`（`append` 只新增 / `sync` 新增加修改，不删除 / `replace` 子树完全同步，会删除大纲里没有的节点） | 解析大纲，和现有子树做 diff，生成草案批次，返回 `{batch_id, summary, preview_url}`。不落库，iPhone 收到推送 |
| `get_plan_batch` | `batch_id` | 草案的完整 diff |
| `apply_plan_batch` | `batch_id` | 需要 `decide` 范围；通常你在网页或 iPhone 上点应用，不由 Claude 调 |
| `discard_plan_batch` | `batch_id` | 丢弃 |

大纲语法（`get_tree` 的 `outline` 输出也是这个，Claude 读出来、改一改、再交回去）：

```
- 官网改版 [n_8f3a] 9/1–10/10
  - 设计 [n_c21d] @林 9/1–9/12 done
    - 视觉稿 [n_77e0] @林 9/1–9/8 done
  - 开发 [n_a9b4] @王 9/8–9/30 in_progress 35%
    - 前端页面 [n_11f2] @王 9/8–9/24 60%
    - 接口联调 [n_d3c8] @陈 9/15–9/30 blocked 10% ← 前端页面
    - 埋点接入 @王 9/20–9/28                       （没有 [id] 就是新增）
  - ◆ 上线 [n_e5e5] 10/10
```

规则：缩进代表父子，`[id]` 有就是更新、没有就是新建，`@名字` 指负责人（匹配联系人名，没有 `@` 就是你自己，匹配不到报错并列出相近的名字），日期用 `起–止` 或单个日期，状态词和百分比可选，`◆` 表示里程碑，`← 标题` 表示前置依赖，`replace` 模式下大纲里缺失的已有节点会被软删除。

### 项目与联系人

| 工具 | 参数 | 行为 |
|---|---|---|
| `create_project` | `name`, `outline?` | 新建项目，可以直接带大纲 |
| `import_xmind` | `file`（base64） | 导入 .xmind |
| `create_contact` | `name`, `company?`, `email?`, `phone?` | 新建联系人 |

## 4. 资源与提示

- 资源 `tsaimind://project/{id}/outline`：项目大纲 Markdown。
- 资源 `tsaimind://today`：今天的到期、逾期、待确认、该催的，作为对话开场上下文。
- 提示 `weekly_review`：读活动流、列逾期、列待确认、列该催的、给下周建议。
- 提示 `nudge_draft`：给某个节点写一条催办消息。

## 5. 典型对话

**改一个日期（关键字段，走确认）**

> 你：把上线推到 10/15。
> Claude 调 `search_nodes(query="上线")` → `update_node(node_id, version, {due_date: "2026-10-15"})` → 返回 `pending`。
> Claude：已提交，你的 iPhone 上会收到确认。确认后「官网改版」的截止日也会自动跟到 10/15。

**加子任务（直接生效）**

> 你：开发下面加一个「埋点接入」，王芳负责，9/20 到 9/28。
> Claude 调 `list_contacts(query="王芳")` → `create_node(parent_id, title, owner_id, start_date, due_date)`。
> Claude：已加上。

**拆一个季度计划（走草案）**

> 你：在「Q4」下面帮我拆出三个月的里程碑和每月的主要任务。
> Claude 调 `get_tree(format="outline")` → 写大纲 → `draft_plan(mode="append")` → 返回 14 个新节点和预览链接。
> Claude：我拟了 14 个节点，iPhone 上收到预览了，看一眼没问题就点应用。

**催办**

> 你：帮我催一下陈小明的接口联调。
> Claude 调 `nudge(node_id)` → 返回消息文本。
> Claude：给你拟了一条：「小明，关于接口联调，原定 9/30，现在进度 10%，方便同步一下进展吗？」复制发给他就行。已记录今天催过。

**周回顾**

> 你：帮我准备一下周回顾。
> Claude 用 `weekly_review` → `get_activity` + `search_nodes(overdue=true)` + `list_pending_changes` + `today` → 一页摘要。

## 6. App 内助手（第三阶段）

网页和 iPhone 里放一个对话入口，用同一套工具，服务端直接调 Claude API：

- 模型 `claude-opus-5`，自适应思考，流式输出。
- 用 SDK 的 tool runner 跑工具循环，工具函数直接调 core 包里的同一套逻辑。
- 开启服务端回退（`fallbacks: "default"`），避免偶发拒答中断对话。
- 系统提示里放当前项目的大纲（作为缓存前缀）和今天日期，对话历史放后面，配合提示缓存。
- 周摘要推送也由同一条链路生成：每周一早上跑一遍 `weekly_review`，推到 iPhone。

## 7. 审计与安全

- 所有经 Claude 的操作在 `op` 和 `activity` 里 `actor_type = 'claude'`，界面上显示「经 Claude」，活动流可以只看 Claude 的操作，每条都能撤销。
- 令牌可随时吊销。
- 速率限制：每令牌每分钟 120 次读、30 次写；`apply_plan_batch` 单次最多 500 个节点。
- `replace` 模式的草案在预览页里用红色列出会删除的节点，应用前必须勾选「我知道这会删除 n 个节点」。
- 工具描述里不放任何指令性文字，只描述参数和行为。
