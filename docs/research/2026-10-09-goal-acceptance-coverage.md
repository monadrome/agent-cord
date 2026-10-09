# Goal 声明验收覆盖与 review 指南

日期：2026-10-09。原则见 [核心 feature](../core-features.md)，协议见 [ADR-0064](../adr/ADR-0064-goal-acceptance-coverage.md)。

## 行为变化

Goal 以前只要求检查命令通过以及指南三章节非空；现在可在发布版本声明 `acceptance: [{id, criterion, checks}]`，逐项把验收条件关联到必须实际运行的检查。未知/重复/空引用、条件重复、未关联的检查在解析/发布时拒绝。

宿主全部检查与交付审计通过后，在指南生成“宿主验收覆盖”表格并记录 ready.acceptance_evidence。对应事件来自真实 verification.completed；模型自报“全部验收通过”不被当证据。恢复、原授权恢复及协调观察使用相同 ready 来源/覆盖解析，缺项、错序、错误事件或过期输入不能作为当前交付。

## Review 定位

- `src/core/schema.ts`：可选验收清单与证据、全集检查引用约束，保留无清单历史兼容。
- `src/coordinator/goal-acceptance.ts`：条件顺序到实测事件的派生、全集一致性和安全 Markdown 矩阵。
- `src/coordinator/goal.ts`：发布条件进 worker 上下文，全部实际检查后写矩阵/证据；未解决条件参与无进展身份。
- `src/coordinator/goal-evidence.ts`、`session-agent.ts`：共享 ready 校验及 current ready hook 拒绝缺覆盖。
- `apps/server/src/services/run-service.ts`：声明条件的 post 人审消费和冷等待同样校验 ready 来源，缺映射不能仅凭测试通过放行。
- `apps/server/src/services/execution-context.ts`：只投影有合法来源的验收映射，新鲜度仍独立核验。
- `apps/console/src/markdown.tsx` 与 `styles.css`：转义竖线不分裂单元格、条件 HTML 作为文本显示、长证据换行。
- `examples/goal-sdlc.yaml` 与推荐模板：测试、类型和构建三项工程基线；业务条件须另增实际检查。

## 验证

83 项初轮相关回归通过，最终补齐 post 人审缺覆盖拒绝、冷等待 fail-closed 及合法覆盖冷人审成功对照。涵盖非法声明、多条件/共享检查、部分成功修复、缺项/错序/错事件/失败/未来引用/取消、无清单兼容、源码过期、冷恢复和协调 hook 调用前拒绝。最终全量 1043 项 / 74 文件、typecheck/build:all/diff 通过。

隔离真实 ACP fixture + HTTP：未知映射发布 400；worker 首次两检查失败后自动修复，两项声明条件绑定真实通过事件，宿主写指南矩阵。observer 看到当前覆盖并提出 wait；代码变化使原 Goal/协调失效，恢复相同代码后有效。冷启动保持审批 ID、不重复 worker，doctor=true。worker 2 次、observer 1 次、中途人工操作 0、gate 决策 0、节点退出 0；原真实 Draft 未操作。

最新实现的独立 HTTP 再核验缺覆盖审批返回 409、未记录人工决定；刷新预览同一审批与 worker 调用保持，doctor=true。Playwright/Chrome 1440/390/320 检查矩阵两行/四列完整、长事件 ID 换行、转义竖线与 HTML 文本安全，无单元格溢出/pageerror，桌面与 320 截图已查看。首轮脚本把文档 tab 误当 combobox，修正定位后通过，无需额外模型调用。

临时证据 `/tmp/cord-stage50-real-result.json`、`/tmp/cord-stage50-browser-result.json` 定位隔离工作区、验收事件与截图；模型正文、运行数据、截图和验收脚本不提交。

## 限制

映射证明发布条件的关联检查已实际通过，不能证明测试逻辑充分、PRD 全部语义已声明或共享可写环境抗篡改。无清单流程保持原行为且不声称条件覆盖。推荐模板条件仅为工程基线，最终业务 review 与关键 gate 仍人工。持续目标保持 active。
