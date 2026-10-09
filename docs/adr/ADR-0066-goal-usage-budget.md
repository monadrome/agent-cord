# ADR-0066 ｜ Goal 可观测 usage 预算

- 状态：accepted
- 日期：2026-10-09
- 关联：ADR-0055（目标交付）、ADR-0056（节点 Goal）、ADR-0023（agent usage）、ADR-0064（验收证据）
- 来源：driver 已归一化报告 token/cost，但 Goal 预算只限制次数、时长和无进展

## 背景

Goal 可以声明 max_attempts/timeout/no_progress_limit，但 agent driver 已有 input/output token 和 cost usage，宿主没有按目标累计或停止的契约。静默无限修复会让资源使用无法审计；把厂商 CLI 的单次预算当作平台 Goal 预算又不能覆盖 ACP/headless/自定义 wrapper。

## 决策

GoalConfig 新增可选 `usage_budget`：`max_input_tokens`、`max_output_tokens`、`max_cost_usd` 三者至少一项，最多 16 个计数边界。宿主从同一 run/node 的合法 `agent.task.completed.usage` 累计观测值；缓存 token不重复计入 input，总 token字段保留原厂商口径。任一已观测指标超过上限，当前 task 已完成后立即写 `goal.attempt.completed{status:blocked,failure_kind:budget}`，保留 `usage_totals` 和 budget，不再进入下一次自动 worker 尝试，也不自动扩预算。

预算未声明时保持现有行为；声明预算但 driver 没有报告 usage 时不冒称“消耗为零”，当前 task 终态写 `usage_totals.unknown_tasks` 并 fail-closed 为 budget blocker，不进入下一次自动 worker。预算只约束宿主可观察的值，不能证明 wrapper/厂商隐瞒 usage，也不替代 OS/费用控制；agent 自有单次 `budget_usd` 仍可作为更低的 driver 层限制。

Goal prompt 显示声明的预算和“宿主按实测 usage 判定”；usage 正文不进入上下文。预算 hash 纳入 Goal 输入/执行身份，改变预算会使旧 ready/checkpoint/协调提议失效。验收 coverage 矩阵不把预算通过当业务条件通过；预算耗尽仍允许自动 blocker supervisor 解释并提供人工处理，续跑/恢复遵守原预算或新的人工授权边界。

## 理由

1. 平台必须按目标累计 usage，而不是依赖某个 CLI 参数；事件已是跨 driver 的唯一可审计事实。
2. 预算在 task 终态后停止，避免中断后 usage 未知却伪造额度；次数、时长和人工升级仍保留。
3. 未声明流程兼容旧版本，资源治理是 opt-in，不改变多数 happy path。

## 被否方案

- 只记录 usage 不停止：无法兑现资源边界。
- 只传 CLI budget 参数：ACP/custom wrapper 不受宿主控制且冷恢复不可统一核验。
- usage 缺失当零：会把未计量消耗隐藏为免费，破坏审计。

## 验证重点

覆盖多次 task 累计、边界等于上限、超限后不再调用、cost/输入/输出分别超限、usage 缺失、坏 usage、冷恢复与 blocker 升级；未声明预算的现有 Goal/真实 ACP/headless 保持调用次数和最终人审不变。
