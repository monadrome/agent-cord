# ADR-0099 ｜ 最终评审绑定当前Goal就绪证据

- 状态：accepted（已实现）
- 日期：2026-10-12
- 关联：ADR-0061（Goal ready来源）、ADR-0030（版本化审批）、ADR-0098（节点输入范围）
- 来源：默认Goal交付与多节点只读评审的当前证据审查

## 背景

Goal→readonly评审后，最终gate常检查报告存在。verification-passed限定当前节点，不能直接消费上游Goal的当前源码/自测/指南完整证明。因此上游就绪后源码变化，最终评审仍可能只因findings存在而进入人工放行。需要可明确声明的跨节点完成证据检查，而非让模型推断或复制另一套状态机。

## 备选方案

1. 只让最终gate检查报告是否存在。
2. 给verification-passed允许任意跨节点验证引用，不核验完整Goal交付包。
3. 新增goal-ready checker，复用完整Goal来源和宿主当前输入/源码/指南核验。

## 决策

采用方案3。`checks:[{ref:goal-ready,with:{node_id:deliver}}]`只能引用自身或传递上游的Goal节点，要求同session/workflow revision/当前run的最新ready。缺Goal、未开始/blocked/cancelled、跨run/分支、来源/预算/验收矩阵/变更清单/真实命令证据不完整均block，不回退旧成功。

CheckerContext与ExecutorOptions提供可选read_goal_input宿主钩子，返回严格GoalReadinessInput（当前workflow/revision、input/source/artifact hash）。宿主以原固定resolver读取同一源码/文档，指南读取前后再次核验输入；未知、不可读或漂移失败。checker自己严格重读事件，并用resolveGoalReadiness完成来源审计后比较当前三hash，不能仅信宿主或模型的current布尔。

passed结果包含由ready/worker/验证引用和输入hash生成的确定性证据摘要，进入现有evaluation_hash。最新证据被替换、源码/PRD/指南/配置变化使旧审批失效。执行与REST决定使用同一钩子；冷恢复也重检goal-ready等待，变化后恢复原run重判，不启动新run或新Goal预算、不回滚已退出节点。无法确认时不伪造人工同意，原失败和证据历史保留。

包含goal-ready的gate必须require=all、on_fail=block。发布校验及直接库执行入口共同拒绝warn/escalate/any绕过，也验证目标Goal的依赖关系；无hook的库调用checker block，不默认信任旧文件。原verification-passed语义和没有新checker的流程保持不变。

新Goal与readonly评审示例将最终人审gate声明goal-ready；这是当前完整交付证明，不是自动审批，最终review、合入、发布仍人工。报告存在和测试通过继续是独立条件。既有已发布流程不隐式迁移。

## 理由（第一性原理推导）

审批应消费当前具体交付证据；上游已退出不表示源码被冻结。完整Goal证明已经包含命令、验收、变更、预算和指南，可以统一复用它。读取实时源码加来源审计比模型自述或单个验证ID更明确，严格门禁防止默认Goal交付被warning配置消解。

## 被否方案的否决理由（逐一）

- 方案1只证明报告文件存在，不证明当前代码交付就绪。
- 方案2跨节点单条测试可能缺交付指南、预算或验收来源，不足以证明Goal。
- 自动重跑已退出Goal或重授预算违反唯一恢复与人工权限；当前证据过期先停止，恢复原输入可重检，重新开发需明确新执行版本/授权。

## 关键实现注意点

1. 目标只在自身/传递上游，非法图/参数发布前拒绝；checker仍在运行时核验，不只靠YAML信任。
2. 原input_scope保留节点职责，goal-ready不让下游报告变成上游Goal输入；全局协调仍按最新所有材料刷新。
3. cold等待失效必须恢复原run，不能使用普通start生成不含上游Goal来源的新run；新的checker不复用跨run旧ready。
4. 原子目录事务/恶意同用户修改事实与验证器资产仍不在此保证范围，不把hash当OS抗篡改或业务充分性证明。
5. 覆盖当前ready、缺hook/错误目标/来源/配置/源码/指南变化、latest替换/取消/读故障、已落盘决定/写失败、cold与最终人审；全部离线，不操作7306真实Draft。

## 证据来源

现有verification-passed限定当前node/run/input；下游file-nonempty可以只因报告存在求值为pass。resolveGoalReadiness与RunService.readNodeInput提供完整来源/新鲜度基础；本阶段核心与ACP/headless实际TCP反例已验证最新完整ready、三hash、原run冷恢复及未消费人工选择。验收定位见[Human Review指南](../research/2026-10-12-upstream-goal-ready-gate.md)。
