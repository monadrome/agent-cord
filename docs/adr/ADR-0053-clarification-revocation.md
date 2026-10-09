# ADR-0053 ｜ 人工澄清撤回与未确定状态

- 状态：accepted（原型实现）
- 日期：2026-10-09
- 关联：ADR-0052（澄清答复），补充其不可改写历史的修正流程

## 决策

新增 coordinator.round.answer_revoked 事实，payload={round_id,workflow_id,workflow_revision?,answer_event_id}。actor=human、correlation=round，引用更早的同 session/scope/round 合法答复。缺失/未来/自引用/错误类型/来源/范围 fail-closed，坏撤回不能被忽略。

POST /requirements/:req_id/coordination/:round_id/answer/revoke 接收 {answer_event_id}，使用 Idempotency-Key。仅能撤回当前同题有效答复，预期事件 ID 不匹配或已被后续同题答复替代返回 409；同事件重复撤回重放原结果。撤回无需原问题仍 current，也不批准 gate、恢复模型或启动 worker。答复与撤回共用每需求写槽位，避免交错旧操作。

历史答复保留 choice、answered_at，并新增可缺省 revoked_at/revocation_event_id；轮次提供 answer_revocable。撤回后原轮次仍不可重复答复，需新有效轮次重新提问，历史不被覆盖。

SnapshotClarification.choice 扩展为 string|null；有效答复保持原四字段形状。撤回状态为 {event_id:revocation_id,round_id,question,choice:null,status:revoked}，替代该题的旧选择，不回退更早答复。这仍是当前澄清状态，不是完整对话历史；最多 128 个当前问题，包括已撤回待重问状态，不静默丢弃。

撤回材料继续进入协调/worker/审批的既有非空澄清域，新的事件 ID/null/status 使旧依据失效，不因清空选择而复活撤回前旧提议或 checkpoint。模型应把 revoked 视为未确定，不能作为旧选项已获同意；可用 clarification 来源解释撤回。

UI 已答复区提供 Undo2 图标工具“撤回答复”，保存中/失败/已撤回状态；失败保留原记录，撤回时间与事件可追溯。不添加确认弹窗或自动重跑命令。

## 边界

撤回只改变后续上下文，已退出节点/人工决定/文件产物不回滚。旧轮次不重答，已有选项仍由新协调轮次生成。版本外状态不自动迁移，不认证外部事件作者，不代替 OS 或多用户权限边界。
