# 核心协议速查

> 本文只列当前实现依赖的规则和入口。完整 Zod 定义以源码为准；设计取舍以 ADR 为准。

## 1. 事件 Envelope

权威定义：[`src/core/schema.ts`](../src/core/schema.ts) 的 `EventEnvelopeSchema`。

每个事件包含：`event_id`、`session_id`、血统内 `seq`、`prev_event_hash`、点分层 `type`、`schema_version`、带时区时间戳、`actor`、`correlation_id`、`payload` 和 `source.adapter`。

写入约束：

- `event_id` 使用 ULID，不能由内容哈希派生。
- `seq`、`prev_event_hash`、`timestamp` 只能由 EventStore 分配。
- 事件必须属于当前 session。
- 单行 JSON 追加并 fsync；成功落盘后才派发进程内通知。
- 写入结果不确定时，当前 store 停止继续追加，必须重新打开。

当前事件家族包括：

| 家族 | 作用 |
|---|---|
| `session.*` | 需求 session 生命周期 |
| `ledger.*` | 账本条目提议、确认、推翻和锚点漂移 |
| `vote.*` | 投票开始与完成 |
| `gate.*` | gate 等待和解决 |
| `workflow.node.*` | workflow 节点进入和退出 |
| `workflow.run.*` | 发布绑定启动（started，ADR-0034）与取消（cancelled，ADR-0025） |
| `agent.task.*` | 节点执行体的 agent 任务（started / completed；中间流式输出不入流） |
| `verification.completed` | 宿主/CI 机器验证结果（带输入与输出摘要 hash） |
| `goal.attempt.started` / `goal.attempt.completed` | 节点内 Goal 尝试与交付状态（ready / retrying / blocked / cancelled） |
| `goal.retry.authorized` | 人工答复后授权新 run，绑定原 blocker/答复/当前输入与发布预算 |
| `coordinator.round.*` | 独立协调轮次（requested / started / completed / cancel_requested）与人工采用（adopted） |
| `human.*` | 人工选择记录 |

事件类型目录在 `EVENT_TYPES`；新增类型需要同步 schema 和 ADR。

`agent.task.started/completed` 会记录 `snapshot_id`、`snapshot_event_seq` 与 `snapshot_event_chain_hash`（ADR-0026），标识本次派发使用的最新需求快照。`agent.task.completed` 的其他关键字段：`status`（ok / failed / timeout / cancelled）、`text`（截断 32KB）、`artifact_written` 与 `written_by`（agent / coordinator / none）、`attempt` 与 `max_attempts`（重试时）、`agent_session_id`（仅供人工调试 resume，执行器恢复总是新会话）。`cancelled` 不算失败：不计入 failed 终态，也不触发重试。

ADR-0048 的 NodeRunContext.run_id 由 executor 透传，原生 worker 的 started/completed 保存当前运行身份；库调用可省略。旧任务缺少 run_id 时不猜测当前归属，已有 workflow 版本/输入/产物 checkpoint 复用规则不变。

ADR-0049 增 agent.task.reused：当前 run_id/node_id/流程版本、原完成 completion_event_id 与可用的原输入/源码/配置/产物摘要。executor 仅在 NodeRunner 校验输入/产物仍有效、原完成属于另一 run 或旧无 run_id 时 append；同一 run/node/原完成只追加一次，记录失败不进入 gate。当前 run 已有原生完成或库调用缺当前 run_id 时保留已有行为，不伪造新 completed/调用。Native checkpoint 同时要求原 payload、correlation、流程/节点与调用上下文一致。

ADR-0028 增加失败阶段 `failure_stage`（snapshot / configuration / driver / artifact）和 `retryable`。配置及永久文件路径错误不重试；普通准备、驱动与写回故障都有任务终态，瞬态故障按节点策略重试。准备失败时尚无成功快照，provenance 字段省略。事件追加失败必须上抛宿主，不能用未持久化的 completed 伪造终态。

ADR-0029 增加 `artifact_before_hash`（started/completed）、`artifact_after_hash` 与 `artifact_changed`（completed）。不存在文件用 null，后态不可读时省略 after/changed。旧内容不变不能记为当前 agent 自写；有完整最终文本则代写 draft，可写产物无新内容且无最终文本则 failed/artifact。代写前与替换前比较预期 hash，观察到冲突时保留现状并失败。`written_by=agent` 指运行期间观察到有效文件变化，不保证操作系统写者身份。

driver 保留明确空最终字符串，与无显式最终文本的 null 区分；初始化、协议进度、用户回声、思考等已识别辅助输出以 `TextEventData.channel=metadata` 保留 raw，coordinator 不把它们拼为 fallback 产物。未标记的文本仍视为内容，维持自定义 driver 兼容性。

ADR-0037 增 Codex item.error/warning 非终态通知的 metadata 映射；顶层 error/turn.failed 仍是失败，不通过 JSON 子串提取掩盖混合结果。headless 当次 execute 保留初始化/thread.started 会话回执，填入后续 AgentEvent.session_id 与 result/error.data.session_id；新 run 不共享旧身份。Codex 模板使用当前 `approval_policy="never"`，不提升沙箱权限，有效配置身份随启动参数更新。真实 0.160.0 两轮协调验证已证明本机组合可用，不代表全部 provider 或统计质量。

ADR-0039 将 Codex item.file_change 的 started/completed 保持为 tool_use（input=changes，raw 保留 status），不能拼入产物正文或报告 fallback。工具通知不代替 artifact 前后证据，超时任务的部分文件不能当作完成；恢复仍经新快照和已有 executor，不手工追加成功事实。

ACP 驱动在 `session/new` 或 `session/load` 成功后，为通知、工具、权限、错误和终态事件统一回填当前 `session_id`；`result`/`error` 的 data 保留同一回执。握手或建会话前失败可没有会话身份，不能据此伪造可恢复会话。

