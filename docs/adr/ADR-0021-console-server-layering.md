# ADR-0021 ｜ 控制台与 server 分层：REST/SSE、派生索引与幂等语义

- 状态：accepted（设计定稿，MVP 已实现）
- 日期：2026-09-24
- 关联：ADR-0009（daemon/库/CLI 三种暴露形态）、ADR-0010（SSOT 存储）、ADR-0012（事件与适配器）、ADR-0018（工作流恢复语义）、ADR-0020（事件协议与投影）
- 来源：[docs/proposal-console-platform.md](../proposal-console-platform.md)（控制台与平台化方案）

## 背景

M2 只有 CLI 一种暴露形态，事件协议、账本、工作流、投票能力无法被浏览器消费。控制台方案要求新增 HTTP 服务层，同时不能破坏三条既有红线：事件流是唯一事实来源（ADR-0020）、一切状态变更只经 `session.events.append`（单写路径）、前端不复制状态机（否则与 reducer 漂移）。

需要拍板的问题：HTTP 框架与实时通道选型、派生索引的形态与边界、写命令的幂等语义、人工 gate 如何桥接到 REST。

## 备选方案

1. **WebSocket 双向通道**：实时性好，但第一版就引入双向状态协议，重连/回放语义要自己造；
2. **Fastify + SSE**：REST 发命令、SSE 只读推送，与「命令/查询分离 + 事件流推送」天然同构；
3. **SQLite 派生索引（node:sqlite）**：存幂等键、运行实例等派生/操作数据，可整体删除重建；
4. **内存索引 + 每次启动全量重放**：零依赖，但幂等键与运行请求记录无落盘形态，重启后「同一 Idempotency-Key 是否已执行」不可判定。

## 决策

1. **分层**：`apps/server`（Fastify + TypeScript）是核心能力的新暴露形态（ADR-0009 的 daemon 形态落地），只经 `agent-cord` 库公共 API（`initSession/openSession/createExecutor/runDoctor` 等）调用 core；`apps/console`（React + Vite）只展示投影、发起命令、处理人工任务，**不含 reducer/工作流状态机的第二份实现**。
2. **通道**：写操作用 REST/JSON，实时更新用 SSE（`GET /api/v1/requirements/:req_id/events/stream`）。SSE 事件 id = 事件流 `seq`；断线用 `Last-Event-ID` 从 `seq` 之后回放（`readOrdered` 因果序）。事件**先落盘、后推送**（复用 store 的 subscribe 语义，ADR-0020 决策 2）。
3. **派生索引**：`cord/.index/server-index.sqlite`（`node:sqlite`，Node ≥22.5 内置），只存两类数据：`idempotency_keys`（键 → 已执行命令的响应快照）与 `runs`（运行请求登记：run_id / req_id / sdlc 绑定 / 起止时间）。索引可整体删除，重启后从 `cord/` 事件流重建运行状态；需求、审批、时间线等投影一律从事件流实时派生，不落库（投影不落库 = 不存在「数据库与事件流谁为准」的问题）。
4. **幂等**：所有写命令要求 `Idempotency-Key` 头；同键重放直接返回首次执行的响应（含原 `event_id`），**不产生第二条业务事件**。缺失该头返回 400。
5. **人工 gate 桥接**：工作流执行器的 `HumanGate` 端口由 server 实现为「挂起 promise + 审批投影」。`gate.waiting` 事件即审批待办的事实来源（审批列表 = 事件流中未被 `gate.resolved` 覆盖的 `gate.waiting`）；REST 决策先写 `human.decision.recorded` 事件（ADR-0012），再唤醒挂起的执行器；若决策时无在途执行器（如 server 重启后），决策先入决策暂存，由恢复的执行器在重新提问时消费。重启恢复 = ADR-0018 的节点级扫点重放，不产生重复节点事件。
6. **运行实例**：第一版为进程内 runner（单写者进程内串行），接口（start/status/cancel/resume）按可替换为持久队列设计；每个需求同一时刻至多一个在途 run，重复启动返回 409。run 的权威进度不从索引读，而是从事件流投影（节点 entered/exited、gate waiting/resolved）；索引里的 runs 表只是「谁启动过什么」的登记簿。
7. **错误与响应契约**：错误统一 `{ code, message, details }`；写命令响应带 `request_id`、`correlation_id` 与 `event_id` 或投影版本。API DTO 的 zod schema 放在 `@agent-cord/server` 的 `./contracts` 子路径导出，console 复用——不修改 `src/core/schema.ts`（契约冻结边界不变）。
8. **鉴权**：本地单用户模式，无鉴权；workspace/member/role 边界留待多用户 ADR（方案 §8.4）。secret 不进入事件 payload、浏览器存储或 git。

## 理由（第一性原理推导）

1. **从「事实只有一个」反推**：凡是可以从事件流派生的，就不允许有第二份持久化副本——否则必然出现双写漂移。因此审批/时间线/账本投影实时派生，索引只登记「不可从事件派生的操作事实」（幂等键、运行请求）。
2. **从「崩溃可证明」反推**：幂等键落盘是「重启后重复提交不重复入账」的唯一诚实实现；内存幂等表在重启后无法区分「没执行过」与「执行过但忘了」。
3. **从「状态机只能有一份」反推**：前端与 server 都不重实现 reducer/执行器；console 经 REST 拿投影、经 SSE 拿增量，server 经库 API 调 core——状态机只有 `src/core` + `src/workflow` 一份。
4. **从「人工等待是小时/天量级」反推**：gate 挂起必须可跨进程重启存活。事实来源是 `gate.waiting` 事件（已落盘），promise 只是进程内的唤醒机制；重启后执行器扫点重放、重新提问、消费暂存决策，链路闭合。

## 被否方案的否决理由（逐一）

- **WebSocket**：否决——读侧推送用 SSE 足够（文本协议、浏览器原生重连、`Last-Event-ID` 即事件序号），双向通道第一版没有写场景，只会引入自定义协议。
- **内存索引**：否决——幂等键不落盘则重启后无法兑现「同键不重复入账」，违反决策 4 的可证明性。
- **SQLite 存全部投影**：否决——投影落库即引入双写面；投影查询频率低（本地单用户），实时派生成本可忽略。

## 关键实现注意点

1. 默认端口 `7250`（`CORD_PORT` 覆盖）；server 启动时确保 `cord/` 根存在（幂等 init）。
2. `approval_id = base64url("<node_id>/<gate_id>")`：审批无独立事实，id 是事件流定位键的编码。
3. SSE 心跳 15s；连接关闭必须退订 store，避免句柄泄漏。
4. 索引重建：启动时扫描 runs 表，凡登记为 `running` 但事件流显示流程已终结的，直接按事件流投影修正；未终结且不处于 blocked 的自动恢复执行。
5. server 不写 `ledger.yaml` 以外的任何 session 文件；`ledger.yaml` 只经 `rebuildLedger()`（唯一重建路径，ADR-0020 决策 4）。

## 证据来源

- [docs/proposal-console-platform.md](../proposal-console-platform.md) §3/§7/§8（架构、API、可靠性）
- ADR-0018 注意点 4（节点级恢复）、ADR-0020 决策 2/4（单写者、投影契约）
