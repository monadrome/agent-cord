# 当前实现架构

> 状态：M2/MVP + 节点协调 + 独立 Context Session Agent（2026-10-07）。本文描述仓库当前代码，不替代 ADR 的决策记录。

## 1. 一句话概览

agent-cord 是一个本地单用户的需求协作服务：事件流保存事实，纯 reducer 生成账本，workflow runner 推进 SDLC，协调 agent 把节点任务派发给 worker agent（claude / codex / kimi / 自定义注册），Fastify server 提供 REST/SSE，React console 只展示 server 投影。

```text
React console
    │ REST 命令 / SSE 事件
    ▼
Fastify server
    ├── SessionService：需求文件夹、文档和投影
    ├── RunService：workflow runner、人工 gate、恢复、NodeRunner 注入
    ├── SdlcService：YAML 校验、发布版本、草稿、归档、模板库
    ├── AgentService：工作区配置快照、清单与显式重载
    ├── CoordinationService：独立协调轮次、新鲜度、人工采用、取消与中断恢复
    ├── 幂等 hook：请求身份、业务前持久化占位、并发响应与未知结果阻断
    └── IndexStore：幂等操作、运行登记（含执行版本与协调来源）、SDLC 归档登记
    │
    ├── cord/<req-id>/events.jsonl  事实来源
    ├── cord/<req-id>/ledger.yaml   reducer 投影
    ├── cord/.sdlc/                 SDLC 发布版本与草稿
    └── cord/agents.yaml            自定义 agent 注册表（可选）

workflow 执行器（薄，只推进 gate/节点）
    │ node.run 存在时委托 NodeRunner 端口
    ▼
协调 agent（src/coordinator）
    │ 最新快照 → 两层上下文包 → AgentDriver
    ▼
worker agent 子进程（ACP / 裸 headless CLI）
```

## 2. 仓库边界

| 目录 | 当前职责 |
|---|---|
| `src/core` | EventEnvelope、JSONL store、哈希链、reducer、session、doctor |
| `src/workflow` | YAML workflow、拓扑执行（pre gates → node.run → post gates）、内置 checker（含参数化）、人工 gate 端口 |
| `src/coordinator` | 节点协调（快照、上下文包、NodeRunner、artifact 写回）与独立 ContextSessionAgent（严格提议、来源验证、在途重检） |
| `src/voting` | k=2~3 盲评、锚点校验、投票判定和留痕结构 |
| `src/driver` | ACP 与 headless agent driver、agents.yaml 工作区独立 resolver 与逐条诊断 |
| `apps/server` | Fastify REST/SSE、运行服务、SDLC 服务、派生 SQLite 索引 |
| `apps/console` | React/Vite 控制台；不复制 reducer 或状态机 |
| `tests`、`apps/*/tests` | 与源码对应的离线测试和 server API 测试 |

跨模块结构以 [`src/core/schema.ts`](../src/core/schema.ts) 和 [`src/core/ports.ts`](../src/core/ports.ts) 为准。

## 3. 数据和写入路径

每个需求对应 `cord/<req-id>/`：

```text
prd.md plan.md adr.md findings.md  # 可人工编辑的快照文档（worker agent 可写 draft）
events.jsonl                       # append-only 事实来源
ledger.yaml                        # 可重建的账本投影
```

状态变更只能通过 `session.events.append`。事件写入时由 store 分配 `seq`、`prev_event_hash` 和时间戳，落盘并 fsync 后才通知订阅者。`ledger.yaml` 由 `createReducer().reduce(events)` 重建；`doctor` 检查事件链、序号、session 身份和投影一致性。

快照文档与文件 gate 共用 core/session-files：拒绝链接/非普通文件/事实与管理路径，存在性检查只读元信息，读取使用 no-follow 描述符，写回独占临时文件并原子替换。REST 区分缺失 404、物理边界 409 与 IO 500；文档读取故障不能变成“未生成”，失败保存保留旧内容。该边界不代替 worker OS 沙箱或跨进程文件事务（ADR-0036）。

