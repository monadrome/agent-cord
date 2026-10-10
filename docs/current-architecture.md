# 当前实现架构

> 状态：M2/MVP + 节点协调 + 独立 Context Session Agent + 节点内 Goal 交付原型（2026-10-09）。本文描述仓库当前代码，不替代 ADR 的决策记录。

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

### 已采纳的 Goal 执行设计

[默认 Goal 驱动的自主 Draft 交付](./core-features.md) 是真实 agent 开发流程的核心设计基线：自主完成代码、实际自测与 human review 指南，正常执行无需中途人工干预，最终 review 与关键权限仍人工控制（[ADR-0055](./adr/ADR-0055-goal-driven-draft-delivery.md)）。

ACP/headless 保持任务调用。coordinator/goal.ts 在 NodeRunner 内承载 run.goal：worker 产出代码与指南 → 宿主按声明 argv 执行检查 → 输入重检与指南审计 → 失败反馈修复或 ready。host-verification.ts 计算完整输出 hash、有界内存尾部并回收超时/取消进程组；失败原文不持久化。指南补入实际结果事件与命令元信息，当前源码与最终指南绑定验证输入。连续无进展、时长与尝试从 goal.attempt 事实恢复；卡点归 run failed 并公开原因。Context Session Agent 现在读取受限 Goal 状态；blocked/invalid/cancelled 会使 eligible_nodes 为空，只能产生带当前 Goal 事件证据的 ask_human/wait Draft，不会扩预算或放行 gate。

Goal 声明 `supervisor_agent` 时，RunService 在 blocked 事实和 failed run 落盘后调用 CoordinationService 自动发起 `goal_blocked` 轮次。请求事实绑定 blocker event、run、node 和 workflow revision，服务重启补缺失请求且不重放已开始的 supervisor；在途人工协调先等待。协调失败不改变 run failed，输入变化使轮次 stale，人工回答仍走既有澄清接口。没有声明 supervisor 的流程保持旧行为。

自动问题的人工答复可由独立 retry-goal 命令继续：view 展示当前输入 token 与发布预算，RunService 槽位内/记录前重检，started.goal_retry_round_id 与 goal.retry.authorized 绑定新执行及来源，worker 固定配置后派发。答复本身不启动模型；新 run 重新验证未退出 Goal，保留上游退出与原失败。SQLite 新列可从启动事实重建；恢复必须证明人工授权先于派发，预算与发布版本一致，旧 failed Goal 不继承新 run 的等待状态。用户处理卡点时可更新事实/代码，旧输入 409，刷新后再授权；最终人审继续绑定新产物（ADR-0059）。

续跑在首次校验前固定 resolver，授权保存 worker/supervisor/节点输入 hash；RunService 的首次派发、冷恢复与审批共用 coordinator/goal-retry.ts 身份归因。热重载不改变在途 agent，冷配置漂移拒绝派发/放行，恢复原配置后可显式恢复原 run 与预算；旧授权须有合法任务来源。过期审批不通过普通 start 重授次数/时长（ADR-0062）。

原授权 run 的恢复通过 `RunService.goalRecovery/recoverGoal` 暴露 REST。恢复投影重新读取原授权、worker 身份、checkpoint、当前输入与 ready 证据，显示剩余次数和第一次尝试推导的截止时间。`goal.recovery.requested` 是恢复意图事实，不是完成或人工放行事实；写入后仍需 resolver 与输入重检。冷启动发现未消费请求时只恢复该 run，消费后不循环；同 token 重放返回原 run，普通 start 永远不替代该操作（ADR-0063）。

“Agent 协作 · Goal”模板默认使用该原型，旧发布流程保持原执行语义。缺宿主能力或 NodeRunner 的 Goal 拒绝跳过；正常闭环在未退出节点内完成，最终 post gate 保留人工。未退出 Goal 的同 run 冷恢复校验最新 ready、worker 完成引用、当前源码/指南与宿主验证事件，输入变化先重做；新 run 不复用旧 ready。完整独立监督与跨 driver 权限策略仍待完善，自动卡点/受控续跑已接入，完整输出日志未持久化。

