# Goal usage 来源与资源观察

日期：2026-10-09

## 结论

Goal 的默认自主交付需要可核验的资源边界。工作台和协调 agent 应消费宿主从任务事实重算的同一份资源投影，不能直接相信 worker 或 ready 事件中的汇总数字。

## 发现

- 只要某个指标有值就视为“已计量”，会让只报告 token 的任务绕过 cost 预算。
- `agent.task.started` 没有对应完成事实时，不能把消耗当作零；冷恢复必须保留 unknown 并停止受限指标的自动续跑。
- ready 事件自报较小的 `usage_totals` 不能作为放行证据，必须从当前 run/node 的合法任务来源重算。
- 跨 session、workflow revision、run、node 或 driver 的任务事件不能混入同一个 Goal；来源身份、配置身份和输入身份不一致时应 fail-closed。

## 采用方案

共享 `accumulateGoalUsage` 严格校验任务来源和 started/completed 配对，按 input/output/cost 分别记录 unknown；runner 在派发前和 task 终态后检查预算，ready、恢复、post 人审与协调观察复用同一重算结果。server 投影当前 run 的 `observed`、`unknown`、`exceeded`、`invalid` 和 `not_started` 状态，控制台只负责展示和来源导航。

## 验证

覆盖逐指标缺失、零值、超限、错误来源、重复/孤立任务、中断恢复、伪造 ready 汇总、跨 run 隔离，以及真实 ACP/headless HTTP 闭环和控制台 1440/390/320 视口。阶段 53 全量测试 `1097` 项通过，`npm run typecheck`、`npm run build:all` 和 `git diff --check` 通过。

## 限制

计量仍依赖 driver 报告，无法证明厂商账单没有被 wrapper 隐瞒；预算是调用间的宿主边界，不等同于全工作区费用结算或 OS 级沙箱。动态扩额、workspace 总额和更强的权限治理另行设计。