ADR-0040 的 `verification.completed` 只记录 `verification_id`、`run_id`、状态、`input_hash`、`command_hash`、退出码、耗时和 stdout/stderr hash；REST 先提供当前 verification context，提交时重算输入 hash。`verification-passed` 只接受当前 workflow scope、当前 run、节点和输入指纹的最新 `passed` 事件，旧结果或缺少上下文一律 block。

ADR-0045 的 VerificationResultSchema 统一 REST、门禁与协调观察的结果约束：摘要使用小写 SHA-256，耗时必须是非负整数，passed 与非零退出码矛盾时拒绝；退出码省略或 null 保留未知语义。先选当前 scope/run/node/验证 ID 的最新事实，再校验 payload 与节点 correlation，不能跳过坏结果回退旧成功。无法解析的完整事件行、非法 envelope、外部 session 和读取错误 fail-closed；当前 run 取消事实即时使通过证据失效。显式 within_node=false 保留库调用禁用 correlation 限制的行为。该读取不替代 doctor 的哈希链检查，也不把 ledger 投影漂移视为验证失败。

ADR-0041 增加 `verification-passed.with.inputs` 工作区相对文件/目录范围，同节点取并集。REST context 返回 source_inputs/source_hash，将确定性文件清单、字节内容 hash、类型与权限纳入 input_hash；提交、gate、人工审批和恢复共用同一身份。事件的可选 source_hash 由 server 计算，不接受客户端源码正文。链接/硬链接/越界/声明缺失/IO 失败和超限拒绝；上限为 10,000 项、单文件 16 MiB、总共 64 MiB、递归深度 32。递归排除管理、依赖与 dist 目录。未声明范围保留文档范围兼容语义；此身份不证明未声明的代码、工具链或外部依赖相同。

验证 gate 配置 `on_fail: escalate` 时可作为外部验证等待点；验证事件成功落盘后 server 仅唤醒同一 run 的挂起 gate，executor 重新求值，不能生成人工决策或直接推进其他节点。若事件先落盘后进程重启，run recovery 会根据 `run_id` 验证事实恢复同一 run 再求值。

CI 在重启之后提交也通过串行 recovery 恢复原 run，不创建新运行身份；唤醒仅匹配当前节点/gate 引用的 verification ID。Promise 登记后再读持久化证据覆盖早到结果，已被当前审批消费的验证事实不在每次重启时重复启动 executor。机器通过但配置 human_confirm=true 的 gate 继续等待人，重启后的选择同样消费原 run。

已挂起等待的源码重检遇到 VerificationInputError 时保留等待，REST context/提交仍返回 409 且不追加结果。修复源码并提交合法验证后可唤醒同一 run；其他执行或存储异常继续上抛。

ADR-0030 增加 `execution_input_hash`（agent started/completed）：覆盖完整 workflow、节点、需求文档 hash、账本摘要、已退出进度和上下文预算，排除事件序号/时间戳。可写当前 artifact 以 completed 后态验证，不把自身写入作为输入变化。`snapshot_id` 继续记录完整 provenance，两者作用不同。

ADR-0031 增加 driver 可选 `configuration_hash` 与任务事件 `agent_configuration_hash`，内置 headless/ACP 从固定有效启动参数派生，全部 env 排除。该身份纳入 execution_input_hash（内部域 v2）和节点审批上下文；同名模型/角色参数变更后，未退出节点重新执行并重新审批。外部 driver 未提供身份时仍支持，但宿主需提供可靠身份才能覆盖其配置变化。

ADR-0054 为 agents.yaml 的 ACP/模板/自定义 args 条目与原生 driver options 增可选 context_revision（正安全整数）。不传 CLI、不作为模型旋钮、不哈希 env；有声明时 headless/ACP 配置域 v2 绑定数字，无声明维持 v1。AgentCatalogView 的数字字段可缺省，控制台身份栏显示上下文版本。配置者需在外部角色/行为环境改变时主动提高版本，既有任务/协调/审批身份链路重新核验，当前 run 固定旧 resolver；凭据轮换及未声明变化不自动检测。无环境原文或角色文件进入清单/版本数据。

ADR-0042 的只读 worker 源码身份由 CoordinatorOptions.read_source_hash 提供。server 对 readonly 节点使用声明验证范围的摘要，任务 started/completed 记录 source_hash，该阶段 execution_input_hash 使用绑定 v3/无绑定 v2，当前策略统一升级为下述 v4。未退出评审恢复时必须匹配当前摘要与任务 provenance；执行后、写回前源码变更或读取失败记 failed/snapshot，不代写旧报告。人工等待期间源码变更也重新派发评审。可写 worker 不读取该只读钩子，不因自身实现产出误失效。

ADR-0051 的 execution_input_hash v4 绑定 context_policy=worker-balanced-head-tail.v1。原生 NodeRunner 准备/恢复采用 head_tail，buildContextPack 只将 PRD 与已退出上游依赖产物纳入均衡首尾预算，保留全文定位符；通用 readSnapshot 默认前缀不变。maxPackChars（默认 60000）约束最终 prompt，源码身份与重试附记经 ContextPackOptions.additional_context 纳入必需预算。非法预算、控制信息或片段索引放不下时抛公开 ContextPackBudgetError，原生任务记 failed/snapshot 且 retryable=false，不派发、不节点内重试，修复后可重新 start。旧 v2/v3 checkpoint 需重跑，已退出节点和人工决定不回滚。document_excerpts 的原文范围/省略数不表示模型已核验全部原文；字符预算不是 token 预算。

server onClose 收束活跃 runner，等待 agent 子进程清理后返回；关闭期间旧 runner 不登记派生终态。原 run/等待事实用于恢复，关闭不写 workflow.run.cancelled 或人工决定，不能被误认为用户已取消或审批。

## 2. Ledger 投影

权威实现：[`src/core/reducer.ts`](../src/core/reducer.ts)。

