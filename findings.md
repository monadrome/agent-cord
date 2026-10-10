# 调研发现

## 阶段62（2026-10-10）：活动等待查询一致性

- 人工gate promise未返回时run登记仍running，需求事件投影已waiting_human；getRun/列表/协调读取索引而漏掉事实。
- 等待事实早于ask回调可读，单纯ask时更新索引存在窗口。活动查询需同批事件派生等待，而不写终态/finished_at或放开lease。
- 人工决定落盘只意味着输入已给出，仍须gate重检；状态可恢复running，但不能据此推断审批通过或节点退出。历史/终态不能因当前同版本等待改变。
- 异步状态读取期间取消需要重读操作登记，避免以读取前running副本返回；多个waiting逐项验证，不能因some提前返回而掩盖另一个坏结构。
- 同步listRuns继续给恢复/维护；REST与dashboard用异步readRuns，共享每需求严格事件读取。此项修正不重构inactive历史或完整run终态算法。

## 阶段 61（2026-10-10）：ACP 启动状态漂移

- set_config_option 要返回完整配置，config_option_update 可动态修改选项；现有驱动只验证设置响应，忽略更新，所以后续模型/effort/mode 漂移仍可成功。
- ACP 文档明确 category 仅 UX，新 configOptions 优先于旧 modes；需明确 option_ids.mode 支持纯 config-only agent，不猜 category。旧 set_mode 成功回执为空，没有必需 currentModeId，不要求虚构通知。
- 配置后的模式更新可重置模型或替换选项，不能用 new/load 原始列表验证后续请求；当前 session 新状态必须共同核验。只有明确启动选择需要冻结，未选择默认值仍由 agent 自适应。
- 新 mode 可能解锁原 plan 列表没有的模型，不能先用初始列表验证全部选项；必须 mode 后逐步验证。扩展键序应排序，保证同一canonical配置身份对应相同实际设置顺序。
- SDK异步通知可能晚于prompt请求发出才被观察，正确保证是立即取消并拒绝成功交付，不是回滚副作用或声称没有模型消耗。在途权限裁决也需在返回允许前重查是否已收束。
- 实时run登记可仍为running而需求事件投影已waiting_human；验收应以审批/ready事实与需求投影核对，冷恢复再核验run登记，不用固定延迟等待一个不会自动变化的索引值。

## 阶段 60（2026-10-10）：能力查询消费缺口

- Agent 页尚未展示 capabilities/inspect，注册清单的绿色 Check 会误导为安装/协议验证已通过。
- inspect 捕获固定 revision/hash，但查询期间重载仍返回成功；需要 server 返回时的新鲜度信号，并保留旧配置身份。
- 幂等缓存会重放历史 current=true；消费方需结合最新清单核对 revision/hash。刷新失败不能以旧清单证明最新，查询失败保留历史但不能冒称此次查询成功。
- 窄屏表格单纯横滚会隐藏 model/effort 候选，改为每个选项纵向列出 ID/类型/类别/候选；长模式/候选列表限制高度，省略数在滚动区外可见。
- 浏览器重跑需要每轮独立幂等键；复用 reload 的静态 key 会正确重放历史结果，不能用它测试新配置的重载。已用随机 run key 校正验收脚本。

## 实现校准（2026-10-09，usage 来源与部分计量）

- 原 unknown_tasks 只识别全缺失，有 input token 却没有 cost 的 task 可绕过 cost 上限；每个受限指标都需验证完整性。
- started 无 completed 的冷恢复窗口可能已有外部消耗，不能以零或重置预算继续；ready 必须重算任务事实而非信 payload。
- 原 candidate-only 伪造测试没有改变共享解析真正读取的事件，需改 events 并提供合法成功对照。

## 实现校准（2026-10-09，自动协调重试）

- 自动升级轮次失败/timeout/stale 后，原 round 已保存 Goal 来源，但控制台只有“重新协调”入口；普通 start 可能换 agent/版本，无法表达“重试同一 blocker”。
- retry 必须只允许终态自动 round，验证最新 failed run 和 blocked event；已有同 blocker 的 pending/running/ok 轮次禁止重复。重试只调用 supervisor，人工答复/Goal retry 仍是独立命令。

## 实现校准（2026-10-09，Goal 验收覆盖）

- checks 全绿只能证明命令结果；review 三章节非空没有逐项验收条件/证据关联。宿主需生成验收矩阵，不能信 worker 自报全覆盖。
- 可选发布 acceptance 映射到 check ID，拒绝未知/遗漏/重复，宿主 ready 保存实际 verification ID；共享 readiness 解析继续约束恢复与协调。
- 工程基线和业务条件须区分；映射与真实通过并不证明测试逻辑充分或 PRD 全部语义已声明，人审仍必需。

