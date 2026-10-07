# 调研发现

## 当前实现可直接复用

- `src/core` 已提供事件信封、单写者 JSONL、确定性 reducer、账本重建和 doctor。
- `src/workflow` 已提供 YAML workflow schema、引用校验、拓扑执行、内置 checker、人工 gate 接口和事件恢复。
- `src/voting` 已提供 k=2~3 盲评投票、结构化模型输出、锚点校验和少数派留痕。
- `src/driver` 已提供 ACP 与 headless driver，包含超时、权限请求和进程清理。
- `src/index.ts` 已把上述模块作为库 API 导出。

## 当前缺口

- 没有 daemon、HTTP API、SSE/WebSocket 事件推送或运行实例索引。
- CLI 只有 init/new/doctor/demo/events，没有面向用户的需求工作台和 workflow run 命令。
- workflow 仍是 M2 内置 checker；CEL 和 MCP 外部 checker 尚未接入。
- `SessionHandle` 以文件夹为边界，缺少项目、用户、SDLC 定义、运行、审批任务等产品层对象。
- 前端工程、设计系统、鉴权和配置版本管理均不存在。

## 设计结论

- 控制台只负责展示、配置和发起命令；状态判定继续由 backend/core 完成。
- 事件流继续是权威事实；服务数据库只能存派生索引、任务队列和连接状态。
- 前端实时更新优先采用 SSE；写操作用 REST/JSON，避免第一版引入双向 WebSocket 状态协议。
- SDLC 定义使用版本化 YAML/JSON schema，UI 生成配置，不允许在控制台执行任意脚本。
- 第一版采用本地单用户模式，保留 workspace/user/role 边界，为后续多用户鉴权留接口。

## 实现校准（2026-09-25，MVP 落地）

- npm workspaces 注意：根包不会被自动链入 node_modules，子包引用根包用 `"agent-cord": "file:../.."`；根 exports 增加 `development` 条件（→ src/index.ts），tsx/vitest/tsc customConditions 用它免构建跑 dev 与测试。
- Fastify：`reply` 是 thenable，handler 中 `await reply.code(...)` 死锁；SSE 用 `reply.hijack()` + `reply.raw` 手写帧。
- node:sqlite（Node 25 内置）做派生索引零原生依赖；`forceCloseConnections: true` 让 app.close() 不被 keep-alive 拖住。
- 人工 gate 桥接：执行器先落 `gate.waiting` 事件再调 `HumanGate.ask` —— ask 时扫事件流即得当前审批定位键；重启后无在途执行器时决策进暂存 Map，恢复执行时消费。
- 审批幂等定位：`approval_id = base64url(node_id/gate_id)`，审批无独立事实存储，全部从事件流投影。

## 实现校准（2026-10-06，快照与自定义 artifact）

- `readSnapshot` 原先只读取 `prd.md`、`plan.md`、`adr.md`、`findings.md`；自定义 SDLC 的上游 artifact 会被上下文包遗漏。
- `settleArtifact` 原先直接 `join(session.dir, node.artifact)`；workflow 定义可携带 `../` 或绝对路径，存在越出 session 目录的写入风险。
- coordinator 派发事件只有 prompt 摘要，没有记录本次上下文基线；加入 snapshot 指纹和事件序号后，可审计 worker 使用的最新快照来源，恢复仍按事件流重新采集。

## 实现校准（2026-10-06，工作区独立 agent 配置）

- `registerAgentsYaml` 把自定义 args 写进 headless 的全局 Map；`HeadlessDriver.buildArgv` 每次重新查 Map，同名条目会污染其他工作区或已构造的 driver。
- `parseAgentsYaml` 对所有条目整体校验，单条 schema 错误会阻断整个文件，与逐条降级的文档承诺不符。
- `loadAgentsFile` 捕获全部读取异常并视为文件不存在，权限/IO 故障会静默失去自定义配置。
- server 启动时只加载一次 `agents.yaml`，缺少清单与重载入口；计划增加配置快照，让在途 run 固定其 resolver，后续 run 使用新配置。

## 实现校准（2026-10-06，协调快照一致性）

- `session.readLedger` 仅读磁盘投影，coordinator 在 run 尚未结束时可能看不到最近的 ledger 事件；直接调用纯 reducer 处理本次 readOrdered 返回的事件，可避免副本滞后且不写投影文件。
- `readSnapshot` 没有 workflow 过滤，同名节点的历史退出会进入当前流程的上下文。
- 快照准备和 artifact 写回位于 coordinator 的 driver try/catch 之外，会出现 started 后没有 completed 的异常；驱动解析失败也会被外层 retry 循环重复执行，与文档不符。
- 目录词法校验不能发现符号链接，固定 `${file}.tmp` 也可指向外部文件；artifact 可命名为 events.jsonl/ledger.yaml，必须在派发前拒绝。

## 实现校准（2026-10-06，最新门禁与产物证据）

