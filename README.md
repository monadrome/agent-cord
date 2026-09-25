# agent-cord

> **状态：M2 最小闭环 + 控制台 MVP 已实现（2026-09-25）。**

agent-cord 是一个多 agent 共识协作基座：把需求、决策、证据和人工审核放进同一条可追溯的工作流。agent 只产 Draft，最终合入和高风险决策保留人工参与。

## 能做什么

- 为每个需求维护一个共识快照目录：Markdown 文档、`ledger.yaml` 账本和 `events.jsonl` 事件流。
- 用证据锚点记录结论；无证据不入账，账本由事件流确定性重建。
- 用 YAML 定义 SDLC 节点和 gate，默认流程为：`intake → align → plan → implement → verify → review → done`。
- 用独立盲评投票处理适合自动化的决策点，分歧和高风险情况升级人工。
- 通过 Fastify server 和 React 控制台查看需求、编辑文档、观察事件、启动 run、处理人工 gate 和管理 SDLC 版本。

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
├── <req-id>/
│   ├── prd.md
│   ├── adr.md
│   ├── plan.md
│   ├── findings.md
│   ├── ledger.yaml       # 事件流的确定性投影
│   └── events.jsonl      # append-only 事实来源
├── .sdlc/                # 发布的 SDLC 版本
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
GET  /requirements/:req_id/timeline
GET  /requirements/:req_id/ledger
GET  /requirements/:req_id/events/stream   # SSE，支持 Last-Event-ID
GET  /requirements/:req_id/approvals
POST /requirements/:req_id/approvals/:approval_id/decide
GET  /sdlcs
POST /sdlcs/:sdlc_id/versions/validate
POST /sdlcs/:sdlc_id/versions/publish
POST /doctor
```

写命令必须携带 `Idempotency-Key`。错误统一返回 `{ code, message, details, request_id }`。

## 当前边界

已实现：事件协议与 reducer、工作流执行器、内置 checker、盲评投票底座、ACP/headless agent driver、CLI、REST/SSE server、人工 gate、默认和自定义 SDLC、React 控制台。

尚未实现：飞书等 IM 适配、多用户鉴权、run 取消、CEL 和外部 checker 插件、知识库检索、文档防腐钩子，以及默认 SDLC 中的真实投票产出。详细计划见 [docs/10-roadmap.md](./docs/10-roadmap.md)。

## 设计原则

- 共识必须带证据，事件流是唯一事实来源。
- 状态变更只有一个写路径：`session.events.append`。
- checker 无法判定时 fail-closed，不静默放行。
- agent 默认只写 Draft，代码合入和关键门禁由人决定。
- 文件和 git 保持可读、可导出，SQLite 只做派生索引。

## 文档入口

- [方案文档索引](./docs/INDEX.md)：完整设计、术语和阅读路径。
- [控制台平台方案](./docs/proposal-console-platform.md)：server、console、SDLC 和验收边界。
- [ADR 目录](./docs/adr/)：架构决策记录，当前包含 ADR-0001 ~ ADR-0022。
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
