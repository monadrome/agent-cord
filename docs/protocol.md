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
| `workflow.run.*` | run 级控制：取消（cancelled，ADR-0025） |
| `agent.task.*` | 节点执行体的 agent 任务（started / completed；中间流式输出不入流） |
| `coordinator.round.*` | 独立协调轮次（requested / started / completed / cancel_requested）与人工采用（adopted） |
| `human.*` | 人工选择记录 |

事件类型目录在 `EVENT_TYPES`；新增类型需要同步 schema 和 ADR。

`agent.task.started/completed` 会记录 `snapshot_id`、`snapshot_event_seq` 与 `snapshot_event_chain_hash`（ADR-0026），标识本次派发使用的最新需求快照。`agent.task.completed` 的其他关键字段：`status`（ok / failed / timeout / cancelled）、`text`（截断 32KB）、`artifact_written` 与 `written_by`（agent / coordinator / none）、`attempt` 与 `max_attempts`（重试时）、`agent_session_id`（仅供人工调试 resume，执行器恢复总是新会话）。`cancelled` 不算失败：不计入 failed 终态，也不触发重试。

ADR-0028 增加失败阶段 `failure_stage`（snapshot / configuration / driver / artifact）和 `retryable`。配置及永久文件路径错误不重试；普通准备、驱动与写回故障都有任务终态，瞬态故障按节点策略重试。准备失败时尚无成功快照，provenance 字段省略。事件追加失败必须上抛宿主，不能用未持久化的 completed 伪造终态。

ADR-0029 增加 `artifact_before_hash`（started/completed）、`artifact_after_hash` 与 `artifact_changed`（completed）。不存在文件用 null，后态不可读时省略 after/changed。旧内容不变不能记为当前 agent 自写；有完整最终文本则代写 draft，可写产物无新内容且无最终文本则 failed/artifact。代写前与替换前比较预期 hash，观察到冲突时保留现状并失败。`written_by=agent` 指运行期间观察到有效文件变化，不保证操作系统写者身份。

driver 保留明确空最终字符串，与无显式最终文本的 null 区分；初始化、协议进度、用户回声、思考等已识别辅助输出以 `TextEventData.channel=metadata` 保留 raw，coordinator 不把它们拼为 fallback 产物。未标记的文本仍视为内容，维持自定义 driver 兼容性。

ADR-0030 增加 `execution_input_hash`（agent started/completed）：覆盖完整 workflow、节点、需求文档 hash、账本摘要、已退出进度和上下文预算，排除事件序号/时间戳。可写当前 artifact 以 completed 后态验证，不把自身写入作为输入变化。`snapshot_id` 继续记录完整 provenance，两者作用不同。

ADR-0031 增加 driver 可选 `configuration_hash` 与任务事件 `agent_configuration_hash`，内置 headless/ACP 从固定有效启动参数派生，全部 env 排除。该身份纳入 execution_input_hash（内部域 v2）和节点审批上下文；同名模型/角色参数变更后，未退出节点重新执行并重新审批。外部 driver 未提供身份时仍支持，但宿主需提供可靠身份才能覆盖其配置变化。

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

`checks` 项可带 `with` 参数（ADR-0024），透传为 `CheckerContext.params`；参数非法由 checker 按 `block` 处理，不用缺省值猜。内置 checker：`anchors-present`、`ledger-has-confirmed`、`vote-confirmed`，以及参数化的 `file-exists {path}`、`file-nonempty {path, min_bytes?}`、`doc-has-section {path, heading}`、`anchors-min-count {min}`、`event-emitted {type, within_node?}`。文件类 path 一律限制在 session 目录内。

节点可声明执行体 `run`（ADR-0023）：`{ agent, prompt?, readonly?, timeout_ms?, retry? }`。执行顺序为 pre gates → node.run → post gates；node.run 由注入执行器的 `NodeRunner` 端口处理（生产实现是协调 agent，见 `src/coordinator/`），未注入时跳过并在 node.exited 记 `notes`。未退出节点恢复时通过 `NodeRunner.isCompletionReusable` 验证当前输入 hash 与产物后态，相同才复用历史 ok；旧事件没有指纹、验证错误或接口未提供时重新执行（ADR-0030）。已退出节点保持原事实，不自动回滚。

`run.retry`（ADR-0025）：`{ max_attempts(1-10, 默认 1), backoff_ms(默认 0) }`。协调 agent 按尝试循环，退避为 `backoff_ms × 第 n 次失败`，每次尝试落独立的 agent.task.started/completed（带 `attempt`/`max_attempts`），重试的上下文包附上次失败摘要。驱动解析失败属定义性错误，不重试。