headless 驱动保留流级会话回执，Codex 的 item.error/warning 非终态通知归 metadata，顶层任务错误仍失败。当前模板使用 approval_policy 配置；真实 Codex、Claude 命名角色和 Kimi ACP 均已通过最新快照协调冒烟验证，详情见 [Codex 接入验证](./research/2026-10-07-real-context-agent.md)、[Claude/ACP 协调验证](./research/2026-10-08-real-claude-acp-coordination.md) 与 ADR-0037。examples 提供三类 agent 与带人工审核的计划流程，其他 CLI/provider 的安装、认证和真实运行仍由实际调用验证。

`cord/.index/server-index.sqlite` 只保存幂等键、run 登记和 SDLC 归档登记。删除它不会删除需求事实，但会丢失运行查询、幂等重放缓存和归档状态。

## 4. Workflow、运行与协调 agent

Workflow 定义是 `agent-cord.dev/v1alpha1 / Workflow` YAML。加载时检查 schema、节点依赖、gate 引用、环和 checker 名称。执行器按稳定拓扑序推进节点：

1. 读取事件流，跳过已经有 `workflow.node.exited` 的节点；未退出节点通过协调器校验 execution_input_hash 与 artifact 后态，仍有效才复用历史 ok，否则基于最新快照重新执行。
2. 写入 `workflow.node.entered`。
3. 顺序执行 pre gates；checker 抛错或返回非法结果时 fail-closed。
4. 节点声明 `run` 时委托给 `NodeRunner`（协调 agent）：按 workflow 声明动态采集 artifact，重建最新快照并生成 `snapshot_id` / 事件链 provenance → 构建上下文包（PRD + 上游产物 + 账本 + 定位符）→ 经 AgentDriver 派发 → 写带 provenance 的 `agent.task.started` / `agent.task.completed`。artifact 写回双通道：worker 自写优先，非空文本回退为协调 agent 代写 draft；路径必须位于 session 目录内。任务失败/超时则停在该节点，run 记 failed，重跑会重试；声明 `run.retry` 时由协调 agent 在节点内按退避重试，重试的上下文包附上次失败摘要。
5. 顺序执行 post gates；人工 gate 写入 `gate.waiting`，由 server 的审批接口恢复。
6. 写入 `workflow.node.exited`。

快照的账本由同次事件读取直接经过 reducer 派生，与节点进度和 provenance 使用同一事件基线；进度按当前 workflow 过滤，账本冲突明确标记需人工处理。快照读取不刷新磁盘账本。文档读取与写回拒绝链接、非普通文件、事实文件与管理目录，代写采用独占临时文件、fsync 和 rename。普通准备/派发/写回失败落任务 completed，记录 failure_stage/retryable；事件追加故障上抛宿主（ADR-0028）。

共识 gate 同样直接从当前事件投影判定，只接受无冲突的 confirmed 条目。协调器以本次快照的 artifact hash 为基线，记录前后指纹：观察到有效文件变化才记为 agent 文件通道，未变化时用完整最终文本代写，无新内容则失败；替换前观察到冲突时保留现状。driver 的明确空结果不会回退进度日志，辅助输出不拼入产物（ADR-0029）。

审批使用稳定的 evaluation_hash 与具体 gate.waiting 事件 ID。等待恢复、REST 选择写入前、核心消费选择后都重新验证；依据变化落 gate.invalidated 并重新推进，worker 过期先重跑。approval_id 是等待 ULID，暂存与已落盘选择按该版本消费；重启不重复执行仍有效的 worker，不把旧审批批准用于新产物（ADR-0030）。

worker 权限与产物通道可分别声明：readonly+output=text 让 worker 只读核验，返回完整报告，由 coordinator 原子代写节点 artifact；旧 readonly/auto 行为不变。文本模式观察到 artifact 变化即失败并保留当前文件，不把外部写入当成功。checkpoint 将报告视为输出，验证其完成后 hash 与写入证据，后置 gate/人工审批继续控制推进（ADR-0038）。examples/development-sdlc.yaml 提供计划/实现/只读评审/人工终审的隔离开发 Draft 流程。

真实隔离检出已验证计划、实现 Draft、超时后的同版本恢复、只读报告写回与人工 gate 挂起；宿主新增目标57/完整库615通过，模型只读环境的测试临时目录写限制在报告中保留，不把报告生成ok当作测试通过。详情见 [真实开发验收](./research/2026-10-07-development-draft-workflow.md)。机器验证事实已可通过 `verification.completed` + 当前输入 hash 接入 gate；人工批准/合入与异构模型验证仍未完成。

