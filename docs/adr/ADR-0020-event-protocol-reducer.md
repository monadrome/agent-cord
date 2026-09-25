# ADR-0020 ｜ 事件协议与确定性 reducer：seq 语义、因果链、合并全序与投影契约

- 状态：accepted（设计定稿，M2 事件协议与 reducer 已实现）
- 日期：2026-09-24
- 关联：ADR-0010（SSOT 存储与合并策略）、ADR-0012（事件信封与分发）、ADR-0018（编排内核的恢复语义建立在事件流之上）、ADR-0013（投票结果只经事件入账）
- 来源：Codex 对抗性设计评审（2026-09-24，[docs/research/2026-09-24-codex-design-review.md](../research/2026-09-24-codex-design-review.md)）暴露的协议空缺；2026-09-24 人工拍板

## 背景

ADR-0010/0012 已定「事件流是唯一事实与顺序来源 + `ledger.yaml` 是投影」，但对抗性评审发现协议层有四个未闭环的空缺，任何一个都会让系统在「杀进程 / 分支合并」后无法证明正确：

1. **`seq` 语义未定义**：是 session 级还是分支级？并发追加如何取号？分支合并后出现同号/空洞时，[04 章 §6.4](../04-consensus-ledger.md) 的「seq 连续性校验」与 §6.5 的分支合并直接矛盾；
2. **reducer 无契约**：`events.jsonl → ledger.yaml` 的投影没有版本、没有输入/输出校验和，漂移不可检测；
3. **写边界不原子**：架构章允许 voting「写投票记录」，账本章又规定 ledger 只能由事件投影——若投票器直写 YAML，投影与事件流漂移；
4. **并发终态竞态未定义**：`anchor_drifted`（confirmed → provisional 的机器降级）与 `overturn`（confirmed → overturned）乱序到达时，最终状态未定义，reducer 静默择胜即破坏审计性。

本 ADR 把「事件怎么写、怎么合并、怎么投影、冲突怎么办」收敛为一个可证明的协议。

## 决策

1. **EventEnvelope v1 字段权威定义**：`{event_id, session_id, seq, prev_event_hash, type, schema_version, timestamp, actor, correlation_id, payload, source}`。其中：
   - `event_id` = ULID，全局唯一，**禁止由内容哈希派生**（两侧追加逐字节相同的行会被三路合并静默折叠，见 ADR-0010 注意点 11）；
   - `seq` = **会话内、单写者血统内**的单调序号，由 daemon 在追加时分配；跨分支合并后不承诺全局连续（见决策 3）；
   - `prev_event_hash` = 同一会话前一事件的内容哈希，构成因果链——它是合并后判断事件先后与检测丢事件的权威依据。
2. **单写者 + 原子追加 + 原子边界**：daemon 是事件流唯一写者，其他进程（CLI、git hook、插件）经本地 IPC 提交；append 原子（每事件序列化为单行 JSON）。**事件落盘成功前不发布 dispatcher、不向调用方返回成功**——「事件发生」的唯一含义是「已落盘」。投票器、门禁等任何模块只提交事件，不直写 `ledger.yaml` 状态字段（强化 [04 章 §6.3](../04-consensus-ledger.md) 的写路径收敛）。
3. **合并语义**：自定义 merge driver 按 `event_id` 去重；合并后全序 = **因果链拓扑序为主、`(timestamp, event_id)` 兜底**（处理跨血统的并行事件）。`seq` 连续性校验收窄为**按单写者血统校验**（同一 daemon 血统内无空洞 = 未丢事件；跨分支合并造成的血统交错不算违例）。04 章 §6.4/§6.5 的口径以本条为准。
4. **reducer 契约**：`ledger.yaml` = `reduce(events.jsonl)` 的纯函数输出；reducer 带 `reducer_version`；`ledger.yaml` 头部记录 `input_hash`（事件流规范化后的哈希）与 `output_hash`；`cord doctor` 重放比对，不一致即重建。reducer 版本变更必须向后兼容回放（旧事件流 + 新 reducer = 合法）。
5. **并发终态竞态 = 条件写入 + 冲突转人工**：状态流转事件携带 `expected_status`（或 `based_on`：该条目当前状态的最新事件 hash）；reducer 检测到事件基于已过期状态（如重验通过到达时条目已被推翻）时**不静默择胜**，落 `ledger.conflict_detected` 事件并升级人工；人工裁决同样走事件入账。

