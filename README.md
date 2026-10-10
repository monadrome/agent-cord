# agent-cord

> **状态：M2 最小闭环 + 控制台 MVP + 独立 Context Session Agent 原型已实现（2026-10-07）。**

agent-cord 是一个多 agent 共识协作基座：把需求、决策、证据和人工审核放进同一条可追溯的工作流。workflow 节点可声明执行体，由协调 agent 以最新需求快照驱动 worker agent（claude / codex / kimi / 自定义注册）产出草稿；最终合入和高风险决策保留人工参与。

## 核心 Feature

**默认 Goal 驱动的自主 Draft 交付。** 用户给出目标后，系统在约定权限与预算内自主完成实现、自测、失败修复和交付整理，交付代码、当前版本的实际测试证据及 human review 指南。happy path 无需中途人工干预；真实卡点再升级，最终 review、合入、发布及关键权限仍由人控制。

已实现覆盖 ACP/headless 的节点内 Goal 原型：`run.goal` 声明源码、验证命令和资源上限，宿主实际检查、自动反馈修复并补入指南证据。“Agent 协作”模板默认使用 Goal；自动卡点协调、人工答复后续跑及原授权恢复原型已接通。完整验收条件覆盖与跨 driver 资源治理待完善。详见 [核心 feature](./docs/core-features.md)、[Goal 示例](./examples/goal-sdlc.yaml) 和 [ADR-0056](./docs/adr/ADR-0056-goal-node-execution.md)。

## 能做什么