事件流按因果关系排序后交给纯 reducer，输出包含：

- `reducer_version`
- `input_hash`
- `output_hash`
- `entries`

条目状态为 `provisional → confirmed → overturned`。`confirmed → provisional` 只允许通过 `ledger.entry.anchor_drifted`。条件字段 `expected_status` 或 `based_on` 不满足时，reducer 标记 `conflict`，不静默择胜。

`ledger.yaml` 是可再生投影，不是第二个事实来源。修改事件后应使用 `rebuildLedger()` 重建，并用 `doctor()` 对账。

## 3. Workflow 和 Gate

权威 schema：`WorkflowDefSchema`、`GateDefSchema`；加载器：[`src/workflow/loader.ts`](../src/workflow/loader.ts)；执行器：[`src/workflow/executor.ts`](../src/workflow/executor.ts)。

ADR-0034 区分公开 workflow_id、稳定 workflow_revision 与一次 run_id。`workflowRevision(def, {id,version})` 对规范化完整定义及发布绑定计算 SHA-256；同版本稳定，不同定义/版本/发布名称隔离。`matchesWorkflowScope` 同时验证 ID 和版本，显式版本不回退无版本历史，无版本库模式也不继承带版本事实。

server 总是传入版本，workflow.node、gate、agent.task、协调轮次与人工决策记录该身份。进度扫点、worker checkpoint、待人工 gate、取消、event-emitted checker、快照、终态/时间线/审批和协调输入都按同一作用域读取。文档/共识账本仍为需求 session 共享输入，快照的事件 provenance 仍覆盖完整事件批次。`SnapshotOptions.workflow_revision` 必须同时带 workflow_id；无过滤的全 session 快照保留各作用域的等待，取消只移除匹配版本。

`workflow.run.started{run_id,workflow_id,workflow_revision,sdlc_id,sdlc_version,coordination_round_id?}` 是发布绑定事实。登记后、派发前追加，失败不派发；run 索引增加可空版本列，兼容旧表。恢复从 started 重建缺失索引，当前绑定按因果启动顺序确定，不依赖墙钟或索引插入顺序；只恢复最新绑定，历史版本不自动推进。无版本/缺启动事实/登记与事实不一致/发布定义已改变时 fail-closed；协调 run 额外核验对应采用事实。索引删除不能让当前需求回退默认 SDLC。

RunInfo、ApprovalItem、CoordinationRoundView 公开 workflow_revision（旧数据为 null）。当前审批列表和需求投影按最新绑定版本过滤，事件接口仍展示完整历史。决策必须属于当前版本，旧等待 ULID 不得用于新版本。旧无版本事实保留审计，不隐式迁移；用户重新 start 指定版本后重新核验。

Workflow 必须声明节点、依赖和 gate。gate 至少包含：

- `role`
- `attach.node` 与所属节点一致
- `attach.when`：`pre` 或 `post`
- 一个或多个 `checks`
- `pass.require`：`all` 或 `any`
- `on_fail`：`block`、`warn` 或 `escalate`
- 可选的 `timeout`

checker 结果是 `pass`、`block` 或 `warn`。未知 checker、抛错和非法返回值都按 `block` 处理。

`ledger-has-confirmed` 从当前 session 事件投影判定；默认无 session 目录路径严格读取 events.jsonl，不回退旧 ledger.yaml（ADR-0029）。只有无冲突的 confirmed 条目可放行，非法 entry_id、坏事件、外部 session 事件和读故障均 block。显式 readLedger adapter 继续支持，宿主负责提供最新投影，返回值经 schema 验证。

`checks` 项可带 `with` 参数（ADR-0024），透传为 `CheckerContext.params`；参数非法由 checker 按 `block` 处理，不用缺省值猜。内置 checker：`anchors-present`、`ledger-has-confirmed`、`vote-confirmed`、`verification-passed {verification_id, within_node?}`，以及参数化的 `file-exists {path}`、`file-nonempty {path, min_bytes?}`、`doc-has-section {path, heading}`、`anchors-min-count {min}`、`event-emitted {type, within_node?}`。文件类 path 一律限制在 session 目录内。gate 求值会把当前 `input_hash` 透传给 checker，机器验证不得复用旧输入。

ADR-0036 将文档访问集中到 core/session-files：规范相对路径、session 根为普通目录、路径段无符号链接、叶文件为 nlink=1 的普通文件；禁止事实/管理路径。file-exists 使用 no-follow 描述符只读元信息，不加载正文；内容 checker 使用同一描述符边界读取 UTF-8。缺失或无法验证均 block，无有效证据锚点，修复后可重新求值。coordinator 旧 helper 路径保留 re-export。

REST 快照文档 read/write/detail 使用同一 helper：readDoc 仅真实缺失为 404，边界错误 409，其余 IO 错误 500，不返回文档正文或底层错误原文。详情不把非法文件声明为可用。writeDoc 独占临时文件、fsync、rename；替换失败保留旧文档并清理临时文件，IO 失败仍遵循幂等未确认规则。Node 最终文件 no-follow 与父路径检查不提供跨进程父目录替换的强事务，不替代 OS 沙箱。

console 读取失败保持编辑/保存禁用，不能声明已与磁盘一致或当成新文档；真实 404 仍允许创建，切换文档可重新读取修复后的文件，保存期间禁用编辑与文档切换。

节点可声明执行体 `run`（ADR-0023/0056）：`{ agent, prompt?, readonly?, timeout_ms?, retry?, goal? }`。执行顺序为 pre gates → node.run → post gates；node.run 由注入执行器的 `NodeRunner` 端口处理（生产实现是协调 agent，见 `src/coordinator/`），未注入时普通任务跳过并在 node.exited 记 `notes`，Goal 节点拒绝跳过。未退出节点恢复时通过 `NodeRunner.isCompletionReusable` 验证当前输入 hash 与产物后态，相同才复用历史 ok；旧事件没有指纹、验证错误或接口未提供时重新执行（ADR-0030）。已退出节点保持原事实，不自动回滚。