## 理由（第一性原理推导）

1. **从「可证明正确」反推**：评审的核心批评是「能演示、但不能在杀进程或分支合并后证明正确」。可证明性的前提是协议先闭合：顺序来源（因果链）、唯一性（ULID）、投影（带校验和的纯 reducer）、冲突（显式升级）四者齐备，审计才成立。
2. **从「seq 的两难」反推**：全局连续 seq 与分支合并在数学上不兼容（两个分支各自取号必撞号）。把连续性收窄到「单写者血统内」，既保留丢事件检测能力（血统内空洞 = 丢事件），又让合并成为合法操作。
3. **从「冲突的本质」反推**：`anchor_drifted` 与 `overturn` 乱序不是排序问题而是**意图冲突**——机器无权在两个矛盾的意图之间择胜，唯一诚实的处置是升级人工。这与「系统给人的是选择题，不是论述题」一致。
4. **从「原子边界」反推**：「写投票记录」若允许绕过事件直写 YAML，投影就与事件流漂移，且该漂移不可检测。把「事件发生 = 已落盘」定为唯一含义后，任何模块的写入都天然过审计链。

## 被否方案的否决理由（逐一）

- **「全局连续 seq + 禁止分支并行写事件」**：否决——与 ADR-0010/ADR-0011 的分支与 worktree 并行实践冲突。
- **「reducer 冲突时按时间戳择胜」**：否决——时间戳不可信（多机、乱序、时钟漂移），且静默择胜破坏审计性。
- **「投票器直写 ledger 作为性能优化」**：否决——绕过事件即绕过审计链；千行级事件量下投影成本可忽略。
- **「因果链用 vector clock 替代 prev_event_hash」**：否决——单 daemon 单写者场景下 vector clock 是过剩复杂度；`prev_event_hash` + ULID 兜底已足够，且哈希链附赠篡改检测（wake 的同构实践）。

## 关键实现注意点

1. **ULID 单调性**：同一毫秒内取单调递增（ULID 库的 monotonic 选项），保证单写者血统内 `event_id` 与 `seq` 同序。
2. **原子追加**：依赖 `O_APPEND` 单行写入语义；本地文件系统（APFS）实测 8 进程并发追加至 64KB 行无交错（调研 04 的实测）；跨网络盘不保证，`doctor` 校验兜底。
3. **合并后允许链有多个头**：两个分支各有末梢是合法形态，拓扑序处理；`doctor` 校验「每个事件的前驱存在」，而非「链唯一」。
4. **reducer 是确定性纯函数**：同输入同输出，禁读时钟与随机数；输入哈希算法冻结进 `schema_version`；`reducer_version` 变更走 ADR。
5. **`cord doctor` 三项校验更新为**：`event_id` 唯一性、血统内 `seq` 连续性 + 前驱链完整、reducer 重放一致（比对 `input_hash`/`output_hash`）。
6. **条件写入的读取侧**：`expected_status` 由提交方（门禁/投票编排）从最新投影读取、reducer 校验；投影未刷新时提交方应等待或显式失败，不允许盲写。

## 证据来源

1. Codex 对抗性设计评审（2026-09-24）：矛盾清单 #2/#3/#4 与 P0 提案（事件协议、任务 lease、fail-closed、单写路径）：[docs/research/2026-09-24-codex-design-review.md](../research/2026-09-24-codex-design-review.md)
2. 开源实现调研归档（2026-09-24）：union 合并实测边界（重复记录、行序随机、相同行折叠）、并发 JSONL 追加实测：[docs/research/2026-09-24-04-event-sourcing-file-ssot.md](../research/2026-09-24-04-event-sourcing-file-ssot.md)
3. 哈希链 + 纯归约回放 + 事件粒度分叉的同构工程（Apache-2.0，仅借思路）：wake https://github.com/nelsonwerd/wake
4. 事件 schema 版本化与 eventlog → materializer 模式（参照）：LiveStore https://github.com/livestorejs/livestore
5. 相关校准：ADR-0010 注意点 11（union 实测边界）、ADR-0012 决策（事件信封与分层归位）