- 为每个需求维护一个共识快照目录：Markdown 文档、`ledger.yaml` 账本和 `events.jsonl` 事件流。
- 用证据锚点记录结论；无证据不入账，账本由事件流确定性重建。
- 用 YAML 定义 SDLC 节点和 gate，默认流程为：`intake → align → plan → implement → verify → review → done`。
- 在节点上声明 `run` 执行体：协调 agent 按最新快照和 workflow artifact 构建带 provenance 指纹的两层上下文包，经 ACP / headless driver 派发给 worker agent，产物自写或代写均留痕为 `agent.task.*` 事件。
- 协调快照的账本、进度与 hash 来自同批事件，进度按 workflow 隔离；文件读取失败会阻断派发，任务失败记录阶段与是否可重试，修复后可断点恢复。
- 原生 worker 按首尾片段接收最新 PRD 和已退出上游产物，使用明确范围/省略数及全文定位符；任务、账本、源码和重试附记计入最终字符预算，控制信息放不下时不派发。旧前缀策略的未退出 checkpoint 需重跑，详见 [ADR-0051](./docs/adr/ADR-0051-worker-context-budget.md)。
- 共识 gate 从最新事件判定，冲突条目不放行；产物记录前后内容指纹，旧文档不能冒充本次产出。明确空结果与协议辅助文本不用于代写，观察到替换前冲突时保留当前文档。
- 未退出节点只在输入与产物指纹一致时复用成功 worker；审批绑定具体等待事件，需求/证据变化后旧选择返回 409，并先重跑过期任务或重新检查，再确认新审批。
- 用 `agents.yaml` 注册自定义 agent（ACP 子进程、headless CLI、自定义参数模板），与内置 claude / codex / kimi 并列；模板定制支持 `model` / `effort` / `max_turns` / `budget_usd` / `system_prompt` / `agent` / `agents_json` 旋钮——`system_prompt` 是软封装（追加提示），`agent` + `agents_json` 是硬封装（`--agent` 整个会话以该 subagent 身份运行，工具与权限一并继承），把 persona 注册成命名 agent。
- 自定义 agent 配置按工作区隔离；通过清单 API 查看协议和诊断，通过显式重载应用配置。重载失败保留旧配置，在途 run 固定启动时的 agent 定义。
- 控制台「Agent」页可搜索与筛选公开配置、查看诊断和配置指纹、刷新与重载；启动参数身份纳入任务和审批输入，同名 agent 改模型或角色后不复用旧任务。
- 用参数化 checker（`checks[].with`）拼装证据门禁：文件存在/非空/含章节/锚点数/事件已发，参数非法 fail-closed。
- 声明 `run.retry` 让节点内的 agent 任务按退避重试（重试附上次失败摘要）；run 可随时取消——取消先落事件再中止执行器，driver 杀进程树，人工 gate 挂起同时失效。
- 用 `run.goal` 在同一未退出节点内自主实现代码、运行宿主检查、修复失败与完成 review 指南；持久化次数/时长预算，连续源码与失败集合无进展时停止。就绪仍需最终人审，源码变化使旧交付和审批失效。
- 独立 Context Session Agent 读取当前 Goal 的受限状态；预算、权限或无进展阻塞会清空可推进节点，模型只能提出带 Goal 事件证据的人工升级或等待，不会自动扩预算或放行 gate。
- Goal 可选声明 supervisor agent；真正 blocked 后宿主自动发起一次受限协调，生成带证据的人工问题，仍不自动恢复 run、批准 gate 或增加预算。
- 在协调页处理 Goal 人工问题后，可独立授权原发布预算并“重新执行 Goal”；新 run 绑定答复、阻塞和当前输入，过期/撤回/重复授权被核验，最终 review 仍由人完成。
- ACP worker 可在 agents.yaml 声明 read/edit 文件范围预授权；请求的结构化 kind/absolute locations 全部匹配时一次授权，正常工具请求无需逐次人工调度。未知/越界请求取消并形成权限卡点，只读任务保留原拒绝行为。
- Goal ready 的 worker/宿主测试来源由恢复和协调共用核验；协调观察区分历史就绪与当前有效性，代码/指南过期、取消或不可读取时不会引用为当前交付证据。
- 原授权 Goal 中断或冷配置漂移后，恢复原配置可在详情页恢复同一 run；请求绑定当前输入、checkpoint 与身份，保留原次数/截止时间，仍有效交付恢复到原人工审批（[ADR-0063](./docs/adr/ADR-0063-goal-recovery-command.md)）。
- Goal 可声明验收条件到检查的映射，宿主生成逐项实测矩阵与事件引用；恢复/协调拒绝缺项或错引用。推荐模板包含测试、类型和构建工程基线，业务条件须补充实际检查，矩阵不代替最终人审（[ADR-0064](./docs/adr/ADR-0064-goal-acceptance-coverage.md)）。
- Goal 可开启 `review_changes`，宿主从首次实际源码生成声明范围内的增改删/权限/类型清单并补入 review 指南，恢复/协调/人审重算完整证据；推荐模板默认开启，不将用户原有未提交代码误归因给 worker（[ADR-0071](./docs/adr/ADR-0071-goal-source-change-evidence.md)）。
- Goal 升级协调失败后，可读取当前依据“重试协调”，保留父子轮次和 blocker；修复 supervisor 配置后新 token 可用，旧 token/重复调用拒绝，不重新启动 worker 或增加 Goal 预算（[ADR-0065](./docs/adr/ADR-0065-goal-coordination-retry.md)）。
- Goal 可选声明 token/cost usage 预算；宿主跨 task 累计 driver 实测 usage，超限停止后续自动修复并保留预算证据，未声明预算的流程保持原行为（[ADR-0066](./docs/adr/ADR-0066-goal-usage-budget.md)）。
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

Agent 能力识别与启动控制是平台原子能力：严格 `launch` 配置覆盖模型/effort、Claude bare/auto/角色/预算、ACP mode 与 select/boolean 扩展、自定义参数映射及显式 session 恢复。不支持的参数拒绝注册，固定流程节点恢复限定原授权未退出 Goal 节点。能力清单与无 prompt 的 ACP 协商接口、配置示例和 human review 指南见 [启动能力验收](./docs/research/2026-10-10-agent-launch-capabilities.md)。

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

计划或评审 worker 可声明 `readonly: true, output: text`，并在节点上声明 artifact：worker 保持只读，在最终回复返回完整 Markdown，由 coordinator 校验后原子代写 Draft，供后置 gate/人工审核使用。产物变化冲突、空内容、失败和取消不会作为成功报告；缺省 output=auto 保留原 readonly 不写文档行为。参见 [开发 Draft 示例](./examples/development-sdlc.yaml) 和 [ADR-0038](./docs/adr/ADR-0038-readonly-report-artifacts.md)。

