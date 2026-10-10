# ADR-0067 ｜ Goal 计量来源与资源观察

- 状态：accepted
- 日期：2026-10-09
- 关联：ADR-0066（usage 预算）、ADR-0061（共享 ready）、ADR-0057（协调观察）
- 来源：资源字段缺少工作台投影；部分计量、冷恢复和 ready 快照重算存在缺口

## 背景

原累计只按 run/node 过滤 completed，任意一个指标存在就视为有计量；因此费用预算可以用只报告 token 的任务绕过。任务启动后中断没有 completed 也会丢失未知消耗。ready 的 totals 仅检查字段和上限，没有从任务事实重算；原测试只改 candidate，没有改 events 中权威 ready，不能证明拒绝伪造汇总。

## 备选方案

1. UI 直接展示 Goal payload 中的 usage，不修正计量来源。
2. 复制累计规则到 server 和前端。
3. 共享严格任务来源累计、逐指标完整性和 ready 证据重算，再投影给协调与 UI。

## 决策

采用方案 3。累计限定 session/workflow revision/run/node，验证 coordinator actor/adapter/correlation、唯一任务 ID、started/completed 因果配对和启动配置/输入身份。坏来源抛出不可核验；负值、非整数 token、非有限数、部分指标与未结束任务按对应指标未知处理，保留可观测部分和下界。新增可选 unknown_input_tasks/unknown_output_tasks/unknown_cost_tasks，历史事件仍可读；新汇总完整写入。只对声明上限的指标要求完整，未声明费用上限的 token 预算不因缺 cost 被阻断。

runner 在首次派发前、每次 task 后重算；当前未知或超限不能发起下一次调用。冷恢复未结束 started 消耗无法证明，明确 budget blocker。超限/未知 blocker 保存汇总，预算错误不能取消用户的取消语义。ready 共用解析从同批任务事实重算并验证原 budget/totals 与指标完整性；旧汇总可从来源重建，但不能用伪造较小总额放行。恢复/最终 post 人审使用相同检查。等于上限仍允许已完成的有效交付，不声称当前调用期间的硬限额。

协调 observation 新增可选 usage_budget/usage_totals。server 从当前 run 事件重算，`goal_usage` 资源视图绑定 run/node/event，并返回 published budget、合法 totals、状态 not_started/observed/unknown/exceeded/invalid 与中文原因。原事件总额与重算不符时 invalid，不回退旧成功。指标状态由 server 决定，前端只显示当前 run 的资源视图；历史 round 下明确展示当前资源，不能把旧失败/旧 budget 展示为新 run。

资源视图无轮次也可通过 GET requirements/:req_id/goal-usage 读取；协调 list/get 同时返回当前资源。控制台采用不嵌套的紧凑表格，列指标、已观测、上限、未知任务数，提供 Goal 来源导航、loading/empty/error 状态；不增加授权步骤。模型上下文包含结构化计量摘要，绝不含日志/凭据或厂商 raw usage。

## 理由

1. 预算必须约束每一个声明的指标，部分计量不能伪装完整。
2. 中断不代表没有消耗，恢复不能重置未知用量或基于伪造总额继续。
3. operator 和协调者消费相同来源投影，前端不承担判定职责。

## 被否方案

- 仅展示旧字段会放大未核验统计，不能解释预算失效。
- 多处累计会使恢复/模型/UI 接受不同证据，不符合事实来源唯一原则。
- 按常见费率估算未报 cost 无法证明真实账单，不作为授权放行依据。

## 验证重点

逐指标缺失/零/超限/累计、错误 actor/版本/session/重复/未来/配对、中断恢复不重调用、伪造 ready totals、合法 ready 人审、ACP/headless 宿主执行/自动升级、current run 隔离与 1440/390/320 控制台验证。

## 限制

消费报告来自 driver，不能防止 wrapper 隐瞒/谎报真实费用；预算是调用间边界，首个或当前调用可能超额。supervisor、投票和宿主命令成本不混入 worker Goal 总額，动态扩额/全工作区费用/OS 隔离后续另定。
