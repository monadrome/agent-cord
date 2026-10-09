# ADR-0057 ｜ Context Session Agent 的 Goal 阻塞观察与人工升级

- 状态：accepted（实现中）
- 日期：2026-10-09
- 关联：ADR-0032（独立协调轮次）、ADR-0048（执行观察）、ADR-0056（节点内 Goal 交付）、ADR-0053（澄清修正）
- 来源：持续优化目标；阶段 42 Goal 原型的实际恢复与阻塞验收

## 背景

节点内 Goal 已能在同一未退出节点自动实现、验证和修复。独立 Context Session Agent 当前只看到 `agent.task` 和机器验证状态：Goal 达到预算或无进展上限后，协调器无法区分“普通任务失败”和“需要人提供事实/权限”，也可能继续提议 advance。

## 备选方案

1. 让模型从任务失败文本自行猜测是否阻塞。
2. 把 Goal 事件原文和测试输出全部注入协调 prompt。
3. 宿主从当前 run 的事件流投影受限 Goal 状态，绑定输入身份和事件 ID；协调器验证 blocked Goal 后只允许等待或提出带证据的人工问题。

## 决策

采用方案 3。`CoordinationExecutionContext` 增加 `goals`，每个声明 `run.goal` 的节点恰有一项，状态为 `missing`、`started`、`retrying`、`ready`、`blocked`、`cancelled` 或 `invalid`。投影只包含当前 workflow revision/run 的最新 Goal 尝试：node、run、event、attempt/max_attempts、failure_kind、截断 reason、input/source/artifact hash、verification event IDs；不包含 worker 正文、测试日志、命令输出或凭据。

Goal 状态进入 coordination input hash 和 prompt。`goal` 事件 ID 可作为新的 `CoordinationEvidence` 来源；宿主只接受当前投影中的事件，不能引用旧尝试。存在当前 `blocked` Goal 时，eligible_nodes 为空；任何 advance 提议均 fail-closed。模型可提出 `ask_human`，问题必须携带 Goal blocked 事件证据与有限选项，人工回答仍经既有澄清事实，不等于批准 gate 或自动扩充预算。`ready` 只表示 Goal 交付审计通过，最终 post gate 仍独立人工控制。

没有 Goal 的旧 workflow、旧 execution-context hook 和旧协调事件保持兼容；缺省 goals 为空。Goal 事件读取失败、重复/外部 run、坏 payload 或声明覆盖不完整时，协调轮次失败，不回退旧成功观察。

## 理由（第一性原理推导）

1. 事件流是执行事实，宿主投影比模型自述更能区分预算、权限和验证失败。
2. 只传状态与 hash 可让协调器知道下一步而不扩大日志、凭据和提示注入面。
3. advance 的可行性必须由宿主决定；阻塞时把选择权交给模型会绕过预算和人工边界。
4. 事件 ID 与 input hash 绑定使人工升级可以恢复并在代码变化后失效，保持现有新鲜度模型。

## 被否方案的否决理由（逐一）

- 方案 1：错误/隐私日志会进入模型输入，模型可能把普通测试失败误判为需要授权，或忽略真正阻塞。
- 方案 2：原始输出扩大泄露与提示注入面，且协调器无法独立验证文本结论。
- 自动把 blocked 转成新的预算或批准：Goal 预算是用户授权边界，协调器不能替人扩权。

## 关键实现注意点

1. Goal 投影与 task/verification 投影使用同一严格事件读取、workflow revision 与 run_id 过滤；最新坏事件不回退历史 ready。
2. `goals` 字段有兼容默认值，但 server 的生产 hook 必须覆盖所有声明 Goal 节点；协调器收到缺项时 fail-closed。
3. `goal` evidence 只能引用当前 `goal.attempt.completed` 的 ULID；`ready`、`retrying` 和 `blocked` 都可作为来源，但人工问题应优先 blocked。
4. 本 ADR 不实现自动发送消息或自动回答人工问题；console 复用现有 ask_human 选择与撤回机制。后续可增加结构化卡点类别和预算调整的人工命令。
5. 验收覆盖 ready、retrying、blocked、坏事实、旧 run、Goal 与 task 交错、模型错误 advance、带 Goal evidence 的 ask_human、冷恢复和无 Goal 兼容。

## 证据来源

- `src/coordinator/goal.ts`、`apps/server/src/services/execution-context.ts` 和 ADR-0056 的 Goal 事实契约。
- `src/coordinator/session-agent.ts` 的 eligible 节点、来源校验和 execution_context 输入。
- 真实 Goal/Codex 验收记录：[2026-10-09 Goal 节点交付](../research/2026-10-09-goal-node-delivery.md)。
