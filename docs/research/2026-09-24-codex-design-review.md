# agent-cord 技术决策对抗性设计评审

> 评审范围：ADR-0009~0019、README、`docs/03`~`docs/07`、`docs/research/2026-09-24-01`~`07`。结论针对设计，不代表已有实现。调研报告中的版本、star、限额等时效信息均以 2026-09-24 为准，落地前需复核。

## 总体判定

方向成立：文件+git 事件 SSOT、Draft-only、生成与判定执行器分离、ACP/官方 IM SDK、薄工作流内核，均与调研证据相符（`docs/research/README.md:9-21`）。但当前方案把“机制原则”写得比“可恢复协议”完整：事件 seq/并发/合并、reducer 版本、挂起任务、断线重放、插件信任边界尚未闭环。若直接进入 M2，最可能得到能演示、不能在杀进程或分支合并后证明正确的 Demo。

总体建议：保留产品边界和大部分选型；把事件写入、确定性 reducer、任务生命周期和 fail-closed 策略提升为 P0 核心协议。M2 砍掉真实 IM、多 IM、SQLite/FTS、CEL、MCP 插件、市场和 L2 防腐，只跑本地 CLI + 单需求 + 内置 gate + k=2 投票。

## 逐 ADR 评审表

| ADR | 判定 | 理由 | 建议动作 |
|---|---|---|---|
| 0009 语言与运行形态 | 微调 | TS + daemon + 薄 CLI 与 I/O 编排负载匹配（`ADR-0009:78-88`）。但“无状态可重放”不等于未完成任务可恢复，且本地 IPC、守护进程、单写者边界未定。 | 固定 Unix socket 优先、认证/单实例锁、graceful shutdown、任务 lease 与 supervisor；HTTP 仅远期远程部署。 |
| 0010 SSOT 存储与版本化 | **重设计** | 文件+git+JSONL 方向正确，但 `seq` 分配、并发追加、分支合并后的因果关系、reducer/schema 迁移没有一个完整契约。调研明确 union 会乱序/重复，且自定义 merge driver 不随仓库分发（`ADR-0010:102-118`；`docs/research/2026-09-24-04-event-sourcing-file-ssot.md:22-31`）。 | 另写“事件协议”子设计：单写者原子追加、ULID、每 session 逻辑时钟、父事件/因果标识、重复/冲突规则、reducer 版本与校验和、`cord init/doctor`。`ledger.yaml` 只能由 reducer 生成。 |
| 0011 agent 运行时 | 微调 | 每任务 subprocess、独立 worktree/env、三层超时和令牌桶是可信的隔离基线（`ADR-0011:68-77,96-107`）。但它仍把裸 headless 写成主决策，已被 ADR-0017 改为 ACP 优先。 | 将 0017 设为主路径；补进程树回收、退出码分类、幂等 task lease、崩溃后“重试/人工/丢弃”状态机；投票永不 resume。 |
| 0012 事件与 IM 适配 | 微调 | 分层归位正确：JSONL 事实源、dispatcher 分发、watcher 对账、官方 SDK 适配（`ADR-0012:87-100`）。但至少一次投递只定义了去重，没有定义飞书断线后的 cursor、补拉窗口、重复/乱序回放和出站发送幂等。 | 首发只做飞书 WS + CLI（`docs/research/2026-09-24-06-im-bot-adapters.md:143-151`）；把 `delivery_id/message_id`、连接 epoch、重连游标、补偿扫描、出站幂等键写入事件协议；watcher 不得产生业务事件。 |
| 0013 投票执行器 | 微调 | 直连 API、结构化输出、版本与 usage 记录、CLI/投票分离正确（`ADR-0013:52-61,81-99`）；研究也确认 AI SDK provider 层适合复用，且 temperature=0 不保证确定性（`docs/research/2026-09-24-03-blind-voting-llm-judge.md:66-86`）。 | 采用 AI SDK `Output.object` 但保留自有接口；实现 Retry-After/backoff、每 provider 并发/配额、熔断、取消、预算原子扣减；实际模型版本与响应 hash 必须落票。 |
| 0014 工作流与 gate DSL | 微调 | YAML + apiVersion + checker 注册表能兑现“新增 gate 零代码”（`ADR-0014:55-92`）。三级校验、9 类触发器、N/N-1 同时支持对 M2 过重；`pass/block/warn` 与 `escalate` 的事件/状态映射易歧义。 | M2 只实现内置 checker、单一 `block/escalate`；冻结结果状态与动作的正交 schema；CEL/外部 checker 延至 M3，并用 JSON Schema fail-closed。 |
| 0015 知识库 | 微调 | Markdown SSOT + 派生索引、embedding 后置合理（`ADR-0015:53-69`）。但 README/ADR 总览仍写 trigram，而调研已实测 2 字查询失效、bm25 无区分度（`ADR-0015:91-103`；`docs/research/2026-09-24-04-event-sourcing-file-ssot.md:183-195`）。知识晋升还依赖尚未存在的复述/人工流程。 | M2 完全后置；修正选型口径为 unigram/bigram 或 `Intl.Segmenter`，并将索引重建与文件 checkout/merge 解耦。 |
| 0016 分发与插件 | 微调 | npm、外部进程、能力清单、锁版本和官方插件同协议是合理安全方向（`ADR-0016:89-104,125-137`）。但三层插件+市场是冷启动期的过度表面积；进程隔离不等于恶意插件沙箱，网络/文件/资源上限未强制。 | M2 仅配置层；M3 再启用受信 MCP checker。增加 manifest 签名/哈希、只读输入目录、网络默认拒绝、CPU/内存/子进程上限和撤销清单。 |
| 0017 ACP 驱动协议 | 微调 | ACP v1、registry 和 permission/load 语义适合作为 AgentDriver 第一实现（`ADR-0017:45-75`）。已知子 agent permission 不转发会挂死，registry 远程清单也会漂移。 | 维持 ACP 优先，保留 Codex app-server/裸 headless 降级；registry 只作缓存/发现，不作运行时真相；定义协议能力矩阵、超时、权限请求幂等和版本 pin。 |
| 0018 DSL 与编排内核实现 | **重设计** | 自研薄执行器符合“状态归文件”结论；XState snapshot 可持久化。但把 graphlib、XState、CEL、OWS 词表、事件恢复同时纳入，掩盖了真正难点：节点副作用、挂起恢复、定时器、重复 signal 和 reducer 一致性（`ADR-0018:35-65`）。 | 先定义确定性事件驱动内核：`node.entered/exited`, `gate.waiting/resolved`, task lease；M2 用显式 reducer/拓扑排序，XState/CEL 做 spike 后再定。所有节点副作用必须带幂等键。 |
| 0019 MCP 插件协议 | 微调 | MCP stdio 复用握手/能力发现，减少自造协议（`ADR-0019:37-66`）。但 MCP tool 默认允许副作用，“`sideEffect:false`”只是声明；“任意 MCP server 可当 checker”与最小权限、纯函数、可复核目标冲突。 | 把 MCP 限定为宿主启动的 `check` capability；输入只给快照副本/上下文包，输出必须通过 schema；宿主忽略副作用，不授予任意 tool；HTTP 远端插件后置。 |

