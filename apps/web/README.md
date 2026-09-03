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
| `/projects/:id` | 编辑器：导图 / 大纲视图、右侧节点面板、待确认面板 |
| `/contacts` | 联系人，点开看他名下的任务 |

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

导图里：拖动背景平移，Ctrl/⌘ + 滚轮缩放，右下角有 +/−/适应；把节点拖到另一个节点上可以改父节点。

## 状态模型

每个打开的项目在内存里有一个 core 的 `TreeStore`。所有编辑先本地 `store.apply`（乐观更新），150ms 内的操作合并成一次 `POST /api/projects/:id/ops`。WebSocket 收到的 op 如果是自己发的就跳过，否则本地应用。服务器拒绝某个 op（版本冲突等）时重新拉取项目并弹提示。

## 校验

```sh
pnpm --filter @tsai-mind/web typecheck
pnpm --filter @tsai-mind/web build
pnpm --filter @tsai-mind/web e2e      # Playwright 冒烟测试，用 page.route 模拟后端，截图到 e2e/out/
```

Playwright 使用预装的 Chromium（`/opt/pw-browsers/chromium`），不需要 `playwright install`。