`run.goal`（ADR-0056）：`{ inputs, checks: [{id, bin, args, timeout_ms}], max_attempts?, timeout_ms?, no_progress_limit? }`。inputs/checks 必须非空，命令 id 唯一；节点必须声明 review artifact、可写且不同时声明 retry。缺省尝试 3 次、总时长 30 分钟、连续无进展 2 次；命令缺省 2 分钟。NodeRunner 需要 run_id 与 read_verification_input 宿主钩子，server 复用当前源码/审批输入。检查 argv 在工作区根直接 spawn，无 shell；超时/取消回收进程组。普通失败与指南缺项自动反馈修复，预算/环境/输入变化等阻塞记 run failed，不自动人工放行。

`goal.attempt.started/completed` 绑定 workflow/run/node 与 attempt；首个 started.timestamp 锁定同 run 总时长，已开始但中断的尝试也消耗预算。completed 的 ready 包含 completion_event_id、input/source/artifact hash 及 verification_event_ids；retrying/blocked 含 failure_kind、原因与可选 progress_hash（源码+失败集合，指南文字变化不算代码进展）。宿主审计“变更 / 验收 / 风险”非空章节，补入实际命令证据，再把 verification.completed 绑定最终指南输入；补写期间源码/需求变化不能记 ready。完整输出不持久化，失败尾部只作内存反馈，Goal prompt_excerpt 不含原命令输出。

Goal 复用只接受同 run 最新 ready、原完成引用、当前输入/指南和声明命令对应的最新宿主验证事实全部一致；成功 task 本身不足以让 Goal 节点退出。新 run 的未退出 Goal 重新验证；既有退出事实仍按发布执行版本隔离。最终 post gate 保持原语义；检查脚本与依赖仍是授权工作区的信任边界，不承诺 OS 隔离或对恶意 worker 的证据防篡改。

协调执行观察同时投影每个 `run.goal` 节点的 `goals`：`missing/started/retrying/ready/blocked/cancelled/invalid`、尝试/预算、failure_kind、截断 reason、输入/产物 hash 和验证事件 ID。原始 worker 正文、日志和命令输出不进入协调上下文。`goal` evidence 只能引用当前 Goal 事件；当前 blocked/invalid/cancelled 会使 `eligible_nodes=[]`，任何 advance 由宿主拒绝，Context Session Agent 只能提出 ask_human 或 wait。人工选择仍进入既有澄清事实，不等于增加预算、授权或放行 gate（ADR-0057）。

ADR-0061 统一 ready 证据：resolveGoalReadiness 校验同批事实中的最新 Goal、真实 worker 成功/产物证据及随后实际执行的全部声明验证，命令/输入/source hash、零退出与宿主来源均一致；未来/外部/不存在/被替换的引用与 run 取消均拒绝。runner 复用与协调投影共用此规则，再核验当前 input/source/guide hash。CoordinationGoal.current 与 freshness_reason 只表示读取时新鲜度：ready/current=true/current 可作为当前 Goal 来源；结构错误 invalid/false/invalid_evidence，过期 ready/false/stale_input，不可读 ready/null/unavailable，取消 ready/false/run_cancelled。旧 hook 缺省 null/not_ready，不能声称当前就绪；非 ready 执行事实仍可引用，不自动解除阻塞。新鲜度进入协调 input_hash，变化使旧提议 stale，原 ready/退出/人工 gate 事实保持不变。

Goal 可选声明 `supervisor_agent` 与 `supervisor_timeout_ms`。同一 run/node 的 `goal.attempt.completed{status:blocked}` 落盘并使 run failed 后，宿主自动追加 `coordinator.round.requested{trigger:goal_blocked,run_id,node_id,goal_event_id}`，使用当前 resolver 发起受限协调。自动轮次只接受引用 blocker 的 `ask_human`/`wait`，advance、complete、缺证据或输入变化均 fail-closed。已有人工协调轮次先收束再检查，完全相同 blocker 只请求一次；重启只补缺少 request 事实的 blocker，已启动调用不重放。请求 actor 为 `goal-supervisor`，失败不覆盖原 run.error。

Goal 问题记录当前有效人工答复后，view.goal_retry 提供 available/reason、当前 input_hash 与已发布 max_attempts/timeout_ms；不复用答复前协调 hash。`POST .../:round_id/retry-goal` 要求幂等键、answer_event_id 和该输入 token，是独立执行授权。宿主运行槽位内与授权落盘前再次核验，先写 workflow.run.started.goal_retry_round_id，再写人工 goal.retry.authorized，最后派发。授权记录 round、新/旧 run、node、blocker、答复、input_hash 和预算；新 run 使用原发布额度，旧 Goal 失败与已退出节点保留。worker 使用固定 resolver；代码/事实/配置变化时旧 token 409，刷新后可授权当前版本。

ADR-0062 要求在首次校验前捕获 resolver，校验、授权和实际派发使用同一快照，并在授权前核对当前 worker/supervisor 身份。新 goal.retry.authorized 完整保存 agent_configuration_hash、supervisor_configuration_hash、node_input_hash；旧事件可三者全缺省，部分字段声明无效，聚合 input_hash 域仍为 v1。冷恢复与人工审批核验授权 worker 身份，漂移 failed/409；首次 worker 派发前还须节点输入相同。旧授权仅从首条合法、因果后续的 worker 任务归因，缺来源或坏来源拒绝。还原原配置后显式恢复同 run，保留原次数/时长；旧审批失效只重检原授权 run，不能借普通 start 新建预算。有效已开始 Goal 的正常输出不被视为首次派发输入篡改。