编辑后调用 `POST /api/v1/agents/reload`（携带唯一 `Idempotency-Key`），再用 `GET /api/v1/agents` 检查 revision、清单与告警。清单表示配置可解析，CLI 安装和凭据可用性由实际运行验证。单条无效配置会被告警并阻断其别名；文件整体错误保留上一份有效配置。在途 run 继续使用启动配置，新 run 使用重载后的配置；server 重启恢复使用当前文件，revision 从 1 重新编号。凭据从本机环境传入，清单不返回 env、args 或角色提示。

控制台的「Agent」页提供同一清单和重载操作。`configuration_hash` 表示实际启动参数身份，包含模板生效的模型/角色参数；全部 env 不参与。任务事件保存 `agent_configuration_hash` 并将其纳入恢复指纹，配置参数变化后的旧审批需重新确认。CLI 安装状态、环境变量与外部命名 agent 文件内容不在该指纹覆盖范围内。

[接入示例](./examples/README.md) 提供可解析的 Codex 协调者、Claude Code 命名角色封装、Kimi ACP 配置，以及“需求检查 → 计划草稿 → 人工审核”的 SDLC。示例不含凭据，配置清单与离线测试只证明契约可解析，真实模型能力需实际运行核验。

自定义条目可声明正整数 `context_revision`。外部角色文件或行为性环境变化时由配置者提高此版本，重载后旧提议/checkpoint/审批会按新身份重新核验；环境值仍不公开或进入指纹，版本不传给 CLI。未声明保留原身份，该版本不自动检测变化。详见 [ADR-0054](./docs/adr/ADR-0054-agent-context-revision.md)。

ACP 条目可声明 `permission_policy: { read: [src, tests], edit: [src] }`。宿主仅依据 read/edit kind 与所有 absolute locations 验证工作区普通文件边界，匹配后选择 allow_once；不支持 execute/删除/网络等授权，不从自由文本猜测路径。缺省兼容原权限拒绝行为，readonly 不使用预授权。策略绑定 configuration_hash，清单仅显示 read_count/edit_count，原文路径不返回。未知/越界请求的 permission 错误不会自动重试，需处理卡点后再执行；它不替代操作系统隔离。详见 [ADR-0060](./docs/adr/ADR-0060-acp-workspace-permission-policy.md)。

文件 checker、协调快照和 REST 文档使用同一普通文件边界：拒绝符号/硬链接、管理与事实文件、非规范路径及非普通文件。REST 真缺失返回 404，边界冲突返回 409，权限/IO 失败返回 500，避免把读故障当成新文档。文档保存使用独占临时文件与原子替换，失败保留旧内容；这不替代 worker 的 OS 沙箱或跨进程文件事务。详见 [ADR-0036](./docs/adr/ADR-0036-shared-document-boundary.md)。

Codex headless 已用真实 CLI 0.160.0 验证两个新会话：更新 PRD 后提议使用新范围，旧提议不再有效。驱动保留 thread ID，将非终态配置通知留在 metadata、file_change 保持工具事件，审批参数使用官方当前配置；测试仍默认离线，真实验证不证明所有模型或统计质量。详见 [ADR-0037](./docs/adr/ADR-0037-codex-runtime-notifications.md) 与 [ADR-0039](./docs/adr/ADR-0039-codex-file-change-events.md)。

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
POST /requirements/:req_id/coordination       # 独立协调轮次，202
GET  /requirements/:req_id/coordination
GET  /requirements/:req_id/coordination/:round_id
POST /requirements/:req_id/coordination/:round_id/cancel
POST /requirements/:req_id/coordination/:round_id/adopt   # 人工采用并启动绑定 SDLC，202
POST /requirements/:req_id/coordination/:round_id/retry-goal # 人工答复后授权新预算，202
POST /requirements/:req_id/coordination/:round_id/retry      # 当前 token 重试 Goal 升级协调，202
POST /runs/:run_id/cancel                     # 幂等；已终态返回现状
GET  /runs/:run_id/goal-recovery              # 原授权 Goal 的恢复依据与剩余预算
POST /runs/:run_id/goal-recovery              # 当前 token + Idempotency-Key，恢复原 run，202
GET  /requirements/:req_id/timeline
GET  /requirements/:req_id/artifacts?path=review.md # 只读当前 SDLC 声明产物
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