## 发现的矛盾清单

### 严重

1. **驱动主路径冲突。** ADR-0011 仍称“裸 CLI headless + AgentDriver”为决策（`ADR-0011:68-75`），ADR-0017 改为 ACP 第一实现（`ADR-0017:45-50`），README 速览仍沿用前者（`README.md:225-232`）。应以 0017 为准并补 supersede/迁移说明。
2. **事件顺序与合并不可证明。** 0012 称事件流是唯一顺序来源（`ADR-0012:89-96`），0010 又按 `(seq,event_id)` 合并；但未定义 `seq` 是 session 级还是分支级、并发追加如何取号、分支合并后空洞/同号如何处理。`docs/04-consensus-ledger.md:392-404` 要求 seq 连续，却没有合法的分支合并语义。
3. **事件源与 ledger 投影边界容易被破坏。** 架构表允许 voting “写投票记录”（`docs/03-architecture.md:121-131`），账本章节又规定 ledger 只能由事件投影（`docs/04-consensus-ledger.md:382-395`）。若投票器直接写 YAML，reducer 漂移；必须把“事件提交成功后才返回结果”作为 API 原子边界。
4. **状态机存在并发终态竞态。** `confirmed → overturned` 与锚点失效 `confirmed → provisional` 的例外同时存在（`docs/04-consensus-ledger.md:190-206`）；若 `anchor_drifted`、`overturn_requested`、`reconfirmed` 乱序到达，最终状态未定义。需要事件版本/条件写入和冲突转人工，禁止 reducer 静默择胜。

### 高