同 round 的同依据重复命令返回已有 run，不再授予预算；不同依据 409。没有答复、已撤回/被新同题选择替代、版本归档、来源/输入不可读均不可授权。新预算只绑定已发布上限，不支持请求携带任意预算字段。授权写失败不派发，只有当前同轮次 failed 且无授权/worker started 事实的半成品启动可通过新命令重试；5xx 未确认仍需新幂等键。冷恢复用 readGoalRetryAuthorization 校验授权前的因果链、预算与派发顺序，缺失/坏授权 fail-closed。授权后的答复撤回不自动取消已启动 run，取消使用原接口（ADR-0059）。

需求 detail 的 artifacts 列出当前绑定 SDLC 声明的路径与可读状态。`GET /requirements/:req_id/artifacts?path=...` 只读声明产物：未声明/缺失 404，普通文件边界冲突 409，IO 失败 500；不提供写入口。控制台文档页复用 Markdown 原文/预览视图，只读查看自定义指南；固定四份快照仍可编辑。Goal blocked 在需求投影显示 blocked，具体原因见 run.error 与尝试事件。

`run.retry`（ADR-0025）：`{ max_attempts(1-10, 默认 1), backoff_ms(默认 0) }`。协调 agent 按尝试循环，退避为 `backoff_ms × 第 n 次失败`，每次尝试落独立的 agent.task.started/completed（带 `attempt`/`max_attempts`），重试的上下文包附上次失败摘要。驱动解析失败属定义性错误，不重试。

ACP 条目/原生 options 的可选 permission_policy 声明 read/edit 相对范围，归一化去重排序后纳入 ACP 配置 v3；未声明保留 v1/v2。可写任务只按 ACP kind 和全部 absolute locations 核验 cwd 与普通文件边界，edit 可创建，read 须存在，匹配时只选 allow_once；readonly 继续拒绝。未知操作、缺位置、越界/链接/管理文件或 IO 不可判定均取消，回执 metadata 不混入产物，清单仅返回范围数量。该协议检查不替代 OS 沙箱，也不推断 rawInput 中的自由命令（ADR-0060）。

permission 驱动错误同样 retryable=false；权限拒绝后即使收到普通 agent 错误也不能自动获得重试。Goal 由该事实形成 blocked，可走既有 supervisor/人工处理路径，不用重复派发取得授权。

ADR-0038 增可选 `run.output`（auto/text，缺省 auto）。auto 保留 agent 文件通道优先/文本回退，可写任务按既有语义写回，readonly 不写 artifact。text 必须声明 artifact，worker 最终文本由 coordinator 经共享文档 helper 代写，readonly 权限保持原样；文本模式观察到文件前后变化时保留现状并失败，不能改记 agent 自写。完整有效正文才可写，空/占位/metadata/失败/取消不生成成功报告，事件记录显式 output 与产物证据。

text artifact 属当前节点输出，不参与该节点语义输入 hash，避免自身代写使 checkpoint 失效；复用仍要求 artifact_written 与 artifact_after_hash 匹配。PRD、上游资料、账本、workflow/配置变化仍使未退出任务失效。后置 gate 和人工审批按新产物核验，报告存在不证明结论正确，不自动批准或合入。

上下文快照（ADR-0026）除固定的 `prd.md` / `plan.md` / `adr.md` / `findings.md` 外，还会采集 workflow 节点声明的 artifact；上游产物按依赖闭包进入上下文包。artifact 必须是 `cord/<req-id>/` 内的相对路径，越界路径以 `agent.task.completed{status: failed}` 记录。快照只把截断内容放入 prompt，完整文档通过 `content_hash` 参与 `snapshot_id`，不会复制进事件流。

快照的账本摘要、进度和事件 hash 来自同一次事件读取（ADR-0028），不依赖可能滞后的 `ledger.yaml`；coordinator 按当前 workflow 过滤节点进度，保留账本 conflict 标记。缺失文档合法，其他读取错误拒绝派发。文档访问拒绝符号链接、硬链接、非普通文件和事实/管理路径（events.jsonl、ledger.yaml、agents.yaml、.git、.index、.sdlc）；代写使用独占临时文件、fsync 和 rename。该边界用于 coordinator 文件访问，不替代 worker 的操作系统权限控制。

ADR-0047 增加 EventStore.readOrderedStrict 可选端口与共享 readSessionEvents。原生严格读取校验当前每行 envelope/session，拒绝坏完整行、活跃读取中的未完成残行和外部 session，不跳过；完整事件仅缺结尾换行仍可读，冷打开继续按原子边界修复尾行。快照、验证和协调读侧优先严格端口，旧自定义端口仍兼容但须兑现返回全部事实的契约，提供 unparsable_line 诊断时拒绝。当前文件修复后原生严格读不被历史诊断锁死；冷打开已锁定写入的存储仍需修复后重新打开。未知合法 payload 保持前向兼容，不替代 doctor 哈希链检查，也不自动修复坏完整行。worker 的完整性错误不可自动重试，普通 IO 故障仍按既有重试策略处理。

run 取消（ADR-0025）：`POST /api/v1/runs/:run_id/cancel` 先落 `workflow.run.cancelled` 事件（事实），再 abort 在途执行器——`AbortSignal` 经执行器 → NodeRunContext → AgentTask 透传到 driver，driver 杀进程树并关闭事件流。人工 gate 挂起处 ask 与 abort 竞速，取消**不落 gate.resolved 假判定**；取消使该流程未决 gate 从审批投影移除，重新 start 即断点续跑。终态判定按 `run_id` 匹配取消事件，历史 run 的取消不污染新 run。

人工 gate 的事实顺序是：

```text
gate.waiting → human.decision.recorded → gate.resolved
```

`gate.waiting.evaluation_hash` 标识机器检查与审批输入版本，server 注入完整需求快照 hash。等待恢复与选择返回后调用同一 `evaluateGate` 重新检查；依据变化落 `gate.invalidated{workflow_id,node_id,gate_id,waiting_event_id,reason}`，移除匹配旧等待并重检，不伪造人工拒绝。worker checkpoint 过期时先重跑未退出节点，再审批新产物。

