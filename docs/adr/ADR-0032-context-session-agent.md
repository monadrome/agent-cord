# ADR-0032 ｜ Context Session Agent 与结构化协调轮次

- 状态：accepted（用户授权的原型实现）
- 日期：2026-10-07
- 关联：ADR-0003（最新快照）、ADR-0023（节点执行体）、ADR-0030（新鲜度）、ADR-0031（配置身份）
- 来源：持续 SDLC 优化目标与现有 coordinator 的调用边界审查

## 背景

当前协调实现只在 executor 内处理 `node.run`。它能派发 worker，却不能独立分析一个需求 session，给出可供人查看的下一步提议。直接把模型自由文本接入执行器会绕过 workflow、依赖和人工 gate。

## 备选方案

1. 让协调模型自行修改 workflow、启动 worker：违反确定性执行器和人工门禁边界。
2. 把分析伪装为普通 `agent.task`：混淆 worker completion 与协调提议，污染恢复扫点。
3. 独立 ContextSessionAgent 端口与协调轮次事件（选定）：模型只提议，宿主验证，执行仍走既有 run API。

## 决策

1. 增加 ContextSessionAgent。每轮使用 `driver.run` 新会话，只读取当前 workflow 的最新 `readSnapshot`，不 resume、不注入事件正文或上一轮推理。快照的待人工 gate 与进度、账本、provenance 从同次事件读取投影。
2. 输出严格 JSON `CoordinationProposal`：summary、next_action（advance / ask_human / wait / complete）与风险。advance 只能引用当前 workflow 中依赖已退出、自己未退出且没有待人工 gate 的节点。complete 只能在全部节点已退出时提出。提议不直接执行、不写文档、不生成 gate 放行事实。
3. 每项行动必须带可验证的来源引用：当前存在的快照文档、无冲突 confirmed 账本条目或 workflow 节点。宿主检查引用和行动语义，拒绝任意工具调用/未知字段/无法解析的输出。引用验证证明来源存在，不证明模型推理正确。
4. `coordinator.round.requested/started/completed/cancel_requested` 独立于 worker 事件。server requested 记录 SDLC 发布版本；started/completed 记录 round_id、workflow、driver、配置身份、快照 provenance、稳定 input_hash 与 prompt_hash。completed 只保存通过验证的提议、输出 hash、用量或失败信息，不记录完整 prompt、自由文本、原始协议负载。
5. driver 结束后重新采集语义输入；文档、账本、进度或待人工 gate 改变时，轮次记 stale 且不返回提议。控制事件序号、轮次自己的事件不参与语义输入 hash，避免自行过期。
6. server 增异步协调轮次 API：创建、列表、读取、取消。每需求至多一轮在途协调，首个 await 前预留槽位；固定当前 agent resolver。创建使用 Idempotency-Key，并合并同键在途请求。取消先落 cancel_requested 再 abort。server 重启将未完成轮次记 interrupted/failed，不盲重放付费调用；新轮次重新读取最新输入。

## 理由（第一性原理推导）

- 协调智能与流程正确性是不同变化轴。结构化提议使模型可替换，同时把推进权保留在已有执行器。
- 最新快照必须在调用前与结果返回前都成立；输入中途变化时不能把旧建议当作当前建议。
- session 状态来自事实文件，协调 agent 自身不应成为不可重建的记忆资产。

## 被否方案的否决理由（逐一）

- 自主修改并启动：模型输出变成未校验控制面，绕过门禁。
- worker 事件复用：恢复会把协调分析误认作节点完成。
- 长会话 resume：输入失效后仍继承不可审计的旧推理。

## 关键实现注意点

- readonly 是 driver 约束，不是 OS 沙箱；协调提议始终是 Draft。CLI 外部环境/角色文件变化仍不在 configuration_hash 范围内。
- 严格输出大小与上下文大小上限；协议 metadata 不作结果 fallback，明确空最终文本必须失败。
- 事件追加失败上抛宿主；不能伪造 persisted completion。恢复与取消必须保留原 round_id。
- 本原型提供库与 REST，不自动消费提议；console 和受控执行消费可在后续迭代复用端口。
- REST 幂等缓存检查 method/path，跨写命令复用同键返回 409；协调创建入口额外合并同键在途请求，不同输入的并发复用返回 409。

## 证据来源

1. `src/coordinator/coordinator.ts` / `snapshot.ts`：既有节点派发、快照与事件边界。
2. `src/workflow/executor.ts`：依赖推进、人工等待和恢复事实。
3. `apps/server/src/services/run-service.ts`：配置固定、取消与后台生命周期。
