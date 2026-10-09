# Goal usage 预算验收与 review 指南

日期：2026-10-09。原则见 [核心 feature](../core-features.md)，协议见 [ADR-0066](../adr/ADR-0066-goal-usage-budget.md)。

## 行为

`run.goal` 可选声明 `usage_budget`，约束 input/output token 或 cost。宿主累计同一 run/node 的合法 `agent.task.completed.usage`；超过任一上限后，当前 task 终态落盘，Goal blocked/budget，不进入下一次自动 worker 尝试，也不自动扩预算。预算不改变次数、总时长、无进展和最终人工 gate 语义。

没有声明预算的 Goal 保持原行为。声明预算但 driver 不报告 usage 时，宿主记录 unknown_tasks，不把未知当零；未观测指标不被伪造为已消耗。预算证据进入 Goal completed payload，prompt 只携带预算边界，不携带原始日志或用量正文。

## Review 定位

- `src/core/schema.ts`：GoalUsageBudget/GoalUsageTotals 约束、Goal completed usage 事实。
- `src/coordinator/goal-usage.ts`：跨 task 累计、未知 usage 处理和超限判定。
- `src/coordinator/goal.ts`：task 终态后预算检查、预算提示和 progress/blocked 事实。
- `src/driver/headless.ts`、`src/driver/acp.ts`：厂商 usage 归一化来源。
- `tests/coordinator/goal.test.ts`：超限、正好达到上限、未声明兼容和 usage 事实。

## 限制

这是宿主可观察 usage 的资源边界，不是厂商费用结算或 OS 沙箱；wrapper 隐瞒 usage 时无法证明真实消耗。driver 自有单次预算仍可更低地限制模型。动态人工扩额、跨 run workspace 总额和完整费用计量仍待后续契约。

相关后续验证：ready 解析会拒绝缺失、篡改或超限的 usage 证据，避免仅凭 task/verification 通过复用旧交付；预算超限仍可进入既有 supervisor blocker 升级，不自动扩额。
