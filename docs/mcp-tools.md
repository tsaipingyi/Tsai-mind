# Claude 接入：MCP 服务器与工具定义

目标：你在 claude.ai、Claude Code、Claude Desktop 或 Cowork 里说一句「把官网改版的上线时间推到 10 月 15 号，顺便把接口联调交给陈小明」，Claude 直接改到 Tsai Mind 里，该走确认的走确认，改完导图上所有人都能看到。

做法是 Tsai Mind 自己提供一个远程 MCP 服务器（Model Context Protocol），你把它当作一个连接器加到 Claude 里，和你现在用 Addness 连接器的方式一样。

## 1. 接入方式

| 入口 | 怎么接 | 认证 |
|---|---|---|
| claude.ai / Claude Desktop / Cowork | 设置 → 连接器 → 添加自定义连接器，填 `https://mcp.tsaimind.app/mcp` | OAuth 2.1 授权页，登录一次 |
| Claude Code | `claude mcp add --transport http tsai-mind https://mcp.tsaimind.app/mcp` | 同上，浏览器弹授权页；CI 场景可用个人访问令牌 |
| Tsai Mind 自己的 App 内助手 | 服务端用 Claude API 调同一套工具，不经 MCP | 服务端持有用户会话 |

服务器规格：

- 传输：MCP Streamable HTTP，单一端点 `/mcp`。
- 认证：OAuth 2.1 + PKCE，支持动态客户端注册（RFC 7591）和受保护资源元数据（RFC 9728），这是 claude.ai 添加自定义连接器所需要的。
- 令牌：访问令牌 1 小时，刷新令牌 90 天。个人访问令牌（PAT）在设置页生成，可设到期日和范围。
- 范围（scope）：`read`、`write`、`decide`。`decide` 才能确认或拒绝变更；默认授权页只勾 `read` + `write`。
- 身份：令牌代表一个具体的人，Claude 做的所有事都以这个人的身份、按这个人的权限执行，并标记为「经 Claude」。

## 2. 三条设计原则

1. **Claude 和你走同一套规则。** 权限、关键字段、变更提案，对 Claude 一视同仁。Claude 帮你改别人的任务截止日，和你自己在网页上改一样会生成待确认提案。所以不需要为 Claude 单独设计安全策略。
2. **大改动先出草案，你一次确认。** 「帮我把下季度的计划拆出来」这类会一次生成几十个节点的操作，不直接落库，而是生成一个「草案批次」（plan batch）。你在网页或 App 上看到一张对比图，橘色标出新增和修改，点一次「应用」才生效。小改动（改一个字段、加一个子任务）直接生效。
3. **每个写操作都有前提版本。** 修改节点必须带上读取时拿到的 `version`，版本对不上就拒绝并返回最新内容，避免 Claude 基于过期信息覆盖别人的修改。

## 3. 工具列表

工具名用动词开头，参数用 JSON。所有返回都带 `version`，写操作返回更新后的对象。

### 读

| 工具 | 参数 | 返回 |
|---|---|---|
| `list_projects` | 无 | 我能看到的项目：id、名称、根节点标题、我负责的节点数、待我确认数 |
| `get_tree` | `project_id`, `depth?`（默认全部）, `format?`（`json` 或 `outline`） | 整棵树。`outline` 格式是缩进的 Markdown 大纲，每行带 `[id]`、负责人、日期、状态、进度，适合 Claude 快速读整个项目 |
| `get_node` | `node_id` | 节点全部字段、负责人与协作者、依赖、评论、最近 20 条活动、待确认变更 |
| `search_nodes` | `query`, `project_id?`, `owner?`, `status?`, `due_before?`, `due_after?` | 匹配的节点列表，每条带路径（祖先标题串） |
| `my_tasks` | `range?`（`today` / `week` / `overdue` / `all`）, `member_id?`（经理可以查别人） | 按到期日排的任务列表 |
| `list_pending_changes` | `project_id?`, `mine_to_decide?` | 待确认的变更提案 |
| `get_activity` | `project_id`, `since?` | 项目最近的活动流，周会前让 Claude 总结用 |

### 写：单个节点

| 工具 | 参数 | 行为 |
|---|---|---|
| `create_node` | `parent_id`, `title`, `kind?`, `owner_id?`, `start_date?`, `due_date?`, `estimate_hours?`, `priority?`, `description?`, `after_id?`（插在哪个兄弟后面） | 新建节点，默认继承父节点负责人。返回新节点 |
| `update_node` | `node_id`, `version`, `patch: {title?, description?, status?, progress?, start_date?, due_date?, estimate_hours?, priority?, tags?, progress_mode?, date_mode?}`, `reason?` | 改字段。触发关键字段规则时不直接改，返回 `{change_id, status: "pending"}`。`version` 不符返回 409 和最新节点 |
| `move_node` | `node_id`, `version`, `new_parent_id`, `after_id?` | 移动节点。形成环时拒绝 |
| `delete_node` | `node_id`, `version`, `reason?` | 软删除。不是自己负责的节点会变成提案 |
| `assign` | `node_id`, `member_id`, `role`（`owner` / `contributor` / `reviewer`）, `reason?` | 指派。改 owner 走提案和接受流程 |
| `unassign` | `node_id`, `member_id` | 取消指派 |
| `add_dependency` / `remove_dependency` | `from_node_id`, `to_node_id` | 前置依赖 |
| `add_comment` | `node_id`, `body` | 评论，署名「某某（经 Claude）」 |

### 写：变更提案

| 工具 | 参数 | 行为 |
|---|---|---|
| `propose_change` | `node_id`, `field`, `new_value`, `reason` | 明确提一个提案，即使自己有权直接改。用于「帮我给负责人提个建议」 |
| `decide_change` | `change_id`, `decision`（`approve` / `reject`）, `note?` | 需要 `decide` 范围。只能决定自己有权决定的提案 |
| `withdraw_change` | `change_id` | 撤回自己提的提案 |