REST 的 `approval_id` 是等待事件 ULID；旧静态编码可解析但不允许写决策。当前选择校验指纹后再落 `human.decision.recorded`（含 waiting_event_id/evaluation_hash），同需求串行处理，同版本已有决策时拒绝重复写入。有效选择重启后从事件恢复消费；过期版本不能进入新审批。旧审批和输入变化返回 409，客户端刷新审批列表。`HumanGate.ask` 可接收等待上下文，返回字符串选择或 `{kind: recheck}` 控制响应。

## 4. 投票

权威实现：[`src/voting/executor.ts`](../src/voting/executor.ts)。

- voter 数量为 2 或 3。
- 每票独立调用 provider，选项顺序可单票置换。
- 输出必须符合结构化 verdict schema。
- 锚点经过 verifier；不可验证的票按弃权处理。
- 记录结论、模型、prompt hash、usage、响应 hash 和锚点重合度。
- 少数派理由进入 `VoteRecord.minority`。

投票执行器只返回记录，不直接写账本；写回必须由调用方追加 `vote.completed` 和后续账本事件。

## 5. 版本和兼容性

- 事件 envelope 当前为 `schema_version: "1"`。
- reducer 当前为 `REDUCER_VERSION = "1"`。
- Workflow 当前为 `agent-cord.dev/v1alpha1`。
- 修改跨模块契约前先更新对应 ADR，并补成功、失败和恢复路径测试。

## 6. 工作区 Agent 配置

`cord/agents.yaml` 由独立 registry 编译（ADR-0027），ACP 和自定义 headless 参数不修改全局表。`registerAgentsYaml` 保留为配置检查入口，不再注册全局模板；使用 `resolveWithAgentsYaml` / `createAgentRegistry` 获取工作区 resolver。顶层结构或 IO 错误拒绝重载，单条定义错误按字段路径告警并阻断该别名。模板与 args 必须二选一；模板形态可省略 `bin`，自定义 args 形态必须提供。

`GET /api/v1/agents` 返回 `revision`、`agents[{name, kind, source, template, configuration_hash}]`、`warnings`、`rejected`。configuration_hash 无身份时为 null，表示执行定义，不探测安装、环境变量或外部命名 agent 文件。`POST /api/v1/agents/reload` 需要 `Idempotency-Key`，成功后替换配置并递增 revision，失败保持原配置；删除可选文件后重载恢复内置清单。在途 run 固定 resolver 与身份，后续 run 使用新配置；重启后 resolver 从当前文件重建，revision 重新编号。响应不携带 env、完整 args、角色 prompt 或 `agents_json`。console Agent 页只展示此投影并发起明确命令。

## 7. Context Session Agent

`ContextSessionAgent.coordinate` 每轮重新采集当前 workflow 的需求文档、事件派生账本/进度/人工等待，调用 `driver.run` 新会话（readonly），不 resume 或注入历史事件/旧提议。上下文总字符预算与结果上限为 60000/32768，必需元信息超预算时拒绝派发。driver metadata 不作文本 fallback，明确空最终字符串不能回退。

ADR-0046 的 readCoordinationSnapshot 共用独立协调采集策略：每份长文档在 20000 字符内保留首尾，普通 readSnapshot 默认仍只取前缀。总预算扣除固定元信息和片段索引后在有内容文档间均衡分配，短文档额度回流；截断不拆开 Unicode 代理对。prompt 的 document_excerpts 记录 file、included_chars、omitted_chars 与 ranges（UTF-16 原文偏移，起点包含、终点不包含），正文展示这些范围。未展示内容不能声称已核验；首尾片段也不保证包含中间所有关键要求。

输出必须符合 `CoordinationProposalSchema`：summary、next_action、risks；next_action 是 advance / ask_human / wait / complete，每种都必须有 reason 和 evidence。evidence 引用存在的 snapshot document、无冲突 confirmed ledger entry、当前 workflow node、current=true 的最新机器验证 event_id 或 agent_task 的当前 run 最新合法任务 event_id。workflow ID 指 node.id，不指 gate.id。advance 只能指向执行器拓扑顺序第一个未退出且依赖已退出的节点，无待人工 gate或活动绑定 run；complete 要求全部退出且无等待/活动 run；人工选项不能重复。未知字段、自由文本、围栏 JSON、未知来源或非法节点均 failed/output。存在性验证不等价于语义正确性。

轮次事件与 worker 恢复完全分离：server requested 绑定 SDLC 版本，started/completed 记录 round_id、workflow_id、driver、snapshot provenance、input_hash、prompt_hash 与可选配置身份。语义 input_hash 排除事件序号与轮次自身事件，覆盖完整文档 hash、账本、进度/等待、workflow 和配置身份。结果返回前重检；变化记 stale，读取失败记 failed/freshness，均没有提议。completed 只在 ok 时携带提议，其余状态 proposal 为 null；不保存原始输出/上下文或 driver raw。

ADR-0043 的 ContextSessionAgentOptions.read_source_hash(def) 将声明源码身份加入协调轮次：server 对绑定流程全部 verification-passed.with.inputs 取并集，prompt 元信息与 started/completed 保存 source_hash。该阶段曾使用绑定源码的 v2 域与无绑定的 v1 域，后续策略与当前输入域见下文。完成、查询和采用 guard 重新扫描同一范围；代码变更导致 stale 或 current=false，无法判定时不可采用。中断恢复保留旧摘要但不重放模型调用。source_hash 不等价于测试通过，snapshot_id 仍记录文档/事件 provenance。

