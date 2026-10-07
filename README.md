# agent-cord

> **状态：M2 最小闭环 + 控制台 MVP + 协调 agent 已实现（2026-10-06）。**

agent-cord 是一个多 agent 共识协作基座：把需求、决策、证据和人工审核放进同一条可追溯的工作流。workflow 节点可声明执行体，由协调 agent 以最新需求快照驱动 worker agent（claude / codex / kimi / 自定义注册）产出草稿；最终合入和高风险决策保留人工参与。

## 能做什么

- 为每个需求维护一个共识快照目录：Markdown 文档、`ledger.yaml` 账本和 `events.jsonl` 事件流。
- 用证据锚点记录结论；无证据不入账，账本由事件流确定性重建。
- 用 YAML 定义 SDLC 节点和 gate，默认流程为：`intake → align → plan → implement → verify → review → done`。
- 在节点上声明 `run` 执行体：协调 agent 按最新快照和 workflow artifact 构建带 provenance 指纹的两层上下文包，经 ACP / headless driver 派发给 worker agent，产物自写或代写均留痕为 `agent.task.*` 事件。
- 用 `agents.yaml` 注册自定义 agent（ACP 子进程、headless CLI、自定义参数模板），与内置 claude / codex / kimi 并列；模板定制支持 `model` / `effort` / `max_turns` / `budget_usd` / `system_prompt` / `agent` / `agents_json` 旋钮——`system_prompt` 是软封装（追加提示），`agent` + `agents_json` 是硬封装（`--agent` 整个会话以该 subagent 身份运行，工具与权限一并继承），把 persona 注册成命名 agent。
- 用参数化 checker（`checks[].with`）拼装证据门禁：文件存在/非空/含章节/锚点数/事件已发，参数非法 fail-closed。
- 声明 `run.retry` 让节点内的 agent 任务按退避重试（重试附上次失败摘要）；run 可随时取消——取消先落事件再中止执行器，driver 杀进程树，人工 gate 挂起同时失效。
- 用独立盲评投票处理适合自动化的决策点，分歧和高风险情况升级人工。
- 通过 Fastify server 和 React 控制台查看需求、编辑文档、观察事件、启动 run、处理人工 gate，并管理 SDLC 的草稿、版本、归档与模板库。

## 快速开始

要求 Node.js `>=22.5.0`。

```bash
npm install
npm run build:all
npm test
```

启动控制台服务：

```bash
npm run serve
```

然后打开 <http://127.0.0.1:7250>。服务默认使用当前目录作为工作区，也可以通过 `CORD_ROOT` 和 `CORD_PORT` 修改：

```bash
CORD_ROOT=/path/to/workspace CORD_PORT=7250 npm run serve
```

只想验证核心闭环，可以运行离线 demo：

```bash
npm run cord -- demo
```

## 用控制台跑一个需求

1. 在「需求」页创建需求并填写 PRD。
2. 进入需求详情，在「文档」页编辑 `prd.md`、`plan.md`、`adr.md` 或 `findings.md`。
3. 点击「启动默认 SDLC run」。
4. 在「概览」和「事件」页观察节点进度与证据 gate。
5. 流程到达 `review/human-review` 后，需求会进入「等待人工」状态。
6. 在「审批」页选择「确认放行」或「拒绝放行」。
7. 在「账本」页查看投影结果，在「事件」页复核完整事件链。

控制台只展示 server 投影，不复制 reducer 或工作流状态机。所有写操作都经过事件流，并要求 `Idempotency-Key` 防止重复提交。

## 数据布局

```text
cord/
├── agents.yaml           # 可选：自定义 agent 注册表（ACP / headless / 自定义模板）
├── <req-id>/
│   ├── prd.md
│   ├── adr.md
│   ├── plan.md
│   ├── findings.md
│   ├── ledger.yaml       # 事件流的确定性投影
│   └── events.jsonl      # append-only 事实来源
├── .sdlc/                # 发布的 SDLC 版本与草稿（draft.yaml）
└── .index/               # 可删除、可重建的 SQLite 派生索引
```

核心规则：`events.jsonl` 是事实来源，`ledger.yaml` 是 reducer 投影，`.index` 只保存幂等键和运行登记。删除派生索引不会丢失需求事实。