ready 的来源由 coordinator/goal-evidence.ts 共用解析，runner 与 execution-context 不分别猜测完成。宿主核验 worker、产物写入与随后全部声明验证的命令/零退出/输入身份、最新引用及取消；协调在此基础上重读当前源码与指南，返回 current/freshness_reason，历史 ready 不冒称当前有效。过期/不可读/非法 ready 不能作 goal evidence；blocked/retrying 仍是当前 run 的执行事实。完整观察与 round 输入身份绑定，冷活动槽位变化也会使旧提议过期，需要新轮次（ADR-0061）。

Goal 可选 acceptance 声明条件到 check ID 的映射。宿主完成检查后生成指南矩阵与 ready.acceptance_evidence，goal-acceptance.ts 派生并核验全集；共用 readiness 拒绝遗漏/错引用，协调当前 ready hook 也必须匹配发布条件。模型自报矩阵不被消费为通过事实，默认模板的三条件仅代表工程基线，业务充分性仍需 review（ADR-0064）。

Goal 的 `review_changes: true` 复用安全扫描按需返回 manifest，第一次尝试前保存 source_manifest，指南补入宿主源码变更清单。ready.change_evidence 引用基线事件，goal-changes.ts 应用完整 delta 重算到被测 source_hash，恢复/协调/post 人审共用核验；基线不因修复或重启而重置。manifest/delta 不含正文，各限 10,000 项和 1,000,000 序列化字符，常规 verification-context REST 不返回清单。推荐 Goal 模板默认开启，旧发布/库调用兼容（ADR-0071）。

失败 Goal 升级协调可按 server coordination_retry 当前 token 重试；持久 request 三字段保存父轮次/输入/配置来源，初始自动与人工重试 actor 区分。goal-coordination.ts 共用来源解析供投影和 Goal 新预算授权恢复，当前 resolver 固定/派发前重检、单子请求/重放与冷中断不调用模型。原 blocker 和 worker 不变，配置修复后明确新 token 可重新解释最新事实（ADR-0065）。

Goal 可选 usage_budget 绑定宿主可观察的 task usage；goal-usage.ts 跨尝试累计输入/输出 token 与 cost，超限写 budget blocker 和 usage_totals，未声明流程保持兼容，未知 usage 不当零（ADR-0066）。

当前资源投影由 execution-context/goalUsageViews 和 `/goal-usage` REST 提供，验证任务成对来源、配置/输入身份与逐指标 unknown；协调 round 和控制台只消费 projection。ready、post gate、恢复共用目标计量重算，活动 run 的未知计量显示等待/invalid，终态 unknown 进入升级，不会在冷恢复重置预算（ADR-0067）。

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

原生 worker 现用首尾快照与共享的确定性均衡片段分配，内容范围限定为 PRD 和已退出上游依赖，未展示的中间内容明确省略。任务说明、账本、定位符、输出要求与源码/重试附记先占必需预算，最终 prompt 不超过 maxPackChars；控制信息放不下时 failed/snapshot、不派发、不节点内重试。worker 输入 v4 绑定策略，旧未退出前缀 checkpoint 需重新执行，已退出节点不回滚（ADR-0051）。
5. 顺序执行 post gates；人工 gate 写入 `gate.waiting`，由 server 的审批接口恢复。
6. 写入 `workflow.node.exited`。

快照的账本由同次事件读取直接经过 reducer 派生，与节点进度和 provenance 使用同一事件基线；进度按当前 workflow 过滤，账本冲突明确标记需人工处理。快照读取不刷新磁盘账本。文档读取与写回拒绝链接、非普通文件、事实文件与管理目录，代写采用独占临时文件、fsync 和 rename。普通准备/派发/写回失败落任务 completed，记录 failure_stage/retryable；事件追加故障上抛宿主（ADR-0028）。

快照和验证共用严格事件读取：原生 readOrderedStrict 拒绝当前坏行、非法 envelope 和外部 session，旧自定义端口兼容但须返回全部事实。普通诊断读取仍可展示合法部分；严格读取不代替 doctor 哈希链诊断。协调创建/查询/采用同样拒绝不完整事实，冷协调恢复按需求隔离错误，不重放模型；修复后可重新核验。明确取消即使无法读取/写入事实仍收束当前匹配进程，接口继续报告错误，不伪造取消请求或成功（ADR-0047）。

