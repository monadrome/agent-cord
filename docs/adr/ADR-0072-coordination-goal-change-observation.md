# ADR-0072 ｜ 协调 session 的 Goal 源码变更观察

- 状态：accepted
- 日期：2026-10-10
- 关联：ADR-0046（上下文预算）、ADR-0057/0061（Goal 观察与新鲜度）、ADR-0071（宿主源码变更证据）
- 来源：最新快照协调仅含 source_hash，模型无法识别已交付变化；完整 delta 最多 10,000 项，不宜直接注入

## 背景

宿主已保存首次基线和完整 delta，ready、恢复、人审会重算。协调者却只能读到 Goal 状态和 source_hash，无法分辨变更范围。把完整 manifest/delta 填入协调 prompt 会挤掉需求和文档，甚至让必需元信息超过预算。

## 备选方案

1. 保持只有源码 hash，让模型从指南文字猜测。
2. 直接把完整 baseline/delta 注入模型。
3. 先核验完整 ready 证据，再投影有界摘要，标明历史状态、样本与省略数。

## 决策

采用方案 3。`CoordinationGoal.change_summary` 可选，包含 baseline_event_id、baseline_source_hash、source_hash、evidence_hash、total_changes、added/modified/deleted、最多 16 条按路径排序的 path/status 样本与 omitted_changes。计数覆盖完整清单，样本不冒充全集。evidence_hash 由完整 change_evidence 和被测 source_hash 确定性派生，不来自模型自报。

server 仅在共享 resolveGoalReadiness 核验完整基线/delta/worker/宿主测试后生成摘要。合法但源码/指南过期或不可读取时保留历史 ready 摘要，current/freshness_reason 继续决定是否能引用；invalid、缺清单和已取消 run 不提供摘要。当前 run 与 workflow revision 过滤沿用既有观察，不能把旧 run 的清单挪给新 run。

启用 review_changes 的当前有效 ready hook 必须携带合法摘要，摘要的 source_hash 要匹配 Goal 被测身份；未声明流程不能自报摘要。模型调用前的 schema/发布条件检查 fail-closed。摘要进入 execution_context 与协调输入 hash；出现摘要时使用新的条件输入域，没有摘要的旧流程保留兼容。

prompt 说明：这是声明范围内的宿主前后观察，没有源码正文、作者归属或完整业务验收结论。只有 current=true 的合法 Goal 可作就绪证据。省略路径未展示，模型不得声称逐项查看或核验全部内容；最终 review、合入和关键 gate 不自动批准。

## 理由

1. 有界宿主摘要给协调者真实范围信号，降低猜测与漏读，而不引入第二个 verifier。
2. 完整计数和省略数量使有限上下文的覆盖范围可见，防止把采样误当全集。
3. 完整证据 hash 防止样本之外的变化被输入指纹忽略；历史摘要与当前有效性分离，保持冷恢复与过期语义一致。

## 被否方案

- 指南文字可由 worker 写入，不能替代完整 delta 来源核验。
- 完整清单导致上下文膨胀，且源码正文不属于独立协调的输入边界。
- 前端重新计算或模型自报计数会与宿主证据漂移；摘要不是新的执行授权。

## 验证与限制

离线回归覆盖零变化、超过 16 条的完整计数与样本外身份变化、错误计数/省略数/重复样本、当前/过期/不可读/取消，以及 ACP/headless fixture 子进程和冷恢复。沿用共享证据核验、run/revision 过滤和协调输入 hash；未重新调用付费模型。继续保留正常 Goal 中途零人工操作与最终人工 gate。

摘要不证明源码内容正确、测试充分性、作者归属或范围外副作用，也不能从 evidence_hash 还原全部清单。完整材料仍在宿主基线/ready 事件和 review 指南；独立协调只消费有界投影。