## 实现校准（2026-10-09，原 Goal 恢复操作）

- 配置身份漂移会把原授权 run 登记为 failed；恢复原配置后只有内部 RunService.recover 能恢复。公开 retry-goal 幂等返回原 run，普通 start 授予新 run，用户没有保留原预算的操作入口。
- 恢复命令需固定配置/当前输入 token、持久请求先于派发和原次数/截止时间投影；当前有效 ready 可恢复原人工等待，blocked 或耗尽时不能借恢复重新计时。

## 实现校准（2026-10-09，Goal 续跑授权身份）

- 人工授权应约束实际执行的配置；live resolver 多次检查无法约束单独捕获的派发配置。A/B/A 真子进程回归证明校验 A、执行 B。
- 授权保存 worker/supervisor/节点输入 hash；固定快照贯穿校验与派发，冷恢复核验身份，首次 worker 派发前核验原输入。
- 配置漂移失败后允许显式恢复原 run；相同配置与仍有效的交付不重复调用、不重建预算。旧授权仅可从合法任务来源归因，缺来源必须拒绝。

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

## 实现校准（2026-10-07，SDLC 执行版本隔离）

- executor.scan、readSnapshot、RunService.computeFinalStatus 和 SessionService 的进度投影都只按 workflow_id 过滤；新发布版本可被旧 node.exited 直接跳过，任务输入 hash 无机会验证。
- scanPendingApprovals 的键没有发布版本，旧等待可覆盖新等待，旧版本取消也可能删除新版本审批。
- 已有 SDLC 绑定只在 SQLite run 登记；需要把启动绑定作为事件事实保存，索引删除后才能确定当前发布版本，而非回退默认 SDLC。
- 版本隔离不能使用 run_id：同版本重新 start 必须继续恢复；也不能只 hash 定义：相同定义的不同发布版本/发布名称仍是不同执行版本。
- 首轮 7 个真实反例全部复现；完整版本绑定后同版本恢复保持 worker/审批 ID，跨版本重新派发，旧取消不删除新等待。
- 当前版本必须按 started 事实的因果顺序读取，不能靠 SQLite started_at 排序；部分索引重建可能晚插入旧 run，墙钟也不能证明当前绑定。
- 启动绑定/任务/审批/协调全部使用执行版本后，510 个离线测试与真实 HTTP/浏览器均通过；索引删除后恢复新尝试仍沿用同版本进度，旧 run 记录保持历史，验收应核验当前 run 而非假定恢复始终保留 run_id。

## 实现校准（2026-10-07，统一 REST 幂等边界）

- 当前幂等缓存只在 onSend 保存成功响应，preHandler 到业务之间没有共享占位；同键并发创建/发布/审批可能多次进入业务逻辑。
- cache 仅检查 method/path，未绑定 body；同路由修改输入会返回旧结果，看起来已保存新内容但实际未执行。
- agents/reload 和 coordination 创建有两份局部 Promise 映射，其它写入口没有；需要共享同一入口并删除重复实现。
- 响应缓存不能覆盖副作用已发生、响应尚未持久化的崩溃窗口；先持久化 pending 才能在重启后明确拒绝未知请求的盲目重放。
- 请求身份必须保留所有合法 JSON 自有字段，含 __proto__；使用标准 JSON replacer + Object.fromEntries 排序，再由现有纯 hash API 计算。历史事件的 canonical 协议不改变。
- 业务后的 5xx 或缓存故障不能证明无副作用，pending 必须保留；占位写入回执丢失也使用同一规则，重启不会自动重新执行。
- 537 个离线用例、实际 HTTP 五并发关键入口与重启验证均通过；所有声明 idempotency 的命令共用同一生命周期，原协调/版本/审批闭环未回退。流式写响应无法作为可缓存结果，明确未确认而不悬挂等待者。

## 实现校准（2026-10-07，文档与文件证据边界）

