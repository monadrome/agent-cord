# ADR-0098 ｜ 按声明依赖核验节点输入

- 状态：accepted（已实现并验证）
- 日期：2026-10-12
- 关联：ADR-0030（checkpoint/人审）、ADR-0038（只读报告）、ADR-0061（Goal当前来源）
- 来源：最新快照协调与默认Goal交付要求；多节点Goal→只读评审的当前指纹审查

## 背景

worker、Goal和approval输入包含全部固定文档及workflow artifact。下游评审成功生成findings.md后，上游Goal会被标记stale_input，尽管需求、源码和上游材料未变；其他分支退出也会改变任务执行hash。独立Context Session Agent仍应看完整最新快照，但每个任务的复用和自测不应被无关的下游输出驱动。

## 备选方案

1. 沿用全session文档作为所有节点的语义输入。
2. 对全部流程隐式改为只读取PRD。
3. 显式声明依赖范围，统一到worker上下文、执行/验证/审批与恢复；独立协调仍保持完整最新快照。

## 决策

采用方案3。`run.input_scope: {kind: dependencies, documents?: [...]}`为可选严格配置；未声明保留旧全部文档/进度身份，不迁移已发布流程。推荐Goal模板采用声明范围。

范围包含PRD、当前节点artifact、全部传递上游artifact、没有被workflow节点声明为产物的固定plan/adr/findings文档，以及显式documents。当前节点内置file-exists/file-nonempty/doc-has-section检查所声明的path也纳入，以免文档内容变更在求值仍pass时遗漏身份。PRD永远绑定，不可因workflow归属而移除；重复artifact若也属于自身/上游则仍保留。未声明的下游/其他分支输出不作为当前节点输入，不能只从prompt省略而继续哈希全部文档。

worker读取同一文件集合，定位符不提供被排除输出；执行hash只排除当前自产artifact，后态hash继续约束它。审批/宿主verification身份包含当前artifact和上述全部输入。其他分支/下游进度不改变作用域执行hash，只有传递上游退出集合参与；账本、澄清、需求身份、完整workflow/revision、配置、源码/预算与只读工具策略沿用原约束。额外文档路径遵循现有session普通文件边界，非法/链接/不可读输入在派发前fail-closed。

新声明采用execution-input.v7与approval-context.v4，绑定dependency-documents.v1策略。旧字段省略不加新domain/字段，旧不具备范围证明的完成不能冒充新发布节点的checkpoint。多轮/冷恢复/Goal current/verification与人工gate共用同一读取集合；过期或缺来源仍拒绝。已退出节点不回滚。

独立Context Session Agent继续读取完整最新需求、全部已声明产物和范围补充文档、完整执行/验证/Agent观察；任何下游文档变更仍使它的旧提议过期。同时上游Goal能够继续如实展示current=true，直到其真实输入、源码或指南变化。

## 理由（第一性原理推导）

依赖图定义了谁消费哪些产物。把所有文档混为输入会使有效完成被后续成功自然失效，造成误升级与重复执行；只读报告不应撤销它观察的源码测试。明确范围既控制上下文，也限定证据含义，额外跨节点材料由发布定义明确声明。

## 被否方案的否决理由（逐一）

- 方案1把正常下游交付误当需求变化，妨碍协调判断真实进展。
- 方案2漏掉规划、决策、上游产物和人审依据，也破坏既有流程语义。
- 自动推断外部checker/自由提示中的文档路径不可靠，发布者需用documents补充，无法判定时不能声称已覆盖。

## 关键实现注意点

1. 共用纯文件集合/依赖闭包和节点snapshot入口，不让server另维护一套hash；执行/approval的自产输出差异沿用旧规则。
2. 显式documents可补充下游/其他分支材料，但它不是新的执行依赖或授权，不能绕过DAG准入。
3. scoped snapshot仍保留事件provenance；稳定语义hash不使用事件seq/时钟。共享artifact路径不能只按下游归属排除。
4. 该机制不阻止agent从OS读取范围外文件，声明范围不证明业务完整性。输入范围缩小必须经workflow发布审查；未知plugin文件依赖需显式documents。
5. 重点验证Goal→只读报告后仍current、真实输入/自产指南变化失效、额外文件/read故障/共享路径/其他分支、在途变化、人工等待和冷恢复、旧流程兼容与完整协调新鲜度。
6. extra须存在且非空/非占位；其正文进入既有有界首尾预算。started落盘后及最终代写前重检；变化/不可读不派发或采用，取消优先保留cancelled事实。当前方法是乐观核验，不保证跨进程文件树事务。

## 证据来源

`checkpoint.ts`旧策略哈希全部snapshot docs/exited；`readApprovalContextHash`旧策略读取所有artifact；deliver→findings曾实际观察ready/stale_input。首14项中9项失败反例复现后修复，最终26项范围回归与3项ACP/headless新增TCP通过；完整1709项/122文件、typecheck/build:all/diff与真实双worktree/三视口验收完成，见[Human Review指南](../research/2026-10-12-dependency-scoped-inputs.md)。