ADR-0044 的 read_verifications(def, session, revision) 为协调者提供最多 128 项严格机器观察。server 只保留当前 run/发布版本/声明检查的最新结果，共用 readNodeInput 校验 current；缺失、坏结果、过期、取消和读失败不能标为当前有效。观察包含 status/current/reason、事件 ID、输入/命令/源码摘要及退出码，不含 summary 或日志。该阶段曾用 v3 域绑定观察，后续策略与当前输入域见下文；完成/查询/采用重检同一投影，轮次只落 verification_context_hash。当前失败事实可作为 verification 来源用于解释等待，但不能冒充 passed 或绕过人工 gate。来源点击在控制台打开并展开结果事件。

coordinationInputHash 自 v4 起加入 context_policy=balanced-head-tail.v1，继续绑定完整原文 hash、配置、workflow、进度、声明源码与机器观察。查询/采用和模型完成共用首尾采集，旧域成功轮次保留历史但需重新协调。片段正文和索引不落事件，事件只保留 prompt/input hash。已采用轮次的原 run 重放语义不变，不自动回滚已退出节点。

ADR-0048 的 read_execution_context(def, session, revision) 提供严格 CoordinationExecutionContext：当前发布绑定 run 的 run_id/status/active，以及最多 128 项、完整覆盖 node.run 声明的任务元信息。宿主从同批严格事件定位 run 和最新任务；旧 run/版本、无 run_id 的旧任务不进入当前来源，坏的最新 payload/correlation/重试编号为 invalid，不回退历史成功。missing 表示无当前任务，started 只表示启动事实，active=false 时不能推断进程仍活着；active 来自匹配且未终态的本机运行槽位。任务 ok 不等于机器测试或 gate 通过，也不证明仍对应修改后的输入。

server 执行观察进入 prompt、输入身份与完成/查询/采用重检，任务终态或 event_id 替换、run 变更、active 变化都使旧轮次失效。轮次/REST view 只新增 execution_context_hash，不注入 error/text/prompt_excerpt/raw。该阶段使用 v5，后续复用与工具扩展分别升级至 v6/v7。当前合法任务可作为 agent_task 来源，控制台打开并展开对应事件；活动绑定 run 时 eligible_nodes=[]，模型只能提出 wait/ask_human。failed/cancelled 且 inactive 可提出重试方向，仍由人工采用和现有 runner 核验。采用写失败后产生的新 run 事实也改变执行观察，需重新协调，不能继续采用旧提议。

复用任务投影为 reused，event_id 是当前复用事实，completion_event_id 是更早的原始 ok 完成；缺省非复用字段归一化为 null，hook 输入类型 CoordinationExecutionContextInput 允许旧实现省略此字段。严格校验原完成的同 session/流程版本/节点、类型/状态/correlation、重试编号不超过上限、摘要一致及中间没有覆盖它的 started/completed。缺失、未来、自引用、另一复用或坏最新引用为 invalid，不回退旧成功。reused 不声明新的重试编号，不等于新执行、当前输入永远有效或 gate 通过。该阶段 server 使用 v6 域，无 hook 为 v4；后续策略升级仍要求旧轮次重新协调。提议来源用当前 reused event_id，事件视图可继续跳到已加载的原完成，前端只导航、不复制复用判定。

ADR-0050 的 tool_policy=none.v1 绑定当前独立协调策略：server 域 v7，无执行观察 hook 的库模式 v5。消费到任意 tool_use（含只读、空/未知负载或 result 后工具）立即 abort、关闭迭代器并保存 failed/driver，提议为 null，不保存工具名称/参数/raw；已确认失败不被清理错误覆盖。用户实际取消仍为 cancelled，宿主策略中止不写 cancel_requested。ACP 清理等待单次启动、有界发送的 session/cancel 序列后回收进程，避免提前 return 丢失通知。旧 v6/v4 提议保留历史但不可视为符合新策略，须重新协调。检测不撤销通知前副作用，不认证 driver 的报告完整性，也不改变普通 worker 工具通道。

ADR-0052 增 coordinator.round.answered，严格 payload={round_id,workflow_id,workflow_revision?,completion_event_id,input_hash,choice}，actor=human、correlation=round。原完成须更早且为该 round 当前合法 ok/ask_human，流程版本/input 一致、选项存在，不能引用失败/非问题/未来/自引用或被替代的完成；相关坏事实 fail-closed，不回退旧值。写前重新核验最新完成的问题和选项，避免先记录非法引用。每个精确同题在当前 scope 投影最新选择，最多 128 个当前问题；API 达到容量时拒绝新增，不丢弃旧材料。

POST /requirements/:req_id/coordination/:round_id/answer 接收 {choice}，要求 Idempotency-Key。只接受当前有效未归档问题，额外字段/未知选项为 400，过期/非问题/不同已存选择/并发冲突为 409。每需求一个答复槽位，相同轮次/选择共享结果；已记录同选择可重放，不同选择须新有效轮次重新提问。轮次新增可缺省 DTO 字段 answer（event_id/choice/answered_at/completion_event_id）、answerable、answer_reason；原生 server 总是提供，旧 server/客户端仍可只展示问题。

RequirementSnapshot.clarifications 是同批事实的最新 question/choice/event_id/round_id，不是完整对话历史。独立协调可使用 source=clarification 引用答复 event_id，worker 与审批读取同一材料；人工选择不意味着测试/gate/执行授权或对后续文档永远适用。存在澄清时协调域为 server v8 / 无 hook v6、worker execution-input v5、approval-context v2；空数组或老库缺省字段保留 v7/v5、worker v4、审批 v1。答复使旧依据失效，后续显式重新协调/执行；不写 human.decision.recorded、不放行 gate、不启动 run 或恢复模型会话。界面提供原生单选、记录中/失败保留选择/过期禁用/已答复与事件导航。