幂等键为 1-200 字符，绑定 method、精确 URL 和规范化 JSON 输入。同键同输入的并发请求只执行一次，返回相同的首次响应；对象字段顺序不影响身份，修改输入或复用到另一条命令返回 409。业务执行前先持久化 `pending`，成功响应落库后标记 `completed`，重启后仍可重放。

已知 4xx 拒绝允许修复后重试。业务 5xx、响应缓存故障或重启残留 `pending` 无法证明是否已有副作用，同键返回 `409 idempotency_incomplete`，需查看实际需求/run/SDLC 状态，核验后用新键发起新操作；系统不会盲目重做。旧缓存缺输入指纹时返回 `409 idempotency_legacy`，同样不猜测匹配。删除索引会丢失请求保护，不是 pending 的恢复方式。详见 [ADR-0035](./docs/adr/ADR-0035-rest-idempotent-operations.md)。

每次运行固定 `workflow_revision`，由完整工作流定义与发布名称/版本派生。同一发布版本重新启动会断点续跑，不同版本（即使定义相同）或不同发布名称不会继承旧节点、worker 或审批事实。取消只影响对应执行版本，旧审批不能批准当前版本。启动绑定先写 `workflow.run.started`，删除派生索引后可恢复当前 SDLC 版本与进度。

旧数据没有执行版本时，server 不猜测归属或自动恢复；重新启动指定发布版本会创建新的绑定并重新核验，原事件与文档保留。已发布文件被外部修改后，原 run 拒绝恢复，应发布新版本再启动。库调用省略执行版本时仍可使用无版本兼容模式，与 server 的版本事实分离。详见 [ADR-0034](./docs/adr/ADR-0034-workflow-execution-revisions.md)。

审批 `approval_id` 是当前 `gate.waiting` 的事件 ULID。依据变化后旧审批返回 409，重新获取审批列表后确认新版本；未变化的审批重启后保持 ID。已落盘选择会按等待事件与检查指纹恢复消费，不要求重复选择。

## 独立 Context Session Agent

节点级 coordinator 负责派发 worker；独立 Context Session Agent 则分析当前需求并提出下一步，支持任何内置或 `agents.yaml` 注册的 ACP/headless agent：

```bash
curl -X POST http://127.0.0.1:7250/api/v1/requirements/REQ-001/coordination \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: coordinate-req001-1' \
  -d '{"agent":"architect","sdlc_id":"simple-sdlc","sdlc_version":1,"timeout_ms":120000}'
```

创建返回 `round_id`，随后读取轮次或订阅需求 SSE。每轮 `driver.run` 新会话，重新读取 PRD、artifact、当前事件派生的账本/进度/人工等待；不继承旧会话。模型必须返回严格 JSON 提议，行动类型为 `advance`、`ask_human`、`wait` 或 `complete`。宿主验证节点依赖、待人工 gate 和来源引用；输入在调用期间变化则记 `stale` 并隐藏提议。

`ok` 表示提议在该轮完成时通过验证，不代表节点完成或 gate 放行，也不保证模型推理正确。查询的 `current` / `adoptable` 表示当前输入与采用条件，历史状态不因后续输入变化改写。只读参数不替代 OS 沙箱。server 重启把未完成轮次记为 `failed/interrupted`，不重放模型调用；已持久化取消请求恢复为 `cancelled`。详见 [ADR-0032](./docs/adr/ADR-0032-context-session-agent.md)。

控制台路径：需求详情 → 协调。选择 Agent、SDLC 版本与超时，发起/取消协调，查看轮次、结构化提议、风险与来源；文档、共识与节点引用可跳转现有子视图。server 重新核验最新输入与 Agent 配置，输入变化或版本归档时禁用采用；刷新失败保留历史内容。