共识 gate 同样直接从当前事件投影判定，只接受无冲突的 confirmed 条目。协调器以本次快照的 artifact hash 为基线，记录前后指纹：观察到有效文件变化才记为 agent 文件通道，未变化时用完整最终文本代写，无新内容则失败；替换前观察到冲突时保留现状。driver 的明确空结果不会回退进度日志，辅助输出不拼入产物（ADR-0029）。

审批使用稳定的 evaluation_hash 与具体 gate.waiting 事件 ID。等待恢复、REST 选择写入前、核心消费选择后都重新验证；依据变化落 gate.invalidated 并重新推进，worker 过期先重跑。approval_id 是等待 ULID，暂存与已落盘选择按该版本消费；重启不重复执行仍有效的 worker，不把旧审批批准用于新产物（ADR-0030）。

worker 权限与产物通道可分别声明：readonly+output=text 让 worker 只读核验，返回完整报告，由 coordinator 原子代写节点 artifact；旧 readonly/auto 行为不变。文本模式观察到 artifact 变化即失败并保留当前文件，不把外部写入当成功。checkpoint 将报告视为输出，验证其完成后 hash 与写入证据，后置 gate/人工审批继续控制推进（ADR-0038）。examples/development-sdlc.yaml 提供计划/实现/只读评审/人工终审的隔离开发 Draft 流程。

只读 worker 声明验证 inputs 时，宿主把同一源码摘要注入协调器；执行身份和任务 source_hash 共同保证未退出报告仍对应当前代码。写回前重新扫描摘要，在途变化或读失败记 failed/snapshot，不能把旧结论代写成新报告。可写 worker 的源码产出不应用此只读规则（ADR-0042）。

真实隔离检出已验证计划、实现 Draft、超时后的同版本恢复、只读报告写回与人工 gate 挂起；宿主新增目标57/完整库615通过，模型只读环境的测试临时目录写限制在报告中保留，不把报告生成ok当作测试通过。详情见 [真实开发验收](./research/2026-10-07-development-draft-workflow.md)。机器验证事实已可通过 `verification.completed` + 当前输入 hash 接入 gate；人工批准/合入与异构模型验证仍未完成。

每个节点边界检查取消信号：run 取消先落 `workflow.run.cancelled`（事实），再 abort 执行器——信号经 NodeRunContext → AgentTask 透传到 driver，driver 杀进程树并关闭事件流；人工 gate 挂起处与 abort 竞速，取消不落 `gate.resolved` 假判定。取消后该 run 的未决 gate 从审批投影移除，重新 start 即断点续跑。

server 当前使用进程内 runner。同一需求同时只允许一个在途 run。重启时根据 run 登记和事件流重新扫描节点；已完成节点不重跑，未完成节点重新求值。

每个发布绑定派生 workflow_revision，覆盖完整定义和 SDLC 发布名称/版本，保持公开 workflow_id 不变。executor、worker、gate、快照、checker、审批/时间线/终态与协调提议按该版本读取；同版本恢复继续复用自己的进度，不同版本或发布名称不会继承旧退出事实。取消只影响对应版本，旧审批不能批准当前版本（ADR-0034）。

agent 的可选 context_revision 是正安全整数，代表配置者主动声明的外部角色/行为版本。ACP/headless 有声明时使用各自配置 v2 域绑定数字，无声明保持 v1；argv 与环境透传不改。旧 resolver 固定原版本，重载后的新调用/冷恢复用新版本，借由既有 configuration_hash 链路失效旧结果。清单/控制台仅公开数字，不读取或公开环境原文，未主动提高版本时仍无法发现外部变化（ADR-0054）。

ACP 的 permission_policy 支持可写 worker read/edit 范围预授权。普通相对范围在注册/构造时归一化，结构化请求位置按 task.cwd 的真实/规范根核验，缺位置、未知操作与普通文件边界冲突取消，只选择 allow_once。readonly 与独立协调不应用预授权，回执 metadata 与固定拒绝原因避免污染报告。范围进入配置 v3 身份，清单/Agent 页只公开 read/edit 数量；权限错误不可自动重试，Goal 立即阻塞（ADR-0060）。