5. **daemon“无状态”表述过强。** `docs/03-architecture.md:472-485` 只保证文件状态可重放，没有 pending task、子进程 PID、权限请求、外部调用结果和 timer 的恢复协议；杀进程可能重复副作用。
6. **飞书长连接闭环缺口。** 适配器有去重/串行化/自动重连能力（`docs/research/2026-09-24-06-im-bot-adapters.md:80-85`），但设计没有断线 cursor、服务端补发范围、连接 epoch 与出站幂等；自动重连不等于事件不丢。
7. **限流只写了令牌桶。** `ADR-0011:76-77` 与 `docs/03-architecture.md:482-484` 没定义 provider 的 Retry-After、429/5xx 分类、指数退避、取消传播、需求间公平性和预算扣减竞态。
8. **插件安全模型不闭环。** IPC 可隔离崩溃，但恶意插件仍可联网、扫描宿主环境、耗尽资源或借 MCP tool 改外部系统；锁 commit/tag 只解决供应链漂移，不解决运行期能力。
9. **MVP 与决策面不匹配。** M2 退出标准要求“新增 agent/gate 只改配置”和 k=2 完整投票（`docs/10-roadmap.md:127-133`），而当前实现前提还包括 ACP registry、三层 checker、XState、CEL、插件协议、真实上下文包，依赖链过长。

### 中

10. **投票一致性口径过度承诺。** 文档多处把 temperature=0 + 版本锁描述为可复现（`docs/05-voting.md:38-44`），研究已明确 temperature=0 不保证确定性；应把“请求可复现”与“模型输出确定”分开。
11. **知识库选型文字漂移。** ADR-0015 注意点已否定 trigram 的短中文查询，但 README/ADR 地图仍写“trigram 中文分词”（`README.md:229`、`docs/adr/README.md:51`），会导致实现误选。
12. **MCP 与插件协议语义重复。** ADR-0016 冻结 `check/capabilities/health`，0019 又映射 MCP `tools/call/tools/list/ping`；二者的错误码、超时和版本协商责任没有单一权威。
13. **外部引用时效不确定。** 研究报告自称 GitHub API 后半段被限流，部分 star/活跃度未证实（`docs/research/2026-09-24-01-orchestration-workflow-engines.md:12,276-281`）；这些数据只能支持方向，不能作为稳定性证明。

## 优化提案

### P0：先让单机恢复和审计成立

| 问题 | 方案 | 影响面 | 工作量 |
|---|---|---|---|
| 事件并发、合并、reducer 漂移 | 定义 v1 事件协议：ULID `event_id`、session 内 `seq`、`prev_event_hash`/correlation、单 daemon 写者、原子追加；所有读侧按逻辑排序去重；`events → ledger` 纯 reducer 带 `reducer_version`、输入/输出 hash；`doctor` 校验并可重建 | ADR-0010/0012/0018、账本、git merge、恢复 | 中（约 1~2 周） |
| kill -9 后重复或丢任务 | 为每个 task/gate 建 `lease_id`、attempt、started/completed/failed/cancelled 事件；外部副作用要求幂等键；恢复只重试未提交完成事件的任务，权限请求/人工选择题以 pending token 恢复 | daemon、AgentDriver、voting、workflow | 中（约 1 周） |
| 失败策略分散 | 统一错误分类：timeout、rate_limited、auth、protocol、crash、invalid_output；默认 fail-closed；按错误类型决定一次重试、abstain、升级人工或终止需求，并写事件 | ACP、ProviderAdapter、MCP、IM | 中（约 3~5 天） |
| 单写路径可被绕过 | `append_event` 成功落盘前不发布 dispatcher 事件；禁止模块直接打开 ledger；CI/doctor 比对 reducer 结果；文件 watcher 只产生 `reconcile.requested` | 所有写模块、插件、git hook | 小到中（约 3 天） |
| M2 依赖过长 | M2 只支持本地 CLI adapter、内置 gate、一个 provider、k=2、固定工作流；用故障注入脚本验证重复事件、崩溃、超时、投票弃权和 reducer 重建 | roadmap、验收标准、测试夹具 | 小（约 2~4 天调整） |

### P1：在闭环稳定后扩展协议面

