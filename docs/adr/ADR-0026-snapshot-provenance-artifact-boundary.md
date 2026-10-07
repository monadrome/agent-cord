# ADR-0026 ｜上下文快照 provenance 与 artifact 路径边界

- 状态：accepted（实现中）
- 日期：2026-10-06
- 关联：ADR-0003（共识载体）、ADR-0023（协调 session agent）、ADR-0025（run 取消与执行体可靠性）
- 来源：自定义 SDLC 实际接入复核；2026-10-06 coordinator 生产化审查

## 背景

协调 agent 每个节点执行前重建最新快照，但此前快照只读取固定的四个文档。自定义 SDLC 声明的 `artifact` 可能是其他 Markdown 文件，导致上游产物没有进入上下文包，worker 只能靠定位符自行发现。与此同时，coordinator 直接把 `node.artifact` 拼到 session 路径，恶意或错误的 workflow 可以通过绝对路径或 `..` 写出 `cord/<req-id>/`。

生产环境还需要回答「这个 agent 看到了哪一版快照」：只保存 prompt 摘要不能复现输入，事件流也无法区分一次重试前后的文档版本。

## 备选方案

1. **维持固定文档和裸路径**：改动最小，但自定义 SDLC 不完整且有越界写风险，否决。
2. **把完整文件内容写进事件**：审计直观，但事件流膨胀、重复保存敏感文档，违反事件流不承载聊天/文档全文的边界，否决。
3. **按 workflow artifact 动态采集 + provenance 指纹（选定）**：快照仍是内存视图，动态纳入声明的 artifact；对完整文件内容计算 hash，对事件流计算 chain hash，生成 `snapshot_id`，在 agent task 事件中记录指纹与事件序号。所有 artifact 写入先验证路径位于 session 目录内。

## 决策

1. `readSnapshot(session, { files })` 在固定快照文档之外，合并 workflow 节点声明的 artifact，去重后按声明顺序读取。自定义 artifact 也进入高信号内容层和定位符层。
2. 每个快照记录 `snapshot_id`、事件流 `event_seq`、`event_chain_hash`；每个文档记录完整内容的 `content_hash` 与字符长度。上下文包只使用截断内容，但 provenance 指向完整文件版本。
3. `agent.task.started` 与 `agent.task.completed` 记录 `snapshot_id` 和 `snapshot_event_seq`。恢复或重试重新采集快照并产生新的指纹，不续接外部 agent 会话。
4. artifact 必须是 session 目录内的相对路径；解析后若落在 session 目录之外，任务以 `failed` 事件结束，不能写盘。合法嵌套路径的父目录由 coordinator 创建，写入使用临时文件后替换。

## 理由（第一性原理推导）

1. 自定义 SDLC 的变化点是 artifact 声明；快照若不读取声明的文件，协调层就无法兑现「最新需求上下文」这一协议承诺。
2. 审计需要证明输入版本，而不是保存输入副本。文件 hash + 事件链 hash 能验证 provenance，同时保持事件流精简并避免重复存储文档。
3. workflow 是用户可编辑资产，任何路径字段都必须按不可信输入处理。session 目录边界把 agent 写回限制在需求作用域内，和 checker 的路径约束保持同一安全模型。

## 被否方案的否决理由（逐一）

- 固定四文档：不能支持零代码扩展的自定义 SDLC。
- 完整文档入事件：增加敏感信息泄露面和事件流体积，破坏事件事实与快照内容的分层。
- 允许任意路径：会把 workflow 定义变成任意文件写入能力，不接受。

## 关键实现注意点

1. `snapshot_id` 由规范化 JSON 的 SHA-256 派生，不读时钟、不读随机数；文件内容只读完整文本后再截断进入 prompt。
2. provenance 字段是向后兼容的可选 payload 字段，旧事件没有这些字段时照常投影。
3. 写回失败（包括越界路径、父目录创建失败、临时文件替换失败）必须落 `agent.task.completed{status: failed}`，不能让 NodeRunner 抛出未记录的错误。

## 证据来源

1. ADR-0003：协调 agent 只持最新快照，历史留事件流。
2. ADR-0023：每节点重建快照、上下文包两层剪裁、artifact 双通道写回。
3. ADR-0025：失败/恢复以事件为事实，重试使用新尝试和新上下文。
