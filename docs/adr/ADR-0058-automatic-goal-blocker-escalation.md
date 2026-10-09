# ADR-0058 ｜ Goal 阻塞后的自动协调升级

- 状态：accepted（原型已实现）
- 日期：2026-10-09
- 关联：ADR-0056（节点内 Goal 交付）、ADR-0057（Goal 阻塞观察）、ADR-0032（协调轮次）、ADR-0053（澄清撤回）
- 来源：持续优化目标；阶段 43 验收发现 blocked Goal 仍需人手主动发起协调轮次

## 背景

Goal 已能在预算内自主修复。达到无进展、权限或环境边界时，run 会失败并保留原因，但 Context Session Agent 只有在用户显式调用协调 API 后才会分析该卡点。这样人仍需承担“发现失败 → 启动协调”的调度动作，正常卡点升级不具备自动闭环。

## 备选方案

1. 继续只显示 failed run，让人手动发起协调。
2. RunService 直接让模型回答人工问题，或自动批准/增加 Goal 预算。
3. Goal 声明可选 `supervisor_agent` 后，宿主在该 Goal 首次 blocked 时自动创建一个 `goal_blocked` 协调轮次；协调器只能产出 ask_human/wait Draft，人工仍通过既有澄清或 gate 入口决定。

## 决策

采用方案 3。`run.goal.supervisor_agent` 是非敏感 agent 别名，`supervisor_timeout_ms` 可选。声明后，RunService 在当前 run 的 `goal.attempt.completed{status:blocked}` 事实落盘、run 终态确定后调用 `CoordinationService.start`，绑定相同 `sdlc_id`、版本和需求最新快照，并在 `coordinator.round.requested` 保存 `trigger: goal_blocked`、node_id、run_id 与 goal event_id。协调轮次通过既有 execution context 读取 Goal 状态；blocked/invalid/cancelled 时 eligible_nodes 为空，模型不能 advance。

自动升级是有界且幂等的：同一 run/node/goal event 只触发一次；已有在途协调轮次不再创建。supervisor 解析失败、协调超时或事实追加失败不改变原 run 失败事实，写入协调失败轮次或 server error，人工仍可用另一个有效 agent 手动重新协调。未声明 supervisor_agent 的旧 workflow 不自动调用任何模型。

自动升级只创建 Draft，不发送外部消息、不记录人工选择、不批准 gate、不恢复 run、不扩充预算。ask_human 的答案仍使用现有 `coordinator.round.answered`，撤回仍使用现有 revoke 机制；输入/代码变化使该轮 stale，需要新轮次。supervisor agent 使用当前 resolver 和普通 ACP/headless 权限策略。

## 理由（第一性原理推导）

1. Goal 阻塞已经是宿主可验证事实，发现卡点与启动协调可以确定性连接，减少无价值人工调度。
2. supervisor 只负责解释卡点和形成有限选择题，继续执行与权限仍由宿主和人决定，避免自动化扩权。
3. 事件先于调用落盘，重启可识别已请求/已完成轮次，不重复付费模型调用。

## 被否方案的否决理由（逐一）

- 方案 1：把机器已经知道的 blocker 再交给人寻找，保留了 Goal 设计要消除的中间人工步骤。
- 方案 2：模型不能替人回答事实/权限问题，自动扩预算和批准会违反 Draft-only 与人工最终控制。
- 无条件启动默认 supervisor：旧流程会突然产生外部模型调用，且配置/凭据缺失时无法解释；显式别名保持权限和成本可审计。

## 关键实现注意点

1. `goal_blocked` 触发引用当前 `goal.attempt.completed` event_id；服务必须读取并确认 event 仍属于该 run/node/workflow revision。
2. 自动轮次请求事件增加可选 `trigger`，旧事件/旧 API 不受影响。projectRounds 只投影合法的 requested/completed 事实。
3. CoordinationService 启动锁按需求复用，不能在已有人工协调轮次时并发启动；start 返回初始 view 后后台调用继续持久化终态。
4. 自动协调失败不覆盖 run.error，也不能把 failed run 改为 waiting_human；只在协调视图显示失败/待重试。
5. 覆盖首轮 blocked 自动触发、重复恢复不重触发、supervisor 缺失/解析失败、ask_human 证据、输入变化 stale、取消与存储故障。
6. 自动触发来源纳入协调 input hash，模型只能 ask_human/wait 并引用绑定 blocker。生产请求投影同时核验宿主 actor、同节点、同 run/版本和先于请求的 blocked 事实；无效历史请求拒绝查询，不产生可答复问题。
7. 本轮 supervisor 使用当前 resolver；缺省 timeout 仍是普通协调 10 分钟，模板显式 2 分钟。没有请求的自动升级启动失败记 server error，冷恢复可补齐；有请求的失败/取消/超时不自动再调用，手动协调保持可用。

## 证据来源

- `apps/server/src/services/run-service.ts` 的 Goal 终态与运行槽位。
- `apps/server/src/services/coordination-service.ts` 的串行轮次、恢复、取消和澄清事实。
- ADR-0057 的受限 Goal 观察与 [Goal 节点交付验收](../research/2026-10-09-goal-node-delivery.md)。
- [自动升级验收](../research/2026-10-09-automatic-goal-escalation.md)：真实 supervisor、幂等恢复与人工边界。