启动时先登记 run，再追加 workflow.run.started 发布绑定事实，之后才派发。索引删除后从启动事实重建当前版本；当前绑定按因果顺序确定，恢复只推进最新 run，历史版本保留。执行版本缺失、启动事实缺失或发布定义被外部改动时拒绝自动恢复；重新 start 指定版本会重新核验，旧事件/文档仍保留审计。无版本库调用保持独立兼容模式。

worker agent 的来源：内置驱动清单（claude / codex / kimi 直连，ACP 按声明选择）+ `cord/agents.yaml` 自定义注册（ACP 子进程 / headless 模板定制 / 自定义 args 模板三种形态）。统一 `launch` 支持模板声明的模型、effort、角色与预算；Claude 增 bare/auto，readonly 强制 plan。ACP model/effort 通过明确 option_ids 映射，并在 prompt 前协商允许值和设置回执；config_options 提供 select/boolean 扩展。自定义 argv 用明确占位符与完整 resume_args，不能静默开新会话。显式不支持的旋钮现在拒绝注册；旧顶层模板旋钮仍兼容。宿主 Goal 生命周期、CLI 权限模式和通信通道分别控制（[ADR-0073](./adr/ADR-0073-agent-launch-capabilities.md)）。默认 SDLC 不挂执行体（开箱可跑零依赖）；挂执行体的流程从模板库「Agent 协作」档起步。

ACP `launch.option_ids.mode` 可将 mode 绑定新配置 ID，兼容无 category/纯 configOptions；否则走旧 modes/set_mode，空回执仅为协议确认。每次 session 独立记录完整配置/模式更新，按 mode、排序扩展、model、effort 设置并核验最新候选，最终冻结显式选择。执行中漂移为不可重试 configuration error，取消/收束并阻止成功产物/Goal ready/协调提议；已发生副作用不回滚，未选默认值不冻结。显式 launch 使用 v5 配置域绑定状态核验策略，旧默认无 launch 保留身份（[ADR-0075](./adr/ADR-0075-acp-launch-state-consistency.md)）。

普通 `readonly` worker 还经过 coordinator 的跨 driver 工具审计：明确读工具与受限无副作用命令通过，写工具、未知工具和不可核验命令形成不可自动重试的 driver failure；不保存工具输入。它是事件级 fail-closed 兜底，不能撤销已经发生的副作用，也不取代 ACP permission 或 OS sandbox（ADR-0068）。

自定义 headless args 支持 `readonly_args/readonly_resume_args` 完整分支和 `{{readonly}}` 文字占位，按任务模式与显式 session 选择唯一分支。所有声明分支保持 model/effort 映射与必要 prompt；resume 绑定 session ID，缺只读映射则拒绝派发，不开新会话。`readonly_launch/readonly_resume` 描述参数映射，外部模板必须显式声明支持，不能从普通 resume 推断。实际 argv/null 进入现有配置身份，流程 Agent 上下文、热重载快照、冷恢复与审批继续共用此身份；旧无映射只读 resume 的拒绝和身份变化属于保守兼容调整，不承诺权限隔离（[ADR-0080](./adr/ADR-0080-custom-readonly-launch.md)）。

启动 resolver 将 `provider` 与 model/effort 一样纳入配置身份。ACP 通过明确 `option_ids.provider` 在 session/new/load 后设置并核验最新候选；自定义 headless 只有在 args、resume_args、readonly_args、readonly_resume_args 全部分支消费 `{{provider}}` 才注册该旋钮。内置模板没有 provider 映射则拒绝，旧未声明 provider 的配置不变；后续回执漂移会取消 ACP 会话，不能形成成功任务或当前协调提议（ADR-0082）。

安全敏感的只读节点可声明 `run.require_readonly_mapping=true`。节点 schema 要求同时 `readonly=true`；Context Session Agent 用固定流程 Agent 能力快照计算 eligible_nodes，缺少稳定身份或 `readonly_launch=mapped` 时只允许解释性 wait/ask_human。NodeRunner 在解析 driver 后、spawn 前再次检查，checkpoint 复用也检查能力，配置漂移不能借旧成功绕过。缺省字段维持旧 readonly 兼容；该准入检查仍不是 OS 隔离（[ADR-0081](./adr/ADR-0081-node-readonly-mapping-requirement.md)）。

