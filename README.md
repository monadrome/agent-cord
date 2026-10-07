# agent-cord

> **状态：M2 最小闭环 + 控制台 MVP + 协调 agent 已实现（2026-10-06）。**

agent-cord 是一个多 agent 共识协作基座：把需求、决策、证据和人工审核放进同一条可追溯的工作流。workflow 节点可声明执行体，由协调 agent 以最新需求快照驱动 worker agent（claude / codex / kimi / 自定义注册）产出草稿；最终合入和高风险决策保留人工参与。

## 能做什么

- 为每个需求维护一个共识快照目录：Markdown 文档、`ledger.yaml` 账本和 `events.jsonl` 事件流。
- 用证据锚点记录结论；无证据不入账，账本由事件流确定性重建。
- 用 YAML 定义 SDLC 节点和 gate，默认流程为：`intake → align → plan → implement → verify → review → done`。
- 在节点上声明 `run` 执行体：协调 agent 按最新快照和 workflow artifact 构建带 provenance 指纹的两层上下文包，经 ACP / headless driver 派发给 worker agent，产物自写或代写均留痕为 `agent.task.*` 事件。
- 协调快照的账本、进度与 hash 来自同批事件，进度按 workflow 隔离；文件读取失败会阻断派发，任务失败记录阶段与是否可重试，修复后可断点恢复。
- 共识 gate 从最新事件判定，冲突条目不放行；产物记录前后内容指纹，旧文档不能冒充本次产出。明确空结果与协议辅助文本不用于代写，观察到替换前冲突时保留当前文档。
- 未退出节点只在输入与产物指纹一致时复用成功 worker；审批绑定具体等待事件，需求/证据变化后旧选择返回 409，并先重跑过期任务或重新检查，再确认新审批。
- 用 `agents.yaml` 注册自定义 agent（ACP 子进程、headless CLI、自定义参数模板），与内置 claude / codex / kimi 并列；模板定制支持 `model` / `effort` / `max_turns` / `budget_usd` / `system_prompt` / `agent` / `agents_json` 旋钮——`system_prompt` 是软封装（追加提示），`agent` + `agents_json` 是硬封装（`--agent` 整个会话以该 subagent 身份运行，工具与权限一并继承），把 persona 注册成命名 agent。
- 自定义 agent 配置按工作区隔离；通过清单 API 查看协议和诊断，通过显式重载应用配置。重载失败保留旧配置，在途 run 固定启动时的 agent 定义。
- 控制台「Agent」页可搜索与筛选公开配置、查看诊断和配置指纹、刷新与重载；启动参数身份纳入任务和审批输入，同名 agent 改模型或角色后不复用旧任务。
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

## 自定义 Agent

工作区 `cord/agents.yaml` 支持 ACP、内置 headless 模板和自定义参数三种形态：

```yaml
agents:
  custom-acp:
    kind: acp
    bin: my-agent
    args: [acp]
  reviewer:
    kind: headless
    template: claude
    agent: reviewer
    agents_json: '{"reviewer":{"description":"代码评审","prompt":"审查当前需求的证据与实现","tools":["Read","Grep","Glob"]}}'
  implementer:
    kind: headless
    template: codex
    effort: high
  custom-cli:
    kind: headless
    bin: my-cli
    args: [run, "{{prompt}}", --json]
```

节点通过 `run: { agent: implementer }` 选择 agent。模板形态可省略 `bin`，使用模板默认二进制；自定义 args 必须声明 `bin`，只替换 `{{prompt}}`，不会自动提供只读限制或 resume 参数。

编辑后调用 `POST /api/v1/agents/reload`（携带唯一 `Idempotency-Key`），再用 `GET /api/v1/agents` 检查 revision、清单与告警。清单表示配置可解析，CLI 安装和凭据可用性由实际运行验证。单条无效配置会被告警并阻断其别名；文件整体错误保留上一份有效配置。在途 run 继续使用启动配置，新 run 使用重载后的配置；server 重启恢复使用当前文件，revision 从 1 重新编号。凭据从本机环境传入，清单不返回 env、args 或角色提示。

控制台的「Agent」页提供同一清单和重载操作。`configuration_hash` 表示实际启动参数身份，包含模板生效的模型/角色参数；全部 env 不参与。任务事件保存 `agent_configuration_hash` 并将其纳入恢复指纹，配置参数变化后的旧审批需重新确认。CLI 安装状态、环境变量与外部命名 agent 文件内容不在该指纹覆盖范围内。

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
GET  /agents
POST /agents/reload                         # 幂等；仅影响后续 run
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

审批 `approval_id` 是当前 `gate.waiting` 的事件 ULID。依据变化后旧审批返回 409，重新获取审批列表后确认新版本；未变化的审批重启后保持 ID。已落盘选择会按等待事件与检查指纹恢复消费，不要求重复选择。

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
- [ADR 目录](./docs/adr/)：架构决策记录，当前包含 ADR-0001 ~ ADR-0031。
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
