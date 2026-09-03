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

## 部署

`deploy/docker-compose.yml`：Postgres + server + 每日备份。复制 `deploy/.env.example` 为 `deploy/.env` 填好后 `docker compose -f deploy/docker-compose.yml up -d`，前面放一个 TLS 反代。