RunService 维护进程内 agent lease：新 start/Goal 授权/显式恢复遇到含 `node.run` 的活动执行器返回 409，不写额外请求事实。冷恢复冲突保留原 run，lease 释放后经既有恢复器自动重检续跑；原启动事实支持重启/索引删除重建。启动失败无条件释放，已派发 executor 等 finally 收束后释放；无 agent 流程和无活动 executor 的冷人审不占 lease，未来恢复重新获取（ADR-0069）。这是单实例冲突保护，不冻结 review 版本，不代替 worktree、容器或跨进程锁。

ADR-0070 已将载体升级为独立 SQLite 事务和 fsync owner 标记，在本地跨实例互斥；主索引不持长事务。正常 executor 收束才清标记，强杀/外部修改保留 unresolved 并阻断新派发，SQLite 锁释放不推断 detached worker 死亡。busy 原授权恢复每秒重检，关闭取消检查；不可读取与占用分开诊断。锁不冻结 review、提供 OS 隔离或允许同需求多 daemon 写事件，运行中不删除 `.index`。

工作区配置编译为独立 resolver，不写全局模板表；driver 固定构造时的参数。`AgentService` 提供公开清单与串行显式重载，成功后原子替换配置，文件整体错误时保留旧配置。新 run 固定当前 resolver；在途 run 不受重载影响，重启恢复使用当前文件。配置无效的别名不能退回同名内置 agent（ADR-0027）。

内置 driver 的 configuration_hash 从有效普通/只读/resume 启动参数派生（ACP 为 bin/args），全部 env 不参与；任务事件记录 agent_configuration_hash 并纳入 execution_input_hash，审批上下文也覆盖该身份。重启时同名 agent 参数变化导致旧任务与审批失效，在途 run 仍固定原身份（ADR-0031）。

默认 `simple-sdlc v1` 流程为：

```text
intake → align → plan → implement → verify → review → done
```

当前默认流程包含证据 gate 和人工 review gate；真实 agent 产出由声明了 `run` 的自定义 SDLC（如模板库 agent-collab 档）承载。

独立 ContextSessionAgent 不依赖 node.run：每轮固定 resolver，按当前 SDLC 版本采集最新快照（含同次事件投影的待人工 gate），新建 driver 会话，输出严格 JSON Draft 提议。来源引用、实际下一节点和完成状态由宿主验证；运行期间输入变化则落 stale，不返回旧建议。它不自行启动 worker、写文档或放行 gate。CoordinationService 提供异步创建、查询、取消与显式人工采用；轮次事实只在事件流，重启将未完成请求记 interrupted，不重放调用（ADR-0032/0033）。

协调输入也绑定流程声明的源码范围并集：started/completed 与 REST view 暴露 source_hash，模型完成后和提议查询/采用前重检。PRD 未变而代码变更时旧提议仍会失效；摘要不可读时不可采用，修复相同内容后可重新核验。未声明范围保留文档范围身份（ADR-0043）。

协调者还接收当前 run 的声明机器验证观察，区分 missing/failed/passed 与过期、取消或不可读结果。prompt 只携带严格元信息，不读取测试日志；观察参与输入身份，新结果使旧提议失效。模型可引用当前 verification event_id，控制台链接定位结果事件；引用不是 gate 放行依据（ADR-0044）。

独立协调以首尾片段覆盖长需求的最新附记和各份报告；每文档采集上限 20000 字符，总预算内均衡分配、短文档额度回流。片段索引给出 UTF-16 原文范围与省略数，未显示内容不能视为已核验。共享采集贯穿模型完成、查询与采用；input 自 v4 起绑定采集策略版本，旧策略成功轮次保留历史但须重新协调（ADR-0046）。通用 readSnapshot 默认仍为前缀，原生 worker 已按上述 ADR-0051 显式使用首尾。

当前 server 的协调输入还绑定执行观察：worker started/completed 带 run_id，宿主按当前发布/run 投影最新任务状态、失败阶段和重试编号，原始任务日志不注入模型。活动 run 阻止新的 advance/complete；started 事实不冒称进程当前存活，任务 ok 不冒称测试/gate 通过。完成/查询/采用共用重检，冷启动 active=false；任务来源链接定位事件（ADR-0048）。

