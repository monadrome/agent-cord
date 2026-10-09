# ADR-0063 ｜ 原授权 Goal 的显式恢复命令

- 状态：accepted
- 日期：2026-10-09
- 关联：ADR-0056（预算）、ADR-0059（新预算）、ADR-0062（授权身份）、ADR-0035（幂等写命令）
- 来源：配置还原后仅内部 RunService.recover 可用，REST/控制台无法恢复原授权 run

## 背景

Goal 续跑授权落盘后进程中断，或冷恢复配置漂移导致 failed，用户需要恢复已有授权。普通 start 会创建新的 run 与预算，retry-goal 重复命令只返回已有 run；都不能表达保留原预算的恢复。恢复也必须有持久来源，不能只更新 SQLite 登记后派发。

## 备选方案

1. 提示用户手动调用内部服务，或重新启动完整 SDLC。
2. 自动恢复所有 failed run，不区分阻塞、配置与预算。
3. 提供受当前输入约束的原 Goal 恢复命令与读侧依据投影，使用已有 executor 和预算事实。

## 决策

采用方案 3。新增 GET/POST /api/v1/runs/:run_id/goal-recovery：GET 返回 available/reason、input_hash、节点/授权来源、剩余次数与原 deadline；POST 携带 Idempotency-Key 和 input_hash。仅恢复当前、未取消/未完成、有有效 goal.retry.authorized 的 run。校验固定 resolver、原发布预算/版本、worker 配置身份；blocked Goal、耗尽预算且没有仍有效 ready、过期/不可读输入均拒绝。已归档的原发布版本仍可恢复既有授权，不授予新预算。

新 goal.recovery.requested 事实由 human/console-server 写入，引用原授权 event_id、当前 Goal/task checkpoint、节点 input_hash 和 worker hash，以及命令 input_hash。恢复 token 绑定这些字段与上一条恢复请求，操作后新读取的 token 不与旧命令重放混淆。请求落盘成功后才恢复同 run；事件没有改变原 max_attempts/deadline，不能作为放行事实。重复 token 返回原 run，不重复写请求或调用 worker。

恢复沿用既有 NodeRunner 复用与尝试机制。当前有效 ready 可以在次数耗尽或时间已过后恢复到原人工等待，不重新调用 worker。需要新增尝试时按原 goal.attempt.started 计算剩余次数与截止时间；无尝试则沿用尚未开始的原预算，执行开始后仍不重置。输入/指南变化时不能复用旧 ready。

冷恢复验证恢复请求的来源、原授权与 checkpoint 因果链；请求之后还未出现 Goal/worker 活动的窗口须保持请求输入身份。failed 登记只有有效未消费请求才可自动恢复；已消费请求不能让后来的 blocked Goal 自动循环。写失败不派发，未知结果用同键重放或读取实际状态；不删除历史请求，不修改退出节点，不自动审批。

控制台在原 run 概览显示服务端恢复依据和命令，用 RotateCcw 图标与明确文字；available/reason 由 server 决定，前端不计算预算或复制状态机。恢复后刷新需求/时间线/审批。正常运行路径不增加人工操作。

## 理由（第一性原理推导）

1. 恢复是在原授权内继续，必须与授予新预算区分，用户能看到原 run 和剩余边界。
2. 事件先于派发，才能解释中断后是否仍有执行意图；派生索引不能充当授权事实。
3. 宿主重检当前输入/身份并复用既有 runner，避免新命令成为绕过 Goal 上限或最终人审的入口。

## 被否方案的否决理由（逐一）

- 方案 1：内部能力不可操作，用户可能误选新 run 重授预算。
- 方案 2：真正 blocked/预算耗尽与配置临时漂移的语义不同，全量重跑会形成无界循环。
- 额外建立恢复状态机：与现有事件/executor/checkpoint 重复，增加跨状态机一致性问题。

## 关键实现注意点

1. 同需求共享 active 槽位，首 await 前预留；同依据恢复合并在途请求，不与普通 start/新预算并发派发。
2. 新请求记录前、冷恢复及首次派发边界核验同一输入与固定配置。配置重载只影响后续 run，不替换在途 resolver。
3. 请求恢复不代表已运行或通过；日志/模型正文不进入恢复 payload，凭据不进入身份。
4. 覆盖成功、冷漂移/还原、旧 token、并发、写失败、请求后中断、索引删除、坏来源、已消费预算/取消/非当前/非授权拒绝和最终人工 gate。

## 证据来源

- RunService.recover 与 ADR-0062 的原 run 恢复契约。
- apps/server/src/app.ts、console RequirementDetail 现有 run 操作。
- [上一阶段验收](../research/2026-10-09-goal-retry-agent-identity.md)。