- `ledger-has-confirmed` 仍调用 `session.readLedger()`，默认目录路径也只读 ledger.yaml；已推翻的条目可能因投影滞后继续放行。
- checker 只过滤 confirmed，不过滤 conflict；当前 reducer 已支持冲突标记，门禁尚未消费。
- `settleArtifact` 把任何已有非空文档记作当前 agent 自写，返回的新文本也不会更新旧内容；需比较派发快照中的完整内容 hash。
- 产物代写已使用原子临时文件，但尚未在替换前检查目标是否发生变化；可增加预期内容 hash，观测到冲突后保留现状并失败，跨进程强互斥仍需后续 lease。

## 实现校准（2026-10-06，恢复与审批版本）

- executor 的 agentDone 只记录历史 ok，无法判断 PRD、账本、工作流定义或产物在中断期间是否变化。
- resumed node.entered 会清除完成标记，使连续两次审批中断恢复可能无理由重复执行 worker。
- runGate 的 pending 分支绕过 checker；人工等待返回后也不重读证据，已推翻共识可能被旧选择放行。
- approval_id 与 decided 暂存只绑定 node/gate，worker 因新输入重跑后，旧审批选择可能被新 gate 消费；需要等待事件版本绑定。

## 实现校准（2026-10-06，Agent 配置身份与控制台）

- 当前 execution_input_hash 覆盖 workflow 与需求输入，但不含命名 agent 的 model/effort/角色/启动参数。同别名配置改变后的重启可能复用旧结果。
- `AgentService` 已提供公开清单和重载 API，console 没有入口，也未在 typed client 暴露这两个命令。
- 有效配置指纹应从 driver 实际启动参数派生，而非 YAML 原文或进程 revision；忽略的旋钮、空格/字段顺序不应改变身份，凭据值与 env 不参与指纹。
- 控制台沿用现有设计，用来源/协议筛选和紧凑列表呈现公开配置；失败重载保持当前清单，成功后显示 server 返回的配置版本。

## 实现校准（2026-10-07，Context Session Agent 缺口）

- `createNodeRunner` 已实现“单节点任务”协调：最新快照 → 两层上下文包 → driver → artifact 写回；但它被 workflow executor 私有调用，不能为人工复核、重规划或 API preview 提供独立的 session 协调轮次。
- 现有事件类型只有 `agent.task.started/completed`，直接复用会把“协调提议”误记成 worker 任务；新增 session-level 事实需要独立事件类型和 ADR，且 payload 必须只保存摘要/hash，不保存完整上下文包。
- Context Session Agent 应使用固定的 `AgentDriver` resolver 快照，输入只来自同一批 `readSnapshot` 结果；结构化输出解析失败必须 fail-closed 并落 completed/failed 事实，不能把模型自由文本当作可执行路由。
- 独立协调包与 worker 包的消费不同：前者必须保留完整 workflow/输出 schema 并硬限制总字符数，文档只作为片段；复用 readSnapshot，使用独立 buildCoordinationPrompt，避免继承 worker 的 artifact 写入指令。
- 已验证输出期间 PRD、账本、进度或人工等待变化会 stale；自身控制事件不改变语义输入 hash。轮次只能给 Draft 建议，来源验证不能证明推理正确性。

## 实现校准（2026-10-07，协调工作台与采用边界）

- 轮次 requested 保存的是 registry 别名，started/completed 保存的是 driver 实际名（如 headless:coordinator）；采用时必须保留并使用原别名，不能用实际名重新解析自定义配置。
- 既有轮次 status=ok 只表示完成时通过验证，文档之后变更不会改变历史事件；console 需要独立的 server 新鲜度投影，不能把旧 ok 当作可采用。
- 当前 executor 按固定拓扑顺序推进全部未退出节点，不能让 advance 的任意 ready 节点暗示能跳转。采用入口只接受真实下一节点，命令明确为启动绑定 SDLC。
- RunService.start 在首个 await 前预留在途槽位；采用校验必须发生在该槽位内，采用事实落盘成功后才能 launch，避免普通 run 与采用并发绕过边界。
- 采用事实也需要消费侧核验：合法 payload schema 不能证明它引用了正确的 workflow/node/input；若同轮出现两个 run 绑定，投影必须拒绝而不是选择最后一条。
- React 生命周期不能因采用后 timeline 绑定版本变化而重置未完成命令；刷新默认选择与组件挂载生命周期应独立，异步回执按 generation 丢弃过期更新。
- completed 事件可见与后台槽位释放是两个时刻；终态 API 等待后台清理后返回，连续协调无需固定延迟。
- run 登记先于 adopted 事件时，需要持久化 coordination_round_id 并在恢复时核验，否则崩溃窗口会绕过“事实落盘后才派发”；旧 SQLite 表新增可空列保留普通 run 的恢复行为。
- 浏览器已验证真实操作链保留人工 gate，491 个离线测试证明输入/配置变化、归档、并发、事件故障与恢复边界；尚未用外部真实 LLM 做本阶段验收，预览为离线 fake driver。