协调输入同时默认绑定完整流程Agent上下文：所有node.run.agent和goal.supervisor_agent唯一名的解析状态、configuration_hash和适配器能力，最多128项，严格白名单且不包含env/argv/角色或解析错误。read_agents库hook可选，server每轮固定resolver快照，prompt与v11/v12输入绑定完整元信息，事件/REST仅agent_context_hash。新next worker未知或无稳定身份时不能advance，显式runtime inspect不自动启动。采用固定run resolver并校验原/最新上下文，热重载后查询失效；采用run冷恢复要求合法完成来源/顺序/节点/输入与当前Agent摘要，旧缺上下文或漂移拒绝自动派发，需重新协调并显式采用（[ADR-0078](./adr/ADR-0078-coordination-agent-context.md)）。

活动run的人工等待由同批严格事件派生：`getRun/readRuns/latestRun`核验启动绑定和当前等待/有效选择，REST单run、列表、需求active_run及协调run.status保持一致。SQLite的running登记不代表没有待人审；有效选择后显示running只是正在重检，不等于gate通过。只读投影不写结束时间/事件、不释放lease，历史/终态登记保留；读取失败不回退旧状态，取消期间异步查询保留最新终态。同步`listRuns`保留操作登记用途（[ADR-0076](./adr/ADR-0076-active-run-wait-projection.md)）。

跨 run checkpoint 复用经原输入/源码/产物校验后落 agent.task.reused，链接原始 completed 并按当前 run 去重。协调者得到 reused 与原完成 ID，使用当前复用事件作来源；坏引用不回退历史成功，复用不伪造当前新调用。执行观察自 input v6 起绑定此解释策略。事件视图支持“复用→原完成”的两步导航，前端不复制状态机（ADR-0049）。

独立协调消费到任何 tool_use（含只读工具或延迟工具结果）立即 abort 并关闭迭代器，固定记录 failed/driver、丢弃提议和工具负载；清理错误不覆盖已确认的失败。ACP 清理等待单次、有界的 session/cancel 发送序列再回收进程。tool_policy=none.v1 纳入当前输入：server 使用 v7，无执行观察 hook 的库调用使用 v5，旧策略提议需要重新协调。这是报告工具事件后的拒绝，不回滚既有副作用或认证外部 CLI 完整性（ADR-0050）。

ask_human 的人工选择由独立 answer 写入口形成 coordinator.round.answered，严格引用原完成/input 与既有选项，按需求串行保留一次答复。最新同题澄清从同批事实进入快照，协调/worker/审批共用，不等同 gate 审批；原文档不改写，流程不自动推进。存在澄清时使用协调 v8（无 hook v6）、worker v5 与审批 v2；没有澄清时保留以上既有域。控制台单选记录、过期禁用、已答复与来源导航均由 server 投影，坏来源/替代完成在写前拒绝，坏事实冷恢复按需求隔离（ADR-0052）。

人工撤回追加 answer_revoked，引用预期答复事件，与 answer 共用每需求写槽位。历史保留原选择与撤回时间，最新同题投影为 choice=null/status=revoked，来源指向撤回；旧选择和无澄清身份不复活。只有最新有效同题答复可撤回，原问题输入变化不妨碍撤回，旧轮次不重答。Undo2 工具提供保存中/失败/已撤回状态，新轮次才重新分析，不回滚产物、退出事实或 gate（ADR-0053）。

人工采用只接受当前有效 advance，重检位于 RunService 预留槽位内，采用事实落盘后进入绑定版本的整个 SDLC runner；其余提议不生成 gate 决策。查询新鲜度与历史完成状态分离，重复采用返回原 run。运行登记的 coordination_round_id 保留启动来源，恢复缺少匹配采用事实时 fail-closed，旧 SQLite 表自动兼容。

## 5. Server 和 API

server 默认监听 `127.0.0.1:7250`，工作区由 `CORD_ROOT` 指定。核心接口包括：