### 写：批量草案

| 工具 | 参数 | 行为 |
|---|---|---|
| `draft_plan` | `project_id`, `parent_id`, `outline`（Markdown 大纲，语法见下）, `mode`（`append` 只新增 / `sync` 新增加修改，不删除 / `replace` 子树完全同步，会删除大纲里没有的节点） | 解析大纲，和现有子树做 diff，生成草案批次，返回 `{batch_id, summary: {create: n, update: n, delete: n}, preview_url}`。不落库 |
| `get_plan_batch` | `batch_id` | 草案的完整 diff |
| `apply_plan_batch` | `batch_id` | 应用草案。每个改动仍然逐条过关键字段规则，能直接改的直接改，该提案的变成提案。返回应用结果清单 |
| `discard_plan_batch` | `batch_id` | 丢弃 |

大纲语法（`get_tree` 的 `outline` 格式输出也是这个，所以 Claude 可以读出来、改一改、再交回去）：

```
- 官网改版 [n_8f3a] @蔡 9/1–10/10
  - 设计 [n_c21d] @林 9/1–9/12 done
    - 视觉稿 [n_77e0] @林 9/1–9/8 done
  - 开发 [n_a9b4] @王 9/8–9/30 in_progress 35%
    - 前端页面 [n_11f2] @王 9/8–9/24 60%
    - 接口联调 [n_d3c8] @陈 9/15–9/30 blocked 10% ← 前端页面
    - 埋点接入 @王 9/20–9/28                       （没有 [id] 就是新增）
  - 上线 ◆ [n_e5e5] @蔡 10/10
```

规则：缩进代表父子，`[id]` 有就是更新、没有就是新建，`@名字` 指负责人（匹配成员名，匹配不到报错），日期用 `起–止` 或单个日期，状态词和百分比可选，`◆` 表示里程碑，`← 标题` 表示前置依赖，`replace` 模式下大纲里缺失的已有节点会被软删除。

### 成员与项目

| 工具 | 参数 | 行为 |
|---|---|---|
| `list_members` | `project_id?` | 成员列表，Claude 用来把名字对到 id |
| `create_project` | `name`, `outline?` | 新建项目，可以直接带大纲 |
| `import_xmind` | `file`（base64） | 导入 .xmind，返回项目 |

## 4. 资源与提示

除了工具，MCP 服务器还暴露：

- 资源 `tsaimind://project/{id}/outline`：项目大纲的 Markdown，Claude 可以直接「打开」。
- 资源 `tsaimind://me/week`：我本周的任务和待确认，作为对话开场的上下文。
- 提示 `weekly_review`：一段引导 Claude 做周会准备的模板：读活动流、列逾期、列待确认、生成下周建议。

## 5. 典型对话

**改一个日期（自己负责的节点）**

> 你：把上线推到 10/15。
> Claude 调 `search_nodes(query="上线")` → 找到节点 → `update_node(node_id, version, {due_date: "2026-10-15"})` → 直接生效。
> Claude：已把「上线」的截止日改到 10/15。它的父节点「官网改版」的截止日也自动跟到 10/15。

**改别人的任务（走提案）**

> 你：接口联调让陈小明延到 10/5，理由是后端接口 9/28 才出。
> Claude 调 `update_node(..., {due_date: "2026-10-05"}, reason="后端接口 9/28 才出")` → 返回 `pending`。
> Claude：陈小明是这个节点的负责人，我已经提交了变更提案，他手机上会收到确认。

**拆一个季度计划（走草案）**

> 你：在「Q4」下面帮我拆出三个月的里程碑和每月的主要任务，负责人先都挂我。
> Claude 调 `get_tree` 看现有结构 → 写大纲 → `draft_plan(mode="append")` → 返回 14 个新节点的预览链接。
> Claude：我拟了 14 个节点，预览在这里：（链接）。确认没问题回复「应用」，或者直接在页面上点应用。
> 你：应用。
> Claude 调 `apply_plan_batch`。

**周会前**

> 你：帮我准备一下周会。
> Claude 用 `weekly_review` 提示 → `get_activity` + `my_tasks(range="overdue")` + `list_pending_changes` → 输出一页摘要。

## 6. App 内助手（第三阶段）

网页和 App 里也放一个对话入口，用的是同一套工具，只是不经过 MCP，而是服务端直接调 Claude API：

- 模型 `claude-opus-5`，自适应思考，流式输出。
- 用 SDK 的 tool runner 跑工具循环，工具函数直接调 core 包里的同一套逻辑，权限判断和网页端一致。
- 开启服务端回退（`fallbacks: "default"`），避免偶发拒答中断对话。
- 系统提示里放：当前用户、当前项目的大纲（作为缓存前缀）、今天日期。对话历史放在后面，配合提示缓存。
- 周摘要邮件也由同一条链路生成：每周一凌晨用 `weekly_review` 跑一遍，写成邮件发出去。

## 7. 审计与安全

- 所有经 Claude 的操作在 `op` 和 `activity` 表里 `actor_type = 'agent'`，界面上显示「蔡（经 Claude）」。活动流可以按「仅 Claude 的操作」筛选。
- 令牌可以在设置页随时吊销；吊销后已建立的 MCP 连接下次请求即失效。
- 速率限制：每令牌每分钟 120 次读、30 次写；`apply_plan_batch` 单次最多 500 个节点。
- `replace` 模式的草案在预览页里用红色列出会删除的节点，应用前必须勾选「我知道这会删除 n 个节点」。
- 工具描述里不放任何指令性文字，只描述参数和行为，避免被当成提示注入面。