独立协调遵守无工具策略：driver 报告任何工具事件时，宿主立即中止并拒绝提议，记录 `failed/driver`，不保存工具参数。只读工具也不能补入快照之外的材料。旧策略提议须重新协调；该检测不替代外部 CLI 的 OS 沙箱或回滚已有副作用，普通 worker 的工具通道保持原行为。详见 [ADR-0050](./docs/adr/ADR-0050-coordination-tool-boundary.md)。

普通 `readonly` worker 也有跨 driver 的事件级审计：明确读工具和受限无副作用命令允许，写工具、未知工具或危险命令形成 `agent.task.completed{failure_stage: driver, retryable: false}`，不自动重试且不保存工具输入。该兜底不冒充执行前拦截或 OS 沙箱，详见 [ADR-0068](./docs/adr/ADR-0068-readonly-tool-audit.md)。

含 agent 执行体的 run 受当前 RunService workspace lease 保护：新启动/授权/显式恢复冲突返回 409；已授权冷恢复保留原 run/预算，释放后自动重检续跑。启动失败释放，活动 executor 收束后释放；无 agent 流程和冷人审等待不占用。该保护不冻结 review 版本，不替代 worktree、容器隔离或跨实例锁，详见 [ADR-0069](./docs/adr/ADR-0069-workspace-agent-lease.md)。

本地跨实例保护已接入 SQLite 执行锁：busy 409，损坏/IO 500，正常释放后原授权恢复自动继续。宿主强杀保留未确认 owner 标记，核验遗留 worker/验证进程后才能修复，不能凭 PID/mtime 自动抢占。活动执行期间不要删除 `.index` 或锁文件；该能力不支持同需求多 daemon 并发写事件/审批/协调，详见 [ADR-0070](./docs/adr/ADR-0070-cross-process-workspace-lease.md)。

协调者提出 `ask_human` 时，控制台可选择既有选项并记录答复。答复成为绑定原问题的事实，进入同版本的下一轮协调、worker 与审批上下文；可追溯、可重放，过期问题不能提交。澄清不会批准 gate、采用提议或启动 worker；每轮只记录一次，新的有效轮次可重新澄清同题。详见 [ADR-0052](./docs/adr/ADR-0052-coordination-clarifications.md)。

记录错误选择后，可用答复区的撤回工具明确取消当前同题选择。原答复和撤回均保留审计，最新快照标为未确定，不回退旧选择；需要新协调轮次重新澄清，不自动回滚产物或流程。详见 [ADR-0053](./docs/adr/ADR-0053-clarification-revocation.md)。

有效 `advance` 提议可由人点击“采用并启动 SDLC”，或调用 `POST .../:round_id/adopt`（空请求体、Idempotency-Key）。建议只能指向执行器实际下一节点；采用启动整个绑定版本，从该节点续跑，仍保留机器/人工 gate。`ask_human`、`wait`、`complete` 不由此入口推进节点。采用事实先落盘再派发，同轮重复采用返回原 run；登记与落盘之间中断时，恢复必须验证采用事实，缺失则失败且不派发。详见 [ADR-0033](./docs/adr/ADR-0033-coordination-adoption-console.md)。

## 当前边界

已实现：事件协议与 reducer、工作流执行器（pre gates → node.run → post gates）、参数化内置 checker、节点协调 agent（动态快照 + provenance 上下文包 + artifact 双通道写回 + 节点内重试）、独立 Context Session Agent（结构化 Draft 提议 + 来源校验 + 在途输入重检 + 协调轮次 API/恢复）、run 取消（事件 + AbortSignal 贯穿到 driver）、盲评投票底座、ACP/headless agent driver 与 `agents.yaml` 自定义注册、CLI、REST/SSE server、人工 gate、SDLC 草稿/版本/归档/模板库、React 控制台。

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
- [ADR 目录](./docs/adr/)：架构决策记录，当前包含 ADR-0001 ~ ADR-0039。
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