- file-exists 用 stat、另外两个 checker 用 readFile，词法合法的路径仍会跟随文件/父目录符号链接，硬链接和管理路径也可作为放行证据。
- SessionService.readDoc 捕获所有错误并返回 404，console 将其解释为未生成文档；writeDoc 使用直接 writeFile，既跟随链接又可能截断旧文档后写失败。
- 协调器已有独立普通文件检查/no-follow/原子临时文件写回，适合提升为核心共享 helper；保留旧 coordinator 导入路径，避免破坏已有 worker 行为。
- 本机可执行 claude/codex/kimi 已安装；尚未证明真实模型凭据可用，后续只在隔离临时工作区做有界协调验证，不读取或记录凭据。
- 真实 Codex 协调验证发现 parser 将非终态 item.error 的弃用配置通知作为正文；模型实际返回合法 JSON，但被污染后 fail-closed。新增 ADR-0037 结构化 metadata 映射、流级 session ID 和当前 approval_policy 参数修复。
- 修复后两轮真实调用成功，VERSION_A/B 的提议反映最新 PRD，输入/快照/会话 ID 均不同，旧轮次 current=false，文档不变。真实验证只证明本机该 CLI/模型组合可跑，不证明所有 provider 或统计质量。
- workspace doctor 的 merge driver 检查不同于 session doctor，临时 git 仓库仍需注册本地 merge driver；完成该初始化后 HTTP/浏览器验收与 workspace doctor 全通过。
- 读错误后的 UI 不能解锁编辑或显示“已与磁盘一致”，真实 404 才进入新文档状态；浏览器已验证错误、缺失、保存与恢复，控制台仍只展示 server 投影。

## 设计校准（2026-10-09，默认 Goal 交付）

- 用户要求把“自主完成代码、自测与 human review 指南，happy path 无中途人工干预”纳入核心 feature。该原则与 Draft-only、最终人工控制和默认轻量升级兼容。
- ACP 是通信协议；当前一次 session/prompt、driver 成功退出和 agent.task.completed=ok 都不能证明目标达成。默认 Goal 语义应归宿主执行层并覆盖 ACP/headless。
- 当前 coordinator 的 run.retry 只对失败任务退避重试；尚无围绕机器验证失败的实现修复循环，也无完整交付包审计。
- 执行者运行自测与独立验证并不冲突：测试是外部行为信号，完成判定需要宿主核验实际结果和当前输入/产物身份，模型自述不是通过证据。
- 普通可修复错误应自行处理；必要事实缺失、权限越界、外部依赖不可恢复、预算耗尽或持续无进展才进入人工关注。最终 review 单独度量。

## 实现校准（2026-10-09，Goal 节点原型）

- 将 Goal 闭环置于未退出的 NodeRunner 内即可修复验证失败，不需要修改 DAG 退出语义。agent.task.completed 继续描述 worker，goal.attempt.completed 描述交付状态，二者不能混用。
- 代码变化是 worker 的正常输出；只读 worker 前后源码不变规则不能套在 Goal 实现者身上。宿主在 worker 完成后采集被测身份，检查期间重检，指南补证据时仅允许自己的输出变化。
- 同 run 最新 ready 必须引用当前宿主验证事实及最终指南；新事实替换、代码变化和报告变化均拒绝复用。存储追加失败上抛，冷恢复消费已开始的尝试，不能假装从未执行。
- 首轮浏览器发现磁盘上的自定义 review.md 不可见，说明代码自测通过仍不足以证明交付流程可用；server 声明产物只读入口补齐后才完成 reviewer 的访问路径。
- 真实 Codex 的微型目标一次就绪，实际宿主 3 用例通过、人工决定 0；这只证明接入与当前样本，复杂目标成功率、权限统一、独立监督和卡点答复仍待继续验证与实现。

## 实现校准（2026-10-09，自动卡点升级）

- blocked 已是事件事实，自动协调请求应先持久化且绑定来源；仅内存去重无法抵挡重启重复付费调用。缺请求的冷恢复可补齐，已有请求的失败/取消/超时不重放。
- 升级等待已有人工协调时必须携带关闭取消信号，否则 runs.close 与 coordination.close 顺序会相互等待；真实服务关闭回归已覆盖。
- 自动解释的目标必须进入协调 input hash，输出只允许 ask_human/wait 且引用原 blocker；这使查询/答复保持同一来源身份，输入变化后不会继续使用旧问题。
- 一次真实 Codex supervisor 自主生成有限问题，人工答复/决定 0、原 run failed，重启同 round 不重调用。完整人工授权与答复后的续跑仍需后续契约，不能把记录澄清冒称目标完成。

## 实现校准（2026-10-09，ACP 文件预授权）

- Goal 持续执行不意味着其 driver 已有工具授权；YAML 需声明宿主可核验的权限范围，否则普通请求仍会被默认取消。read/edit 的 kind/absolute locations 可从 v1 协议读取，execute 不具统一 argv 契约，本轮拒绝猜测。
- allow_once 只授权当前全部位置匹配的请求，链接/硬链接/事实管理路径与 IO 不可判断继续取消。权限 error 不能按网络错误重试，后续普通错误也不能覆盖这个边界。
- 路径策略改变执行能力，必须进配置身份；公开数量足够查看配置，授权路径与环境原文不进入清单。重载保持旧 resolver，冷恢复重新核验旧审批。
- 真 ACP fixture 证明 read/edit 权限往返、拒绝后修正与完整 Goal 交付路径；不证明所有 CLI 都有足够位置元信息或对恶意 agent 的安全性，OS 隔离与跨 driver 执行权限仍待完善。

