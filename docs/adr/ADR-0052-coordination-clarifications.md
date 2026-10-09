# ADR-0052 ｜ 协调问题的人工澄清与最新快照

- 状态：accepted（原型实现）
- 日期：2026-10-09
- 关联：ADR-0032（协调提议）、ADR-0033（人工采用）、ADR-0051（worker 上下文）
- 来源：ask_human 当前只能展示问题，缺少答复闭环

## 决策

新增 coordinator.round.answered 事实，绑定 round_id、workflow_id/revision、原完成 completion_event_id、原 input_hash 与选项 choice。只接受当前有效、未归档的成功 ask_human 轮次的既有选项。每轮 API 只记录一次；相同答复重放返回原事实，不同答复返回 409，按需求预留答复槽位以避免并发旧输入同时被接受。写命令使用 Idempotency-Key，追加失败不能报告已答复。

新增 POST /requirements/:req_id/coordination/:round_id/answer。轮次投影提供 answer、answerable 与 answer_reason；回答不写 human.decision.recorded、gate.resolved、adopted，不启动 run 或 worker。现有人工 gate 保持独立。

readSnapshot 从同批严格事件投影澄清：原完成必须更早、同 session/流程版本/round、合法 ok/ask_human，input_hash 与选项匹配，回答的 actor=human、correlation=round。无效或损坏的相关回答 fail-closed，不跳过坏最新记录回退旧值。每个完全相同问题保留最新答复，最多 128 个当前问题，不静默丢弃。API 达到容量时拒绝新问题答复，已有问题仍可由新的有效轮次澄清。

RequirementSnapshot 增可选 clarifications，原生读侧始终返回数组；老库快照省略时按空数组处理。独立协调与 worker 都获得问题/选择/事件来源，这些是人工澄清事实，不代表 gate 通过、测试通过或对后续修改永远适用。模型应报告与新材料的矛盾，不把澄清当作执行授权。

只有存在澄清时改变语义身份：协调 server/no-hook 使用 v8/v6，worker 使用 execution-input v5、审批使用 approval-context v2；无澄清保留已有 v7/v5、worker v4 与审批 v1。答复追加使相关旧提议/checkpoint/审批依据失效；后续重新协调/执行才使用新输入，不自动消费模型提议。

控制台沿用现有页面与字体/颜色，问题下提供原生单选、记录答复命令、保存中/失败/过期/已答复状态。澄清来源沿用事件导航。没有新的装饰容器或直接执行入口。

## 边界

答复是当前有效问题的一次明确选择，不提供聊天历史、自由文本或修改已记答复。新的有效轮次可重新问相同问题并形成最新澄清；原记录保留审计。版本外澄清保留历史，不自动迁移成新版本约束。问题/选择进入事件流，不应包含凭据；不认证外部事件作者。上下文仍受既有字符预算，必要材料放不下时拒绝模型派发。

## 参考

LangGraph interrupts 把人工输入与持久化状态/显式 resume 分开。此处复用“人工输入先成为可恢复事实”的语义，继续用本项目 events.append 和最新快照，不引入新的工作流引擎或恢复模型私有会话。