每个节点边界检查取消信号：run 取消先落 `workflow.run.cancelled`（事实），再 abort 执行器——信号经 NodeRunContext → AgentTask 透传到 driver，driver 杀进程树并关闭事件流；人工 gate 挂起处与 abort 竞速，取消不落 `gate.resolved` 假判定。取消后该 run 的未决 gate 从审批投影移除，重新 start 即断点续跑。

server 当前使用进程内 runner。同一需求同时只允许一个在途 run。重启时根据 run 登记和事件流重新扫描节点；已完成节点不重跑，未完成节点重新求值。

每个发布绑定派生 workflow_revision，覆盖完整定义和 SDLC 发布名称/版本，保持公开 workflow_id 不变。executor、worker、gate、快照、checker、审批/时间线/终态与协调提议按该版本读取；同版本恢复继续复用自己的进度，不同版本或发布名称不会继承旧退出事实。取消只影响对应版本，旧审批不能批准当前版本（ADR-0034）。

启动时先登记 run，再追加 workflow.run.started 发布绑定事实，之后才派发。索引删除后从启动事实重建当前版本；当前绑定按因果顺序确定，恢复只推进最新 run，历史版本保留。执行版本缺失、启动事实缺失或发布定义被外部改动时拒绝自动恢复；重新 start 指定版本会重新核验，旧事件/文档仍保留审计。无版本库调用保持独立兼容模式。

worker agent 的来源：内置驱动清单（claude / codex / kimi 直连，ACP 优先探测）+ `cord/agents.yaml` 自定义注册（ACP 子进程 / headless 模板定制 / 自定义 args 模板三种形态）。模板定制形态支持旋钮：`model`（三家通用）、`effort`（claude/codex）、`max_turns`/`budget_usd`/`system_prompt`/`agent`/`agents_json`（claude）。角色封装分软硬两档：`system_prompt` 追加系统提示，`agents_json` + `agent` 走 `--agents` / `--agent` 让会话整体以该 subagent 身份运行（工具面与权限一并继承）——把「资深评审」「架构师」这类 persona 注册成命名 agent。模板不支持的旋钮在注册期降级为 warning。默认 SDLC 不挂执行体（开箱可跑零依赖）；挂执行体的流程从模板库「Agent 协作」档起步。

工作区配置编译为独立 resolver，不写全局模板表；driver 固定构造时的参数。`AgentService` 提供公开清单与串行显式重载，成功后原子替换配置，文件整体错误时保留旧配置。新 run 固定当前 resolver；在途 run 不受重载影响，重启恢复使用当前文件。配置无效的别名不能退回同名内置 agent（ADR-0027）。

内置 driver 的 configuration_hash 从有效普通/只读/resume 启动参数派生（ACP 为 bin/args），全部 env 不参与；任务事件记录 agent_configuration_hash 并纳入 execution_input_hash，审批上下文也覆盖该身份。重启时同名 agent 参数变化导致旧任务与审批失效，在途 run 仍固定原身份（ADR-0031）。

默认 `simple-sdlc v1` 流程为：

```text
intake → align → plan → implement → verify → review → done
```

当前默认流程包含证据 gate 和人工 review gate；真实 agent 产出由声明了 `run` 的自定义 SDLC（如模板库 agent-collab 档）承载。

独立 ContextSessionAgent 不依赖 node.run：每轮固定 resolver，按当前 SDLC 版本采集最新快照（含同次事件投影的待人工 gate），新建 driver 会话，输出严格 JSON Draft 提议。来源引用、实际下一节点和完成状态由宿主验证；运行期间输入变化则落 stale，不返回旧建议。它不自行启动 worker、写文档或放行 gate。CoordinationService 提供异步创建、查询、取消与显式人工采用；轮次事实只在事件流，重启将未完成请求记 interrupted，不重放调用（ADR-0032/0033）。