- 查询：`/health`、`/dashboard`、`/requirements`、需求详情、timeline、ledger、votes、runs、approvals。
- 产物：`GET /requirements/:req_id/artifacts?path=...` 只读当前绑定 SDLC 的声明文件，复用普通文档边界；需求 detail 投影 artifacts 清单，控制台文档页展示指南原文/预览，固定快照仍可编辑。
- Agent：`GET /agents` 查看配置 revision、公开清单、适配器能力和诊断；`POST /agents/reload` 显式重载，`POST /agents/:name/inspect` 查询 ACP 当前 session 协商能力或显式headless profile的版本/帮助（均需幂等键），不发送 prompt。清单不包含 env、args 或角色 prompt，静态安装声明与模型可用性仍 unchecked。
- 协调：`POST/GET /requirements/:req_id/coordination`、`GET /requirements/:req_id/coordination/:round_id`、`POST .../:round_id/cancel`、`POST .../:round_id/adopt`；创建/采用返回 202，每需求至多一个在途协调轮次。
- 机器验证：`GET /requirements/:req_id/runs/:run_id/nodes/:node_id/verification-context` 获取当前输入 hash；`POST /requirements/:req_id/runs/:run_id/verifications` 记录带 run/input hash 的验证事实。需求详情概览展示各 run 的最新验证状态。
- 声明验证 `inputs` 时，context 同时返回源码范围与 source_hash；输入清单和内容摘要进入验证、gate 和人工审批 hash。目录增删和代码变化使旧测试结果失效，输入范围需包含实际被验证的代码和 lockfile。
- 命令：创建需求、编辑快照文档、启动 run（可指定 `sdlc_id` + `sdlc_version`）、取消 run（`POST /runs/:run_id/cancel`，幂等）、处理人工审批。
- 实时：`/requirements/:req_id/events/stream`，使用事件 `seq` 作为 SSE id，并支持 `Last-Event-ID` 回放。
- SDLC：列表、读取版本、validate、publish、草稿（GET/PUT/DELETE `/sdlcs/:id/draft`）、版本归档（archive/unarchive）、模板库（`GET /sdlc-templates`）。归档版本禁止启动新 run，不影响在途/历史 run。
- 维护：`POST /doctor`。

写命令需要 `Idempotency-Key`。错误统一返回 `code`、`message`、`details` 和 `request_id`。

所有写命令共享幂等 hook：key 绑定 method/URL/结构化输入 hash，业务前持久化 pending，相同请求在途等待同一响应，成功落库后 completed，跨重启重放首次结果；不同输入 409。4xx 拒绝可修复后重试，5xx/缓存故障/重启残留 pending 返回未确认错误，禁止盲目重做；旧无输入身份缓存 fail-closed。请求正文不存库，索引删除会丢失幂等保护；本原型没有业务文件与 SQLite 的跨存储事务（ADR-0035）。

## 6. Console

Agent 工作台显示适配器启动选项、原生恢复和宿主 Goal/受限节点恢复能力，可按选项筛选。展开 ACP 后显式协议查询，候选值/省略数来自 server 有界观察；查询完成后读取最新清单，配置 revision/hash 漂移、清单不可读与旧查询失败分别呈现。移除 alias 保留所选历史结果，查询禁用；没有绿色注册通过标记。移动端配置选项纵向排列，长列表内部滚动（[ADR-0074](./adr/ADR-0074-agent-capability-console.md)）。

内置Claude/Codex/Kimi模板声明inspection_profile；库自定义兼容模板可显式选择profile，原始args不自动probe。HeadlessDriver.inspect不使用prompt/模型/角色，固定--version/任务帮助（Codex另查exec resume），每流128KiB与总执行timeout，正常/错误/超时均清理进程树。REST cli_observation独立于ACP observation，显示版本/步骤/帮助hash、configured与advertised三态；帮助旗标不证明模型可用或隐藏参数不支持，不把--config当effort键已验证（[ADR-0077](./adr/ADR-0077-headless-cli-inspection.md)）。

AgentService对能力查询建立单实例slot：同revision/hash/timeout共享，异配置/timeout冲突，完成不缓存。Fastify preClose先取消slot并等待driver清理，之后拒绝新inspect/reload；关闭查询不产生Agent事件或workflow事实（[ADR-0079](./adr/ADR-0079-agent-inspection-lifecycle.md)）。

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