## 实现校准（2026-10-09，Goal 当前就绪来源）

- 同一历史 ready 在 runner 与协调端不能有两种证据解释；共享 worker/宿主检查来源，当前 input/source/guide 另做 IO 核验，坏的最新事实不回退旧成功。
- Goal 指南由宿主补证据后 hash 改变，worker 原产物证据与最终 ready 输出应分别核验，不能强制两份 hash 相等。验证必须在 worker 之后且 ready 之前，未知退出码不能补成零。
- 协调 status=ready 不等于 current=true；过期、不可读和取消需显式新鲜度，模型只能引用当前有效 ready。原 blocked 则是执行阻塞事实，不能因输入变化而无授权解锁。
- 冷恢复的 active 槽位变化会使旧协调提议失效，不能据此认定 Goal 证据失效；真实 HTTP 验收分别证明有效交付复用与新轮次采集，没有重复 worker 或伪造人审。

## 实现校准（2026-10-09，agent 上下文版本）

- env 中既有凭据也有角色/路由行为，全部排除保护隐私，但外部行为变化没有显式身份声明。
- 可选正整数版本可进入配置 hash 而不传给 CLI/公开环境；未声明兼容，声明由用户维护，不能冒称自动发现。
- 11 个反例先失败，873 项全量通过；实际子进程旧 resolver 角色不变、新角色版本生效，冷恢复重跑、旧提议失效且新轮次恢复，公开数据无环境值。
- 同 argv 的真实 HTTP 角色 A→B 报告恢复后保持人工待审，重启不重复 worker；数字清单在 1440/390/320 浏览器及截图无溢出/重叠。

## 实现校准（2026-10-09，澄清撤回）

- 错误答复缺乏人工明确撤回；过滤撤回记录会回退旧同题选择，清空材料会恢复旧输入身份。
- 当前状态需保留 choice=null/status=revoked 的来源墓碑，旧记录保持只读，修正由新有效轮次完成；撤回不改变 gate 决策或文件产物。
- 7 个反例先失败，858 项全量通过；撤回不复活旧身份/选择、原生 worker 旧 checkpoint 失效，只有最新同题有效答复能撤回，输入变化不妨碍修正历史选择。
- 真实 Claude 一次调用收到未确定状态而没有旧选择标记，明确 wait 并引用撤回；HTTP/UI 失败保留/禁用/一次写入/重启/来源导航与手机桌面截图通过，人工 gate 未决。

## 实现校准（2026-10-09，协调人工澄清）

- ask_human 当前只展示问题与选项，用户回答无写入口，最新快照也没有澄清事实；需求澄清必须与 gate 决策分开。
- 答复应绑定合法问题完成与输入身份，仅当前有效时记录，恢复不重放模型；同批快照需同时供协调、worker 与审批使用。
- UI 沿用原生单选与明确记录动作，状态由 server 投影，不能在前端生成事件或放行 gate。
- 14 个反例先复现；收尾替代完成反例发现 409 后仍有非法事实，追加前重新核验原问题/选项后修复。最终 846 项全绿，包含坏来源/容量/并发/写失败/冷恢复/worker 与审批输入、在途 stale。
- 隔离 HTTP/浏览器一次答复、重试保留选择、记录中禁用、改选/过期拒绝与 1440/390/320 来源导航通过；真实 Claude 一次无工具调用从最新澄清引用答复事件，人工 gate 仍独立，截图无重叠。

## 实现校准（2026-10-08，worker 首尾上下文与预算）

- 独立协调已有首尾/均衡预算，但原生 worker 仍只收到长文档前缀，最新尾部变化的重跑不能改善实际可见输入。
- buildContextPack 的预算只是整块上游裁剪；固定账本/任务/PRD及返回后追加的源码/重试元信息均可能突破预算。
- 优先复用既有确定性文档选择，把最终派发字符串纳入预算，并绑定新策略到 checkpoint；不改变通用快照默认行为或已退出进度。
- 10 个反例先复现，完整 818 项测试通过；源码/重试附记计入预算，错误不派发或节点内重试，旧完整 checkpoint 重跑后可正常恢复。
- 真实 HTTP 从任务预算拒绝到更新 B 后恢复，Claude 只调用一次、prompt=59970，三份文档的最新尾部正确进入报告；重启保持报告/审批且人工未决，浏览器桌面/手机展示与截图通过。

## 实现校准（2026-10-08，独立协调工具边界）

