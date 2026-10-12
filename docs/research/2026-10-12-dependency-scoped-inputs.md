# 节点依赖输入范围：Human Review指南

## 配置与效果

```yaml
run:
  agent: implementer
  input_scope:
    kind: dependencies
    documents: [manual.md]
```

`documents`可省略，默认为空。PRD仍始终作为输入；传递上游产物、当前artifact和没有被流程节点声明为产物的固定plan/adr/findings文档也自动纳入。当前节点内置文件检查的path同样绑定。额外文档须存在且非空、非占位，路径遵守session普通文件边界；缺失、链接或不可读时不派发worker，修复后重新读取可继续。

例如`deliver（Goal/review.md）→ review（readonly/findings.md）`：声明范围后，评审生成findings.md不会令上游Goal自行过期；源码、PRD、上游计划、额外资料或Goal自己的review指南改变，旧证据仍失效。共享artifact若属于自身/上游，不能因另一个节点也声明它而被排除。`documents`可以明确绑定其他分支或下游文档，但不会增加执行依赖或授权。

输入范围统一用于worker读取、正文/定位符、execution hash、宿主verification/审批输入、Goal current和checkpoint恢复。额外资料进入有界首尾正文，未显示部分有省略数；当前自产artifact排除执行正文/输入，产物后态仍单独核验，approval/verification则包含最终指南。只有传递上游退出参与稳定执行hash；账本、澄清、workflow/revision、配置、源码和资源约束继续绑定。

独立Context Session Agent仍读取完整最新快照，包括所有流程产物和额外输入文档。下游报告更新会使旧协调提议过期，同时上游Goal可以继续如实显示current=true；明确区分“某项自测仍有效”与“整个协调判断需要刷新”。

推荐“Agent协作·Goal”模板与[Goal示例](../../examples/goal-sdlc.yaml)已采用依赖范围。未声明的旧流程保持全部文档/进度语义，已有发布版本不迁移；新scope进入workflow身份，旧完成不能直接充当新范围证明。使用自定义checker或跨节点业务材料时，应在documents补充它的文件依赖，不能从自由文本猜测。

## 审查入口

1. [ADR-0098](../adr/ADR-0098-dependency-scoped-inputs.md)：输入集合、范围和恢复决策。
2. [schema.ts](../../src/core/schema.ts)：严格input_scope配置。
3. [node-input.ts](../../src/coordinator/node-input.ts)：纯依赖闭包/文件集合、readNodeSnapshot与必需额外文档核验。
4. [checkpoint.ts](../../src/coordinator/checkpoint.ts)：execution-input.v7、approval-context.v4与dependency-documents.v1策略；旧域保留。
5. [coordinator.ts](../../src/coordinator/coordinator.ts)、[goal.ts](../../src/coordinator/goal.ts)：派发/checkpoint/Goal实际使用同一集合，started落盘后及最终代写前重检，变化不派发/不采用。
6. [context-pack.ts](../../src/coordinator/context-pack.ts)、[coordination-context.ts](../../src/coordinator/coordination-context.ts)：节点有界正文与独立协调全观察共存。
7. [核心测试](../../tests/coordinator/input-scope.test.ts)、[TCP测试](../../apps/server/tests/worktree-execution.test.ts)：下游无关变化、PRD/upstream/extra/gate、自身输出、共享路径、缺失/占位/链接、在途/取消、cold恢复与两协议实际交付。

## 验收路径

| 条件 | 验证 |
|---|---|
| 正常Goal后评审不误失效 | ACP/headless写入findings后Goal与发布引用的verification仍current=true |
| 完整协调保持最新 | report A→B使旧round过期，新prompt包含B，Goal观察仍ready/current |
| 真输入变化拒绝旧证据 | PRD、传递上游、手工固定文档、explicit documents和文件gate内容进入指纹 |
| checkpoint与恢复 | 无关输出变化可复用，有效原run/审批冷保留，无重复worker；自产后态或真实输入变化拒绝 |
| 输入可用性 | extra缺失/空/占位/链接不派发，修复后恢复；无关下游链接不阻断节点，但全局协调仍拒绝坏材料 |
| 竞态与取消 | started落盘后声明输入变化零派发，执行中变化不代写报告，取消不派发；不声称原子文件树事务 |
| 兼容与边界 | scope省略保持旧全部文档，未知kind/键/重复路径拒绝；非法图不猜测省略上游 |

```bash
npx vitest run tests/coordinator/input-scope.test.ts tests/coordinator/checkpoint.test.ts tests/coordinator/context-pack.test.ts apps/server/tests/worktree-execution.test.ts
npm test
npm run build
npm run typecheck
npm run build:all
git diff --check
```

最终`npm test`为1709项/122文件通过，typecheck/build:all/diff通过，完整Goal示例解析保留scope，新增26项输入范围用例和3项ACP/headless实际TCP回归。全量曾暴露既有stdin测试把空PID文件解析为0的同步漏洞；已只接受正整数PID，保留原等待/回收上限，定向与完整重验通过。

最终本轮274个本地文档链接完整。

隔离两棵Git工作树的实际TCP路径：Goal实现/宿主自测 → readonly报告 → 最终人工等待；Goal/verification保持current=true，更新下游报告只使旧协调轮次过期，新轮次包含最新报告与补充文档。cold保持原run/审批ID、零重复worker；当前协调/doctor=true、审批各1/人工决定0，仅deliver已退出，done未退出，主树业务值initial不变。Playwright 1440/390/320共6截图，无pageerror/页面横向溢出，最新协调和只读指南可查看，桌面与320截图已实际查看。临时证据在`/tmp/cord-stage88-real-result.json`与`/tmp/cord-stage88-browser-result.json`，fixture调用无付费模型，不入Git。

## 风险与限制

该范围是证据和上下文声明，不是OS路径访问权限。Agent仍可能读取未声明文件，plugin隐式依赖未自动发现；发布者需要审查范围是否充分。源码/依赖范围仍通过Goal.inputs或verification-passed.inputs声明，不能用documents代替源码扫描。

最终人审绑定所在节点的声明输入和gate；本功能不添加跨节点业务checker、不让仅检查报告存在的gate证明业务正确、不回滚已退出节点。最终review、合入、发布和关键权限保持人工。