| 问题 | 方案 | 影响面 | 工作量 |
|---|---|---|---|
| ACP/飞书恢复不完整 | ACP 能力矩阵与版本 pin；飞书 WS 记录 connection epoch/cursor，重连后补拉或标记 gap；入站按平台 id 去重，出站按 event id 幂等 | ADR-0012/0017、官方插件 | 中（1~2 周） |
| API 限流与成本竞态 | provider 维度并发队列、Retry-After 退避、熔断与公平调度；预算以原子 reservation/settlement 记账，禁止静默换模型 | ADR-0011/0013、投票记录 | 中（约 1 周） |
| gate 状态语义不清 | 将 `result`（pass/block/warn）与 `action`（continue/escalate/stop）拆开；为每个 gate 定义可重入/超时/重复 signal 规则；先用显式 reducer，XState 只作为可替换实现 | ADR-0014/0018、06 章 | 中（1~2 周） |
| 插件可执行面过宽 | manifest 声明 capability、网络、文件、资源和副作用；默认无网/只读/单调用；OS sandbox 或容器隔离；签名/哈希锁定和撤销列表 | ADR-0016/0019、安全章 | 中到大（2~3 周） |
| 选型文字漂移 | 以 `docs/research/2026-09-24-04-event-sourcing-file-ssot.md:183-195` 的 unigram/bigram 或 `Intl.Segmenter` 为当前知识库口径；README/ADR 地图统一；为 CEL、ACP、AI SDK、飞书 SDK 建版本兼容矩阵 | ADR-0015/README/研究归档 | 小（1~2 天） |

### P2：验证规模和生态后再投入

| 问题 | 方案 | 影响面 | 工作量 |
|---|---|---|---|
| 多 IM 与统一 Chat SDK 成本 | M3 先飞书+CLI；有第二平台真实需求后再引入 Chat SDK，StateAdapter 作为派生状态实现 | ADR-0012、插件生态 | 中（按平台 1~2 周） |
| CEL/外部 MCP 复杂度 | 先用内置枚举 checker；有真实 workflow pack 后做 CEL evaluator spike 与 MCP fixtures/安全回归 | ADR-0014/0018/0019 | 中（1~2 周 spike） |
| SQLite/知识库索引维护 | 需求超过数百条或检索指标证明必要时再上；索引永远可删重建，不进入 SSOT | ADR-0010/0015、07 章 | 中（1 周） |
| L2 防腐误伤 | M3 真实仓库跑一周，先统计命中/确认/拦截，不在无数据时承诺阈值；再启用符号求交和 AST 重锚定 | 07 章、ADR-0010 | 中（1~2 周） |
| 高级 workflow engine | 仅在薄执行器无法满足恢复/等待语义时评估 Vercel World/XState；不因“成熟引擎”引入第二 SSOT | ADR-0018、`docs/research/2026-09-24-01-orchestration-workflow-engines.md:198-234` | 小到中（spike 3~5 天） |

## MVP 实施顺序建议

1. **冻结最小协议**：`EventEnvelope`、`TaskResult`、`VoteRecord`、gate 结果/动作、schema version；明确单需求、单 daemon、单写者、Draft-only、fail-closed。
2. **先做 SSOT 内核**：`cord init`、原子 append、ULID/idempotency、按事件重放、确定性 reducer、ledger 对账/重建、`doctor`；先用 CLI 注入事件，不接 IM。
3. **做最小工作流**：固定一条进入→投票→人工确认的图；内置 checker + 显式 reducer；实现 pending gate、超时、重复 signal 和重启恢复。
4. **做本地投票闭环**：一个 AI SDK provider adapter，k=2，结构化 Zod 输出，锚点存在性校验，失败一次后 `abstain`，记录模型请求/实际版本、prompt hash、usage、latency、request id。
5. **接最小 AgentDriver**：ACP client 只支持一个已验证 agent；每任务 subprocess、独立临时目录、进程树 kill、wall-clock timeout；裸 headless 仅作降级测试，不阻塞 M2。
6. **加入故障注入验收**：kill daemon/agent、重复投递、乱序事件、429/超时、无效 JSON、相同内容不同 event id、git 分支合并、reducer 重建；任一场景不能静默放行或丢审计记录。
7. **M3 再接飞书**：采用官方 WS SDK；session 键按 channel，thread 作为轮次；实现断线 epoch/cursor、入站去重、出站幂等和人工选择题。
8. **M3/M4 后置扩展**：CEL、MCP checker、XState、SQLite/FTS、知识晋升、L2 防腐、多 IM、marketplace。每一项以真实使用量或故障数据触发，不作为 M2 的通过条件。

**最终建议**：先把“事件可以被合并、重放、校验，任务可以被恢复且不重复副作用”做成可证明的内核，再扩大协议和生态表面积。当前最需要人工重新拍板的是 ADR-0010、ADR-0018 的恢复/合并契约，以及 ADR-0011/0017 的 ACP 主路径统一。