- ADR-0032/prompt 禁止工具，session-agent 消费循环却忽略 tool_use；只读 driver 仍可读取快照之外的信息并返回成功提议。
- ACP/headless 已统一报告工具事件，宿主可在此中止并拒绝结果；检测不保证通知之前没有副作用，也不发现隐瞒的外部操作。
- 策略身份必须改变，否则旧域的无工具保证未经核验的提议仍可能被采用。普通 worker 的工具通道不在此次修改范围。
- 11 个核心/REST 反例先复现，额外 ACP driver 反例揭示取消发送竞态；取消序列单次启动并在早退清理时有界等待，真实静默 ACP 收到一次 cancel 后退出。
- 最终 807 项全绿，实际 headless/ACP 违规不可采用且进程回收；真实 Claude 一次调用无工具、使用最新 B 快照、重启后同输入有效，人工 gate 保持待审。
- 1440/390/320 浏览器验证失败详情无提议/采用、固定错误展示与来源导航，截图无重叠；这是检测结果拒绝，不是外部 agent 的 OS 沙箱。

## 实现校准（2026-10-08，跨 run 复用来源）

- 新 run 复用有效任务却没有新的完成事实，当前执行观察会为 missing；3 个反例先复现，输入变化重跑对照通过。
- reused 事实连接当前 run 和原完成，恢复按原完成 ID 去重；原完成/调用元信息、scope/correlation/顺序/覆盖关系严格校验，坏最新复用不能回退旧成功或被去重误认。
- 原复用输入/源码/产物校验保留，追加失败不进入 gate。任务观察有 reused/原完成 ID，hook 输入允许旧字段缺省，协调执行域升级 v6。
- 实际两个 run 的 worker 总调用 1 次、started/completed/reused 各 1 条，Claude 两轮正确区分原完成与复用并引用当前事件，报告/PRD 不变、无人工决定/退出/采用、doctor=true。
- 最终 790 测试 / 62 文件与构建通过，Playwright/Chrome 1440/390/320 两步来源导航、tooltip/容器边界通过，截图无重叠；原真实 Draft 仍待审。
- 交接审查补查：原完成的重试编号超过上限时，直接观察拒绝，但原引用与 checkpoint 仍可接受；三项反例复现后补齐两处校验，最终 793 项全绿，拒绝异常完成并允许重跑后的合法事实复用。

## 实现校准（2026-10-08，协调执行观察）

- 独立协调没有 run/worker 状态，任务失败而文档/进度不变时提议仍可用；9 个核心反例先全部复现。
- worker run_id provenance、受限任务/运行 schema、同批严格投影与 read_execution_context 已贯通。当前 run 活动时禁止 advance/complete；started 不证明 PID 存活，任务 ok 不等于验证/gate 通过。
- 执行观察进入 v5 输入身份和完成/查询/采用重检，event_id 变化也会失效；坏最新记录不回退旧成功，旧无 run_id 不猜测归属，模型只可引用合法当前任务事件。
- 全量 765 测试 / 61 文件、build/typecheck/diff 通过。真实 fixture 失败→修复产 Draft 停人工 gate，真实 Claude 两轮如实引用 failed/ok 最新任务与 active=false/true，无工具调用、人工决定/退出/采用，doctor=true。
- 冷启动第三次真实 Claude 引用同一 ok 任务但 active=false，无 worker 重放，新轮次 current=true。Playwright/Chrome 1440/390/320 来源定位/展开通过，无溢出/pageerror，截图无重叠；原真实 Draft 仍为审批 1、人工决定 0、done 未退出。

## 实现校准（2026-10-08，快照事件完整性）

- readSnapshot 的普通事件读取会跳过坏行且接受外部 session；未声明机器验证时旧提议也会继续可采用。10 个新反例先全部复现。
- ADR-0047 后新增可选 readOrderedStrict 和共享 readSessionEvents：原生严格读取验证当前行/envelope/session，自定义旧端口验证返回事实与可用诊断。快照、验证和协调创建/查询/采用共用该边界，普通诊断浏览保留。
- 冷恢复按需求隔离损坏读取，坏未完成轮次原事实保持不变，健康需求仍可协调；修复重启才落 interrupted，不重放调用。原生已打开句柄的当前读取修复后可恢复，不被历史诊断锁死。
- 明确取消遇到读取/写入失败仍收束当前匹配进程，接口继续报告原错误、不伪造取消请求；真实 fixture 子进程 PID 回收和修复后的 cancelled 终态读取已通过。
- 全量 735 测试 / 59 文件和 build:all 通过。实际 HTTP 验收 driver 总调用 5 次、被拒绝操作零额外调用，同键修复与冷恢复全通过，doctor=true；原真实 Draft 实时人工待审不变。

## 实现校准（2026-10-08，独立协调上下文覆盖）

