# 上游 Goal 就绪门禁与 Human Review 指南

关联：[ADR-0099](../adr/ADR-0099-upstream-goal-ready-gate.md)、[核心 Feature](../core-features.md)、[独立评审示例](../../examples/goal-review-sdlc.yaml)。

## 目的与行为

默认 Goal 交付需要当前代码、自测证据与 review 指南一起就绪。只读 reviewer 产出 findings.md 后，最终人工 gate 不能仅凭报告存在而放行上游已经过期的代码。

最终 gate 增加明确的 `goal-ready` 检查：

```yaml
checks:
  - { ref: goal-ready, with: { node_id: deliver } }
  - { ref: file-nonempty, with: { path: findings.md } }
pass: { require: all, human_confirm: true }
on_fail: block
```

目标只能是自身或传递上游的 Goal。门禁只接受同 session、workflow revision、当前 run 的最新完整 ready；使用共享 `resolveGoalReadiness` 核验 worker 成功、全部真实宿主检查、声明验收覆盖、变更基线/清单和 usage 预算。缺 hook、未执行、来源非法、最新失败或 run 取消都阻断，不回退历史成功。

宿主读取当前 PRD/声明输入、源码与指南，指南读取前后再次核验输入；执行、人审 REST 与冷恢复使用同一规则。在途使用原固定 Agent resolver，热重载影响后续 run；重启重新核验当前配置。ready/worker/验证引用与三类 hash 的确定性摘要进入既有 gate evaluation_hash，同内容的新 ready 也需要新审批版本。

## 恢复与权限

冷恢复核验仍有效的人工等待，保持原审批和零重复 worker。证据变化或已落盘失效后中断，会重检原 run；不会建立新 run、增加 Goal 预算或重跑已退出的 deliver。仅源码变化时机器阻断；改写 findings 时只读报告后态失效，按现有规则重新运行 reviewer，上游仍有效的 Goal 保留。过期的已落盘人工选择也不能退出 review。

恢复原材料之后，可继续核验尚未退出且有原授权的执行；已经机器阻断的流程不会因文件还原而自动回滚节点或自动续跑，需明确处理执行版本/授权。最终 review、合入、发布仍人工，`goal-ready` 本身不批准任何动作。既有已发布流程不会被隐式改写，新 Agent 模板和 Goal 示例加入自身就绪核验。

## 人工审查路径

1. 阅读 [checker](../../src/workflow/goal-ready-checker.ts)：目标关系、严格重读事实、完整来源和当前三 hash 比对。
2. 阅读 [RunService](../../apps/server/src/services/run-service.ts)：readGoalInput 的指南前后输入检查，launch/evaluateRunGate 共用钩子，decideCurrent 与 recoverCurrent 的原 run 重检。
3. 以 [Agent 配置](../../examples/agents.yaml) 配合独立评审示例，在隔离工作区发布并启动；核验 deliver 自动实现/自测/修复，review 只读，最后只有一项人工审批。
4. 检查 review.md 的宿主命令、验收矩阵、源码变更清单，以及 findings.md 的缺陷定位与未覆盖项；确认当前审批对应同一 run 和执行版本。
5. 改变声明源码或指南后尝试旧审批，应 409 且没有新的 human.decision.recorded、Goal 尝试或 done 退出；报告存在不能替代当前上游证明。
6. 重启后重复上述核验；不变证据保留原审批，过期/不完整证据阻断，未消费旧选择不能自动完成流程。不要操作原 7306 真实 Draft。

## 验证与限制

核心回归覆盖缺 hook/非法目标/严格策略、伪造来源与引用、输入漂移、读取期间替换/取消/失败、同内容新证据。真实 ACP/headless fixture 子进程与 TCP 测试覆盖自主修复后只读评审、冷恢复、人工选择、热重载、来源缺失、只落盘失效恢复和存储故障，全部离线，无付费模型。

最终34项核心checker、28项TCP门禁回归通过；全量1771项/124文件、root build/typecheck/build:all/diff和280个本地文档链接通过。配置被移除或非法时cold保留可修复未决等待，恢复原配置后原审批可消费，不阻止服务启动。

隔离两棵Git工作树实际TCP验收：源码漂移后旧审批409、原run blocked且上游零重跑；正常交付保持Goal current=true，报告改写后仅重做readonly reviewer，cold保留原审批。主树仍initial，最新协调/doctor=true、审批各1/人工决定0，仅deliver退出。最终源码重启再次核验无重复worker；预览为headless `http://127.0.0.1:52221`、ACP `http://127.0.0.1:52234`，需求`REQ-GOAL-READY`。Playwright三视口1440/390/320共12张协调/审批截图与指南读取通过，pageerror=0、无横向溢出；已实际查看桌面和320审批截图。首手机反例发现64字符证据摘要撑宽审批项，补min-width与断行后通过。临时证据位于`/tmp/cord-stage89-real-result.json`与`/tmp/cord-stage89-browser-result.json`，不入Git。

验证命令：

```bash
npx vitest run tests/workflow/goal-ready-checker.test.ts apps/server/tests/goal-ready-gate.test.ts
npm test
npm run build
npm run typecheck
npm run build:all
git diff --check
```

源码扫描只证明声明范围的新鲜度，测试证据不证明业务充分性或 reviewer 的语义质量。两次读取不能提供跨进程目录事务；worker OS 隔离、可信验证资产和冻结源码版本仍未完成，不能把 hash 当抗篡改保证。独立协调仍观察全部最新材料，未知 plugin 输入须明确声明。