人工采用只接受当前有效 advance，重检位于 RunService 预留槽位内，采用事实落盘后进入绑定版本的整个 SDLC runner；其余提议不生成 gate 决策。查询新鲜度与历史完成状态分离，重复采用返回原 run。运行登记的 coordination_round_id 保留启动来源，恢复缺少匹配采用事实时 fail-closed，旧 SQLite 表自动兼容。

## 5. Server 和 API

server 默认监听 `127.0.0.1:7250`，工作区由 `CORD_ROOT` 指定。核心接口包括：

- 查询：`/health`、`/dashboard`、`/requirements`、需求详情、timeline、ledger、votes、runs、approvals。
- Agent：`GET /agents` 查看配置 revision、公开清单和诊断；`POST /agents/reload` 显式重载（幂等键），清单不包含 env、args 或角色 prompt。
- 协调：`POST/GET /requirements/:req_id/coordination`、`GET /requirements/:req_id/coordination/:round_id`、`POST .../:round_id/cancel`、`POST .../:round_id/adopt`；创建/采用返回 202，每需求至多一个在途协调轮次。
- 机器验证：`GET /requirements/:req_id/runs/:run_id/nodes/:node_id/verification-context` 获取当前输入 hash；`POST /requirements/:req_id/runs/:run_id/verifications` 记录带 run/input hash 的验证事实。需求详情概览展示各 run 的最新验证状态。
- 命令：创建需求、编辑快照文档、启动 run（可指定 `sdlc_id` + `sdlc_version`）、取消 run（`POST /runs/:run_id/cancel`，幂等）、处理人工审批。
- 实时：`/requirements/:req_id/events/stream`，使用事件 `seq` 作为 SSE id，并支持 `Last-Event-ID` 回放。
- SDLC：列表、读取版本、validate、publish、草稿（GET/PUT/DELETE `/sdlcs/:id/draft`）、版本归档（archive/unarchive）、模板库（`GET /sdlc-templates`）。归档版本禁止启动新 run，不影响在途/历史 run。
- 维护：`POST /doctor`。

写命令需要 `Idempotency-Key`。错误统一返回 `code`、`message`、`details` 和 `request_id`。

所有写命令共享幂等 hook：key 绑定 method/URL/结构化输入 hash，业务前持久化 pending，相同请求在途等待同一响应，成功落库后 completed，跨重启重放首次结果；不同输入 409。4xx 拒绝可修复后重试，5xx/缓存故障/重启残留 pending 返回未确认错误，禁止盲目重做；旧无输入身份缓存 fail-closed。请求正文不存库，索引删除会丢失幂等保护；本原型没有业务文件与 SQLite 的跨存储事务（ADR-0035）。

## 6. Console

console 使用 hash 路由，页面包括工作台、需求列表、需求详情、SDLC 管理和 Agent 工作台。它通过 `apps/server/src/contracts.ts` 共享 DTO，只消费 server 投影；事件流、账本和 workflow 状态不在浏览器重复计算。

需求详情页启动 run 时可选 SDLC 与版本（默认 = 内置 SDLC 最新版）；SDLC 页支持模板载入、草稿保存/恢复、克隆已发布版本到编辑器、版本归档。

Agent 页支持公开清单搜索、来源与协议筛选、配置诊断/指纹、刷新和显式重载；加载失败与重载失败保留已有清单，成功后更新 server 返回的配置版本。不读取或编辑凭据、env 或角色提示。

需求详情的协调视图提供 Agent/SDLC 版本/超时选择、创建/取消、轮次历史、结构化 Draft 提议、风险和来源导航；显示 server 新鲜度和采用条件，人工采用后可跳转绑定 run。SSE/轮询更新投影，失败保留已加载内容，后台暂停轮询，卸载清理定时器。文档来源跳转定位对应文档，切换加载时禁用编辑/保存。

## 7. 当前非目标

以下能力仍属于后续工作：

- 飞书等 IM 适配、多用户鉴权和远程部署；
- 持久化任务队列和跨进程 lease；
- CEL、外部 checker 插件（MCP）和权限审批桥；
- 知识库检索、文档防腐钩子；
- gate `write_back` 的实际执行（目前只记录到事件 payload）、投票在默认流程中的自动触发。

详细决策见 [`docs/adr/`](./adr/)，未来设计和调研见 [`docs/research/`](./research/) 以及旧版章节文档。