- 长文档完整 hash 改变不代表模型看到了变化内容：默认前 20000 字符和按序总预算会丢失末尾要求、挤掉后续报告。4 个核心/ACP 反例先全部复现。
- readCoordinationSnapshot 保留首尾，剩余预算均衡分配并回流短文档额度；片段索引记录 UTF-16 原文范围、纳入数与省略数。模型完成/查询/采用共用策略，input v4 使旧策略提议失效。
- 100 项定向与全量 713 测试 / 57 文件通过，build:all/typecheck 通过；含原文范围还原、Unicode、非法预算、在途尾部变更恢复、ACP 重启/新会话和旧轮次迁移。
- 真实 Claude 两轮均 ok/current，summary 准确引用长 PRD、findings、自定义报告的三个 A/B 尾部标记，prompt=59950 字符。重启不变仍 current，更新使旧轮次失效；会话不同、无工具调用、无工作流副作用、doctor=true。原真实 Draft 实时核验仍人工未决。

## 实现校准（2026-10-08，验证证据一致性）

- checker 与协调观察对结果契约有漂移：passed/非零退出码、坏摘要、坏最新 correlation、损坏行、外部 session 与取消事实均有放行风险；新增反例先复现 13 个失败。
- 已引入共享结果 schema、严格事件读取/最新结果解析和取消判定，REST 在追加前拒绝矛盾结果；显式未知退出码不补造为 0。
- 首轮全量 701 项中 700 通过，非法源码链接恢复失败。代码定位到 gate.waiting 后 ask 的重检异常会把已有等待置为 failed；将该测试改成等待事实落盘后、ask 前修改源码，确定性复现后修复。
- 修复后 96 项定向与全量 701 测试 / 56 文件通过，build:all 通过。只保留 VerificationInputError 的已挂起等待，其他异常继续上抛；无法读取时 409，不写验证/人工决定/节点退出，修复后恢复原 run。
- 真实宿主 node --test 退出码 1→0：矛盾 passed 返回 400 且零写入，同键 failed 可提交并跨重启保留，修复后 passed 停在人工终审，doctor=true。原真实 Draft 实时 HTTP 显示一个审批、零人工决定、done 未退出。

## 实现校准（2026-10-08，协调机器验证上下文）

- 独立协调只有 docs/ledger/progress/source_hash，未观察 verification.completed；机器结果单独更新不改变输入，模型无法区分未验证与当前失败。
- 宿主按流程声明的 node/verification ID 投影当前 run 的最新事实，共用 readNodeInput 判断新鲜度；缺失、坏结果、旧 scope/run、源码变化、取消和读故障不能成为当前有效结果。
- 严格观察最多 128 项，只保存身份、状态、摘要和原因枚举，不携带 summary 或测试日志。核心检查结构与声明，prompt/input v3、完成/查询/采用重检使用同一观察，轮次只落 verification_context_hash。
- 当前失败结果可以引用 verification/event_id 如实提出 wait 或 ask_human；过期/缺失不能引用。控制台来源链接打开并展开对应结果事件，不改变人工 gate。
- 定向核心/server 88 用例通过，另补仅证据 event_id 替换导致采用 guard 409 的回归，保留无观察时 v1/v2 兼容。

## 实现校准（2026-10-08，协调提议源码新鲜度）

- 独立协调仍用文档/流程身份，源码变化没有改变 current/adoptable。5 个核心与 6 个 REST 反例先全部复现，在途代码变化仍返回 ok，采用 guard 也没有阻断。
- server 复用声明范围扫描，对绑定流程各节点验证 inputs 取并集；协调器由宿主摘要钩子记录 source_hash，绑定时 input_hash 使用 v2（无绑定保持 v1）。完成、查询与采用在同一范围重检。
- 源码不可读时失败或不可采用；范围恢复后可以核验旧提议。中断恢复保留 source_hash，不重放调用；源码正文不进入 prompt 或轮次事件。

## 实现校准（2026-10-08，只读 worker 源码新鲜度）

- 机器 gate 的源码 hash 已生效，但执行 checkpoint 仍只依赖文档和配置。源码变化后可能沿用旧评审报告。
- 7 个核心反例中 6 个复现：源码变化仍复用、在途变化仍代写、摘要非法/不可读仍派发、绑定源码后旧任务仍复用。
- 宿主提供 read_source_hash，纯执行身份在绑定时使用 v3，started/completed 记录摘要。恢复与写回前重检覆盖同一范围；无绑定仍是 v2，可写节点不读只读摘要钩子。
- 真实子进程 fixture 验证相同源码重启不重复、代码变化重启重新评审、在途变化阻断报告写回和新输入恢复；没有增加模型调用或消费真实人工 gate。
- 完整回归暴露 Fastify 关闭不收束 runner，关闭期间仍可能登记旧实例的失败；关闭等待/worker PID 回收测试先复现。onClose 现在 abort 并等待 runner 结束，保留原 run 与等待事实，不写用户取消或人工决定。全量 634 测试通过。

