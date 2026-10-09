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
