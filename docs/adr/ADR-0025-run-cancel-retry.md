# ADR-0025 ｜ run 取消与节点执行体可靠性：workflow.run.cancelled + AbortSignal 贯穿 + node.run.retry

- 状态：accepted（已实现）
- 日期：2026-10-06
- 关联：ADR-0023（协调 agent 与 node.run）、ADR-0018（薄执行器与恢复语义）、ADR-0020（事件协议）、ADR-0021（server 分层）
- 来源：2026-10 开源编排生态扫描（Temporal durable execution / LangGraph double texting / vibe-kanban 停止语义）；agent 任务 flaky（限流/网络）与「跑飞了必须能停」是生产级刚需

## 背景

ADR-0023 落地了节点执行体，但控制面缺两块：(1) agent 任务失败即 run failed，瞬态错误（限流、网络抖动）要人工重跑整个 run；(2) run 一旦启动无法停止——agent 跑飞（死循环、误删）只能杀 server 进程。两者都是「编排层可靠性」的行业收敛项：Temporal 的 Signal 先落历史再响应、LangGraph 的 interrupt、vibe-kanban 的 stop 语义。

## 备选方案

1. **重试放在执行器**：executor 对失败节点循环。违反薄执行器（ADR-0018）——重试策略是智能层（带退避、带失败摘要回灌），属 NodeRunner 的变化轴。
2. **取消 = 直接杀进程**：server 找到子进程 kill。不落事件则事实源失守（事件流里 run 永远 running）；且挂起的人工 gate promise、执行器循环都不会感知，内存态与事件流必然劈叉。
3. **取消事件 + AbortSignal 贯穿（选定）**：取消先落 `workflow.run.cancelled` 事件（事实），再 abort 在途执行器（控制）。执行器在节点边界/人工挂起点检查信号；协调 agent 把信号透传 driver，driver 自己杀进程树。

## 决策

1. **新事件 `workflow.run.cancelled`**（payload：`workflow_id, run_id, reason?`）。取消是事实，先落盘后控制——server 重启后事件仍在，恢复扫描按它判定终态。
2. **`NodeRunStatus` 增 `cancelled`**（区别于 failed：不计入失败终态、不触发 retry 语义）。`agent.task.completed{status: cancelled}` 记录被取消的在途任务。
3. **AbortSignal 贯穿链**：`ExecutorOptions.signal` → 节点边界/gate 间检查 + `NodeRunContext.signal` → coordinator 尝试边界检查 + `AgentTask.signal` → driver abort 即杀进程树并关闭事件流。
   - 人工 gate 挂起：ask 与 abort 竞速，取消直接止步且**不落 gate.resolved 假判定**（事实由取消事件承载）。
   - 关键实现教训：async generator 暂停在队列 `next()` 时，`iterator.return()` 会排队等当前 await 解决——worker 静默期消费方 break 收不掉进程。因此取消必须是 **driver 级契约**（task.signal），不能只是消费侧 break。
4. **`node.run.retry: { max_attempts(1-10, 默认1), backoff_ms(默认0) }`**：coordinator 按尝试循环，线性退避（backoff × 第 n 次失败），可被取消即时打断。重试的上下文包附「上次尝试失败」摘要（worker 避开同一失败模式）。每次尝试落独立的 started/completed（带 `attempt`/`max_attempts`）。驱动解析失败属定义性错误，重试不会自愈 → 不重试。
5. **恢复语义不变**：只有 `status: ok` 的 completed 算 agentDone；failed/timeout/cancelled 的中间痕迹留事件流但不阻断重跑。取消后的 run 重新 start 即断点续跑（节点扫点规则不动）。
6. **终态判定**：`computeFinalStatus` 按 `run_id` 匹配取消事件（历史 run 的取消不污染新 run）；取消使该流程未决的人工 gate 从审批投影中移除（重启会重新发起）。run 终态枚举增 `cancelled`。
7. **API**：`POST /runs/:run_id/cancel`（幂等键）；重复取消/已终态取消返回现状（幂等安全）。

## 被否方案的否决理由

- **执行器内重试**：变化轴混淆（退避策略/失败摘要回灌是周级演进，执行器是协议级）。
- **纯杀进程不落事件**：事实源与内存态劈叉；server 重启后 run 永远 running。
- **消费侧 break 作为取消机制**：async generator 挂起语义导致静默期死锁（见决策 3 教训）。
- **取消时落 gate.resolved{block} 收尾**：伪造人工判定污染审计；取消有自己的事件类型，不需要借 gate 收尾。

## 证据来源

1. 生态收敛：Temporal「Signal 持久化先于响应」、LangGraph double texting 四策略、vibe-kanban 停止语义、OpenHands PauseEvent——取消/中断是一等控制面。
2. 实现实证：`tests/driver/fixtures/fake-cli.mjs --sleep` 复现了「静默期消费方 break 收不掉进程」的死锁，driver 级 signal 契约修复后取消延迟从 60s+ 降至亚秒（apps/server/tests/run-cancel.test.ts）。