## 实现校准（2026-10-08，验证源码输入身份）

- 当前 readApprovalContextHash 不覆盖源码；四个 REST 反例先证明代码改动/增删不改变验证 hash，重启后旧人工选择仍可放行。
- verification-passed 可声明 inputs；节点全部验证范围取并集，目录清单与文件字节/type/mode 形成 source_hash，统一提交、gate、人审和恢复身份，不把正文放进事件。
- 扫描用 no-follow 文件描述符流式计算字节 hash，限制条目、深度、单文件及总大小；读取前后元信息和结束时目录清单重检。该便携校验不是跨进程原子文件树事务。
- 实际独立 clone 的 13 测试通过，新增源码后提交旧 hash 为 409；恢复文件集合后原 hash 可用，原 run 进入人工终审且再次重启审批不变。
- 重启时声明源码缺失曾阻断 buildApp；局部 VerificationInputError 改为该 run 保持等待、REST 409，修复输入并重验后恢复，健康服务持续可用。

## 实现校准（2026-10-08，验证等待与恢复时序）

- 阶段 25 只验证结果先落盘再重启；重启之后才收到 CI 结果时没有挂起 Promise，旧 recheck 返回 false，run 永久等待。
- 按 run_id 无条件唤醒会刷新无关审批；gate.waiting 已落盘但 ask 尚未登记的窗口会丢失唤醒。
- 任何历史验证都触发 recovery 会重新启动已消费机器结果的人工终审；审批通过 start 创建新 run 则使原 run 的机器证据失效。
- 三个新增 REST 反例先全部复现。按引用 ID 重检、串行恢复原 run、挂起后持久化证据重检，以及比较 evaluation_hash 后再恢复，修复了这些时序。
- 独立 clone 的真实宿主命令通过 HTTP 写入状态和输出 hash；server 先重启再收到结果，仍恢复同一 run，机器通过后停在人工 gate，再次重启保留审批 ID，无人工决定，doctor=true。

## 实现校准（2026-10-07，只读 worker 报告通道）

- settleArtifact 在 readonly 时立即返回 none，worker 即使返回完整 findings 也不能写报告文件；报告 gate 只能看到旧文件/占位，阻断独立评审接入。
- 当前恢复把 readonly artifact 视为输入，新增加宿主写报告模式时必须把本节点产物从语义输入排除，并继续校验完成后文件 hash，否则自己写的报告会令 checkpoint 自动失效。
- 需要显式 output=text 区分“只读分析旧文档”和“只读 worker 产报告”，不能改所有旧 readonly 节点的语义。
- 真实开发 Draft 在独立clone完成48组输入/57个测试，宿主完整615通过；初次worker超时，更新恢复附记后仅重跑未退出实现节点，随后生成readonly文本评审报告并停在人工gate，未提交/合入。
- 实际 file_change 事件必须是工具语义，不能污染文本fallback；已补ADR-0039与结构化回归。
- readonly sandbox 不允许 Vitest 的 SSR临时目录写入，独立评审如实报告未完成自身测试；host测试通过不能被模型冒称为自身结果，报告生成ok与验证结论是两个维度。

## 实现校准（2026-10-09，协调重试收尾）

- 最终 round 重试必须有 server 当前 token；父 round、完成事件、配置 hash 和 blocker 是同一输入的一部分，不能只允许 `goal_blocked` 开关绕过来源校验。
- 首版重试遗漏 `stale` 和父来源，已补齐最新轮次、三字段 token、human actor、fixed resolver、request/dispatch 双重重检、冷中断和单子请求。
- 最终覆盖 request fsync/后续中断、记录前输入/配置变化、父子伪造、旧 token、并发重放、超时/取消/归档/答复、冷恢复和最终 Goal 授权；坏来源只隔离对应需求。

## 调研校准（2026-10-09，跨 driver 只读工具审计）

- Claude Agent SDK 的 `PreToolUse` hook 可在工具执行前 deny/modify，OpenAI Agents SDK 将 input/output guardrail 作为独立验证层；这些能力是厂商特性，不能直接假设所有 headless/ACP 都提供同样拦截点。
- 当前 `AgentDriver` 已统一归一化 `tool_use`，但 coordinator 对可写/只读节点没有跨 driver 的工具事实审计；`readonly=true` 主要依赖 CLI 参数，未知自定义 wrapper 可能仍执行工具。
- 新策略只在宿主能判断时放行：明确读工具和无副作用的 argv 命令允许，写工具、未知工具、缺少命令输入或含 shell 控制语法均拒绝。违规落现有 `agent.task.completed` driver failure，`retryable=false`，不自动反复尝试。
- 该策略是 fail-closed 审计，不是执行前拦截或 OS 沙箱；ACP permission policy、Codex read-only sandbox 和最终源码/产物验证仍是独立边界。

