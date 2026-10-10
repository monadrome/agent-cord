# ADR-0085 ｜ Goal Blocker 写请求前统一来源校验

- 状态：accepted（已实现并验证）
- 日期：2026-10-10
- 关联：ADR-0065（协调来源链）、ADR-0059（人工续跑授权）、ADR-0084（ACP只读配置）

## 问题

自动升级入口只检查system kind/source.adapter，遗漏actor.id；协调请求的历史读取要求actor.id=goal-runner。错误来源可先被持久化为请求，再导致轮次列表读取失败。两套校验必须在写前一致，不能靠后续读失败阻止已经落盘的坏请求。

## 决策

共用纯函数resolveGoalBlocker核验完成事件类型/目标ID、同session、workflow scope、run/node、correlation、合法blocked payload与system/goal-runner actor/source。函数只验证指定事件来源，不自行选择当前run/最新Goal或证明OS写者身份。

升级与人工续跑的当前状态仍由server核验，再使用共同来源规则；目标event_id重复时拒绝，不能选第一条。历史协调请求与续跑授权也使用同一规则，并保留各自因果前缀/seq、请求与授权血统约束。失败发生在coordinator.round.requested落盘前，旧错误请求保留但不可消费，不回退历史成功。

正当Goal失败不变：显式supervisor_agent可使用同ACP别名的readonly_launch解释blocker。问答与新Goal授权分开，只有有效答复和明确retry-goal命令才能创建新预算，最终gate仍人工。没有卡点的happy path不增加supervisor调用。

## 验证

覆盖错误actor/source/目标绑定/重复引用的写前拒绝、合法来源恢复、严格历史请求和授权回归；真实TCP同ACP别名code失败→plan自动ask→有效答复/独立授权→code自测通过并等待人审。最新PRD变化、只读配置变化、冷恢复与幂等/预算不重复均应有证据，不调用真实模型或操作原开发Draft。

最终1404项/98文件、typecheck/build:all/diff与122个本地文档链接通过。错误actor先写坏请求反例已复现并修复，独立重复目标ID在写前拒绝；15项纯来源与3项同ACP真实TCP覆盖自动问答/新预算与正常路径。隔离实际HTTP保留最新问题未答，code/plan/plan、Goal尝试1/请求2、当前可答、人工答复/授权/决定/节点退出均0、doctor通过。1440/390/320三截图无pageerror/溢出/写请求，桌面与最窄已查看，审查见 [Human Review指南](../research/2026-10-10-goal-blocker-source.md)。