ADR-0053 的 coordinator.round.answer_revoked 严格 payload={round_id,workflow_id,workflow_revision?,answer_event_id}，actor=human/correlation=round，引用同 session/scope/round 更早的合法答复。POST /requirements/:req_id/coordination/:round_id/answer/revoke 接收 {answer_event_id}，要求 Idempotency-Key；答复缺失、预期 ID 失效、被更新的同题答复替代为 409，坏格式/额外字段为 400。同撤回操作重放原结果；原问题 current=false 或材料变化仍允许撤回当前有效选择，不自动批准或启动。

answer DTO 增可缺省 revoked_at/revocation_event_id，轮次增 answer_revocable；answer/revoke 共用按需求预留槽位，重复相同操作共享结果，不同操作在途冲突为 409，失败释放槽位。撤回后旧轮次不接受新答复；新有效轮次可重新澄清。只读历史不删除、不改写原事件。

SnapshotClarification.choice 扩展为 string|null，撤回状态额外携带 status=revoked，event_id 指向撤回。最新撤回仍占当前同题位置，不回退较早选择；最多 128 项包括未确定状态。撤回保持非空澄清域，新的状态和来源使旧输入/checkpoint/审批失效，不复活无澄清身份。模型只可引用当前撤回来源解释未知状态，不能沿用撤回选项；已退出节点、人工决定和产物均不回滚。

REST 创建 `POST /requirements/:req_id/coordination` 输入 `{agent, sdlc_id?, sdlc_version?, timeout_ms?}`，返回 202；列表/读取使用 GET，取消 `POST .../:round_id/cancel` 先落 cancel_requested 再 abort。写命令使用 Idempotency-Key；跨 method/path 复用键返回 409，创建并发同键合并为一轮。每需求只允许一轮在途协调，resolver 在创建时固定，归档版本拒绝新轮次。事件写入失败必须报告宿主，不能伪造 completed。server 重启将未完成轮次落 failed/interrupted；已有取消请求则落 cancelled，不重放模型调用。

协调创建在 requested 前严格预检事件；列表/查询/采用的完整性错误返回 409，不回退旧提议。冷协调恢复隔离坏 session，保留原请求事实且不写中断终态或重放调用，健康需求继续可用；修复并重新启动后执行正常 interrupted 恢复。明确取消遇到读取/落盘错误时仍收束当前匹配轮次的进程，接口保留原错误，不伪造 cancel_requested 或取消成功；能落盘的 completed 如实记录 cancelled，写失败则走已有中断恢复。普通事件诊断浏览和其余 workflow 投影保持原读取语义，本规则保护快照、验证与协调决策边界。

提议是该轮完成时的 Draft，之后的输入变更应发起新轮次。任何提议本身都不生成 node.exited、gate.resolved 或 artifact；实际推进仍经既有 workflow run 与人工 gate。readonly 不提供 OS 沙箱（ADR-0032）。

ADR-0033 增 `POST .../:round_id/adopt` 人工采用：查询投影保留原 agent 别名，公开 current（true/false/null）、adoptable、adoption_reason、adopted_run_id/adopted_at。历史 ok 与 current=false 可同时成立，浏览器不能据此自行放行。写时在 RunService 的预留槽位内核验绑定版本、配置身份、最新快照与真实下一节点，归档/未知身份/读取失败/过期均 409；只接受 advance，其余行动保持 Draft。

采用事实 `coordinator.round.adopted{round_id,workflow_id,node_id,input_hash,run_id}` 使用 human actor，登记 run 后、launch 前经 append 落盘。普通 run 与采用共享在途互斥，同轮并发/重启重放返回原 run，不重复派发。事件写入失败记 run failed；run 登记含可空 coordination_round_id，旧 SQLite 表自动增加该列。恢复时绑定协调轮次的 run 必须有匹配采用事实及 requested SDLC 版本，否则 failed 而不启动。投影消费采用事件时核验 workflow/node/input/run 一致性，不允许错误引用或双 run 绑定伪装成功。终态查询等待后台槽位释放后返回，下一轮不要求固定延迟。

console 需求详情“协调”视图只展示这些投影，并通过 typed client 发起创建、取消和采用；来源导航沿用文档/账本/概览。新鲜度轮询在后台页面暂停，组件卸载释放定时器；请求失败保留已加载历史与提议。文档切换时同步进入 loading，加载中禁用编辑/保存，防止迟到读取覆盖输入。

## 8. REST 幂等执行

ADR-0035 的共享 hook 覆盖所有 idempotency=true 的写入口，替代 agents/reload 与协调创建的局部并发映射。key trim 后长度 1-200；请求身份为 method、精确 URL、input_hash。输入 hash 使用排序 JSON 对象字段，保留嵌套自有字段、数组顺序、字符串内容，区分 absent 与显式 null；不保存 body 正文，不改变历史事件 hash 协议。

preHandler 同步获得 SQLite pending 占位后才进入业务，相同身份在途请求等待同一 owner 最终响应；不同命令/输入立即 409，不修改或释放原占位。成功 onSend 条件更新为 completed 后再发布 status/body/content-type；缓存重放保留首次 request_id。owner 终态清理内存，断连不等于业务取消，观察失败不能触发第二次派发。业务 service 原有同需求互斥和事件语义继续生效。

4xx 已知拒绝释放 pending，允许修复后使用该键重试；5xx 可能发生在副作用之后，保留 pending。完成响应/拒绝释放的持久化失败返回 `500 idempotency_unconfirmed`，同键之后或重启返回 `409 idempotency_incomplete`，需核验实际状态再以新键发起新操作。无输入身份的旧缓存返回 `409 idempotency_legacy`，保留旧记录，不猜测匹配。SQLite 兼容新增 input_hash、state 与 content_type，条件写校验身份和 pending 状态。

本实现不提供事件/文件/SQLite 之间的原子业务事务，也不自动重试未知请求；跨进程同键占位只保证不能同时获得执行权，不代替 worker lease。删除索引会丢失幂等保护，不能把删除当作 pending 恢复。validate/doctor 等只读检查保持现有无需 key 的规则。