## 实现校准（2026-10-09，workspace lease）

- `RunService` 原来只按 `req_id` 限制在途 run；同一 server root 下的两个需求仍可同时启动 worker，共享源码、测试临时文件和自定义 artifact，和文档中的 worktree/隔离安全基线不一致。
- 本阶段用进程内 workspace lease fail-closed：单 RunService 内只允许一个含 `node.run` 的活动 executor；新请求冲突 409 不落事实，启动失败无条件释放，已派发等 finally 收束。冷恢复冲突保留原 run/预算，释放后自动重检，取消不复活；无 agent 流程兼容。
- lease 不是 git worktree、OS sandbox 或跨进程分布式锁；它先防止当前 server 内部的并发污染，后续仍需独立 worktree/容器与跨 daemon 锁契约。

## 实现校准（2026-10-09，跨实例 workspace lease）

- Node 内置 SQLite 可以通过独立 lock DB 的 `BEGIN IMMEDIATE` 提供本地多连接/进程互斥；主索引 DB 不宜持有长事务，否则所有 REST 写命令也会被阻断。
- 锁是运行能力，不是授权或执行事实；只有 busy 可以等待，损坏/访问失败必须分别报告并禁止派发。另需 fsync owner 标记记录未确认释放，正常收束才清除；这不是 Goal 预算或审批事实。
- 跨进程释放没有事件通知，需要只对既有授权恢复做有界间隔的锁重检；新启动保持 409，不创建隐式授权队列。
- SQLite 锁在持有进程退出时释放，但真实强杀反例证明 detached 子进程仍活着；最终新增异常标记阻断自动接管，先核验遗留进程/副作用再修复，不用 PID/mtime 推断，不声称全服务多副本事件写入安全。

## 实现校准（2026-10-09，Goal 源码变更清单）

- 安全扫描已经观察 path/kind/mode/content_hash，只向外返回 source_hash；可以按需复用原清单，不引入另一套扫描或 Git diff 归因规则。
- 首次实际源码是基线，不能用 Git HEAD 把用户旧未提交代码归给当前 Goal；修复尝试/冷恢复必须保留同一基线。
- 宿主生成完整 delta 与指南，并从基线应用 delta 重算到被测 source_hash；模型自报的“变更”段落不是清单证据，声明范围之外的改动也不自动归因。

## 实现校准（2026-10-10，协调源码变更观察）

- 源码 delta 最多 10,000 项/1,000,000 字符，协调必需上下文只有 60,000 字符预算；直接注入会挤掉真实需求与文档，不符合最新快照协调职责。
- 共享 ready 核验后再生成计数和 16 条路径样本，完整证据 hash 纳入观察身份；过期时保留历史但不能引用为当前 ready，非法/取消不提供摘要。
- hook 契约与发布 review_changes 一致性须在模型派发前核验；摘要是受信宿主投影，不让模型重新累计或核验源码正文。
# 阶段 59：Agent 启动能力（2026-10-10）

- 用户的默认 Goal 交付原则适合当前宿主验证/修复闭环；ACP、CLI bare、auto、模型/effort 与恢复必须分轴，不能作为同一种 mode。
- 本机 Claude 2.1.220 help 确认 bare/auto；Codex 0.160.0 help 与 OpenAI Docs 确认 exec/resume。bare 会改变仓库指令与认证加载，不能默认启用；模板声明不代表当前安装/模型可用性已核验。
- ACP category 仅为 UX 元信息。精确 option_ids、select/grouped/boolean 值校验、完整 currentValue 回执及最终再核验，能阻断未知值、忽略设置或后续重置。boolean 需 initialize 协商及设置 type=boolean。
- 自定义 wrapper 必须显式映射模型/effort，完整 resume_args 绑定 session ID；不支持的旋钮与 native resume 现在拒绝，不能静默降级。配置身份覆盖恢复映射，旧自定义身份可能变化并触发保守重验。
- 原子查询只能确认本次 ACP handshake/session 的能力，不能证明模型权限/额度。查询拒绝权限请求与工具报告，不沿用 worker 写预授权；投影有界并携带省略数，不公开 argv/env/当前扩展值。
- workflow 固定节点恢复限定原授权未退出节点，保留 checkpoint/预算/配置和人工 gate；任意历史 rewind、provider/MCP/网络/原生 turn checkpoint 仍需逐项适配。
