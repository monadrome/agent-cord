# ADR-0090 ｜ Headless进程完成与候选结果一致性

- 状态：accepted（已实现并验证）
- 日期：2026-10-10
- 关联：ADR-0011（每任务进程）、ADR-0055/0056（Goal完成审计）、ADR-0089（启动前校验）

## 问题与依据

Headless的pump仅在未看到result时检查非零退出。CLI先发出成功result/turn.completed，再发生包装器清理错误或被信号终止，会被宿主记为ok；当前代码甚至可因此形成Goal ready或独立协调提议。execa的实际结果分别报告failed/exitCode/signal，结构化文本不能替代这些执行事实。

ACP的session/prompt是完成RPC，宿主随后主动关闭长驻进程；正常收束可能是SIGTERM。不能将一次性CLI的退出契约套到ACP。

## 决策

Headless完整迭代必须观察真实进程结束。result仍按原顺序流式返回，属于候选结果；进程failed或非零/未知退出状态仍追加agent error。spawn错误保持spawn分类；宿主超时/取消保留原分类和清理，不让后续终止信号覆盖timeout。既有消费者须读完整流，并按任何error拒绝完成/写报告/形成提议；不新增第二套状态机或事件。

此前缺退出证据的成功事实无法补判，所有Headless有效配置身份升级为cord.agent-config.headless.v4：completion_policy=process-exit-required.v1，并绑定完整旧v1/v2/v3启动定义hash。argv、两套配置、context_revision和env排除规则不变，旧任务/审批/协调必须按现有输入新鲜度重验；已退出节点不回滚。ACP与外部独立driver不改身份。

可重试driver失败仍在原Goal预算内反馈重做；持续失败保留blocker，不能因代码已经能通过检查而忽略执行错误。失败任务usage与部分文件可以保留为历史，不能成为当前就绪事实。信号/异常退出不证明远端副作用撤销。

## 验证

16项新增真实离线CLI/宿主/TCP回归覆盖成功result后的退出码/信号、无result文本、正常退出、timeout/abort分类、原稿保留、旧完整未退出checkpoint迁移与新策略复用。Goal晚失败无自测/报告/人审、原预算自动恢复和cold等待通过；最新PRD协调失败不产提议，修复后新轮次current/wait且不放行gate。

最终1513项/110文件、typecheck/build:all/diff和本地文档链接检查通过。首全量旧help关闭用例一次超时，单独19项及第二次全量通过，补公共状态诊断但原因未定位；未扩大预算或修改生产查询。隔离实际HTTP确认worker failed/ok、一次自测/attempt2 ready、cold不重复、最新协调failed/ok、审批1/人工决定0/仅deliver退出/doctor通过。指南与限制见[Human Review指南](../research/2026-10-10-headless-process-completion.md)。
