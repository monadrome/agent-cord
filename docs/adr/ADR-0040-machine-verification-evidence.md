# ADR-0040 ｜ 机器验证结果作为带输入指纹的事件证据

- 状态：accepted（实现已落地）
- 日期：2026-10-08
- 关联：ADR-0014（工作流与门禁）、ADR-0020（事件协议）、ADR-0030（审批新鲜度）、ADR-0035（REST 幂等）
- 来源：阶段 18 真实 Draft 复盘；阶段 20 结构化验证闭环实现

## 背景

只读 reviewer 的 Markdown 报告适合解释发现，但不能单独证明测试、构建或其他机器检查曾经针对当前输入执行。仅增加一个 `event-emitted` 检查也不够：旧的成功事件可能在 PRD、账本或工作流输入变化后继续被误用。

## 决策

增加 `verification.completed` 事件和 `verification-passed` 内置 checker。

1. 宿主或 CI 通过 REST 获取指定 run/node 的当前 verification context，再提交验证摘要。服务端重算当前 `input_hash`；提交携带旧指纹时返回 409，不写入事件。
2. 事件只保存验证 ID、状态、命令摘要 hash、输入 hash、退出码、耗时、stdout/stderr hash 和短摘要；不保存输出正文、凭据或任意命令参数。
3. checker 只接受当前 workflow scope、当前 run、当前节点、指定 verification ID、最新状态为 `passed` 且 `input_hash` 与当前 gate 输入指纹相同的事件。缺少 run/input 指纹、读失败、旧结果和失败状态均 block。
4. REST 写入口使用统一 `Idempotency-Key`；同键重放返回同一事件结果。事件事实仍是唯一来源，控制台可通过普通事件流观察。
5. 验证 gate 可使用 `on_fail: escalate` 作为外部验证等待点；验证事件成功落盘后，server 只唤醒同一 run 的挂起 gate 进行重检，不直接放行或写人工决策。
6. 若验证事实已落盘后进程重启，run recovery 识别同一 `run_id` 的验证事件并恢复 executor，再次求值 pending gate。
7. 重启后才提交的验证结果也恢复原 run；恢复串行化且不重新登记 run。重检仅针对当前节点中引用该 verification ID 的 gate，无关验证不改变人工审批。挂起 Promise 建立后再次核验持久化证据，避免结果早到时丢失唤醒。

## 取舍

机器验证执行器仍由宿主、CI 或外部插件负责，agent 不可伪造成功事实。当前实现记录摘要 hash，不在事件流内承载长日志；日志留在外部系统或临时工作区，由调用方按需保存。

## 证据

- `src/core/schema.ts` 固化事件类型和 payload。
- `src/workflow/checkers.ts` 实现 hash 绑定的 fail-closed checker。
- `apps/server/src/app.ts` 提供 context/read 与 idempotent record REST API。
- `apps/server/tests/verification.test.ts` 覆盖成功消费、幂等重放和输入变化 409；workflow checker 回归覆盖不同 run 的同输入事实不能复用。