上下文快照（ADR-0026）除固定的 `prd.md` / `plan.md` / `adr.md` / `findings.md` 外，还会采集 workflow 节点声明的 artifact；上游产物按依赖闭包进入上下文包。artifact 必须是 `cord/<req-id>/` 内的相对路径，越界路径以 `agent.task.completed{status: failed}` 记录。快照只把截断内容放入 prompt，完整文档通过 `content_hash` 参与 `snapshot_id`，不会复制进事件流。

快照的账本摘要、进度和事件 hash 来自同一次事件读取（ADR-0028），不依赖可能滞后的 `ledger.yaml`；coordinator 按当前 workflow 过滤节点进度，保留账本 conflict 标记。缺失文档合法，其他读取错误拒绝派发。文档访问拒绝符号链接、硬链接、非普通文件和事实/管理路径（events.jsonl、ledger.yaml、agents.yaml、.git、.index、.sdlc）；代写使用独占临时文件、fsync 和 rename。该边界用于 coordinator 文件访问，不替代 worker 的操作系统权限控制。

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

输出必须符合 `CoordinationProposalSchema`：summary、next_action、risks；next_action 是 advance / ask_human / wait / complete，每种都必须有 reason 和 evidence。evidence 仅引用存在的 snapshot document、无冲突 confirmed ledger entry 或当前 workflow node。advance 只能指向执行器拓扑顺序第一个未退出且依赖已退出的节点，无待人工 gate；complete 要求全部退出且无等待；人工选项不能重复。未知字段、自由文本、围栏 JSON、未知来源或非法节点均 failed/output。存在性验证不等价于语义正确性。

轮次事件与 worker 恢复完全分离：server requested 绑定 SDLC 版本，started/completed 记录 round_id、workflow_id、driver、snapshot provenance、input_hash、prompt_hash 与可选配置身份。语义 input_hash 排除事件序号与轮次自身事件，覆盖完整文档 hash、账本、进度/等待、workflow 和配置身份。结果返回前重检；变化记 stale，读取失败记 failed/freshness，均没有提议。completed 只在 ok 时携带提议，其余状态 proposal 为 null；不保存原始输出/上下文或 driver raw。

REST 创建 `POST /requirements/:req_id/coordination` 输入 `{agent, sdlc_id?, sdlc_version?, timeout_ms?}`，返回 202；列表/读取使用 GET，取消 `POST .../:round_id/cancel` 先落 cancel_requested 再 abort。写命令使用 Idempotency-Key；跨 method/path 复用键返回 409，创建并发同键合并为一轮。每需求只允许一轮在途协调，resolver 在创建时固定，归档版本拒绝新轮次。事件写入失败必须报告宿主，不能伪造 completed。server 重启将未完成轮次落 failed/interrupted；已有取消请求则落 cancelled，不重放模型调用。

提议是该轮完成时的 Draft，之后的输入变更应发起新轮次。任何提议本身都不生成 node.exited、gate.resolved 或 artifact；实际推进仍经既有 workflow run 与人工 gate。readonly 不提供 OS 沙箱（ADR-0032）。

ADR-0033 增 `POST .../:round_id/adopt` 人工采用：查询投影保留原 agent 别名，公开 current（true/false/null）、adoptable、adoption_reason、adopted_run_id/adopted_at。历史 ok 与 current=false 可同时成立，浏览器不能据此自行放行。写时在 RunService 的预留槽位内核验绑定版本、配置身份、最新快照与真实下一节点，归档/未知身份/读取失败/过期均 409；只接受 advance，其余行动保持 Draft。

采用事实 `coordinator.round.adopted{round_id,workflow_id,node_id,input_hash,run_id}` 使用 human actor，登记 run 后、launch 前经 append 落盘。普通 run 与采用共享在途互斥，同轮并发/重启重放返回原 run，不重复派发。事件写入失败记 run failed；run 登记含可空 coordination_round_id，旧 SQLite 表自动增加该列。恢复时绑定协调轮次的 run 必须有匹配采用事实及 requested SDLC 版本，否则 failed 而不启动。投影消费采用事件时核验 workflow/node/input/run 一致性，不允许错误引用或双 run 绑定伪装成功。终态查询等待后台槽位释放后返回，下一轮不要求固定延迟。

console 需求详情“协调”视图只展示这些投影，并通过 typed client 发起创建、取消和采用；来源导航沿用文档/账本/概览。新鲜度轮询在后台页面暂停，组件卸载释放定时器；请求失败保留已加载历史与提议。文档切换时同步进入 loading，加载中禁用编辑/保存，防止迟到读取覆盖输入。