## 项目结构

```text
src/                       # 领域内核、事件协议、reducer、workflow、voting、driver、CLI
apps/server/               # Fastify REST + SSE + run runner + SDLC 服务
apps/console/              # React + Vite 控制台
tests/                     # 内核、workflow、driver、CLI、e2e 测试
docs/                      # 方案文档与 ADR
```

常用命令：

```bash
npm run build              # 构建领域内核
npm run build:all          # 构建内核和控制台
npm run typecheck          # 检查所有 workspace
npm test                   # 运行全部离线测试
npm run dev:console        # 单独启动 Vite 前端，默认代理到 7250
npm run cord -- init       # 初始化 cord/ 目录
npm run cord -- doctor     # 检查事件流和账本投影
npm run cord -- events ID  # 查看需求事件流
```

## API

server 提供 `/api/v1` 接口，以下路径均省略此前缀：

```text
GET  /health
GET  /dashboard
GET  /requirements
POST /requirements
POST /requirements/:req_id/runs
POST /runs/:run_id/cancel                     # 幂等；已终态返回现状
GET  /requirements/:req_id/timeline
GET  /requirements/:req_id/ledger
GET  /requirements/:req_id/events/stream   # SSE，支持 Last-Event-ID
GET  /requirements/:req_id/approvals
POST /requirements/:req_id/approvals/:approval_id/decide
GET  /sdlcs
POST /sdlcs/:sdlc_id/versions/validate
POST /sdlcs/:sdlc_id/versions/publish
GET  /sdlcs/:sdlc_id/versions/:version
GET  /sdlcs/:sdlc_id/draft
PUT  /sdlcs/:sdlc_id/draft
DELETE /sdlcs/:sdlc_id/draft
POST /sdlcs/:sdlc_id/versions/:version/archive
POST /sdlcs/:sdlc_id/versions/:version/unarchive
GET  /sdlc-templates
POST /doctor
```

写命令必须携带 `Idempotency-Key`。错误统一返回 `{ code, message, details, request_id }`。启动 run 可指定 `{ sdlc_id, sdlc_version }`；归档版本禁止启动新 run。

## 当前边界

已实现：事件协议与 reducer、工作流执行器（pre gates → node.run → post gates）、参数化内置 checker、协调 agent（动态快照 + provenance 上下文包 + artifact 双通道写回 + 节点内重试）、run 取消（事件 + AbortSignal 贯穿到 driver）、盲评投票底座、ACP/headless agent driver 与 `agents.yaml` 自定义注册、CLI、REST/SSE server、人工 gate、SDLC 草稿/版本/归档/模板库、React 控制台。

尚未实现：飞书等 IM 适配、多用户鉴权、持久化任务队列与跨进程 lease、CEL 和外部 checker 插件（MCP）、知识库检索、文档防腐钩子，以及默认 SDLC 中的真实投票产出。详细计划见 [docs/10-roadmap.md](./docs/10-roadmap.md)。

## 设计原则

- 共识必须带证据，事件流是唯一事实来源。
- 状态变更只有一个写路径：`session.events.append`。
- checker 无法判定时 fail-closed，不静默放行。
- agent 默认只写 Draft，代码合入和关键门禁由人决定。
- 文件和 git 保持可读、可导出，SQLite 只做派生索引。

## 文档入口

- [文档入口](./docs/INDEX.md)：当前实现、协议、ADR 和设计归档的阅读路径。
- [当前实现架构](./docs/current-architecture.md)：server、console、数据布局和运行路径。
- [核心协议速查](./docs/protocol.md)：事件、账本、workflow、gate 和 voting 的实现契约。
- [ADR 目录](./docs/adr/)：架构决策记录，当前包含 ADR-0001 ~ ADR-0024。
- [安全与权限模型](./docs/09-security.md)
- [路线图](./docs/10-roadmap.md)
- [风险与开放问题](./docs/11-risks.md)

## 贡献

代码、注释、CLI 输出和文档使用中文；模块间契约集中在 `src/core/schema.ts` 与 `src/core/ports.ts`，修改前需要同步 ADR。提交前至少运行：

```bash
npm run typecheck
npm test
npm run build:all
```

项目采用 Apache-2.0 License。
