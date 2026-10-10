# ADR-0081 ｜ 节点声明只读启动映射要求

- 状态：accepted（已实现并验证）
- 日期：2026-10-10
- 关联：ADR-0080（自定义只读映射）、ADR-0078（流程Agent上下文）、ADR-0068（只读工具审计）

## 决策

run增加可选 `require_readonly_mapping` 布尔字段；true仅能与readonly=true组合。缺省不新增字段、不改变旧流程定义或执行身份。显式true要求当前driver公开headless通道与readonly_launch=mapped；缺能力、unmapped或ACP不满足CLI参数映射要求，不能由普通原生恢复支持推断。

执行器在driver.run之前按当前固定resolver检查，失败记录configuration/retryable=false，不能靠节点retry反复调用、代写产物或进入人审。checkpoint复用也核验同一要求，即使外部driver配置hash未变也不能复用不满足能力的旧成功。约束字段进入完整workflow身份，旧发布版本不隐式升级。

声明此要求的未退出节点缺少NodeRunner时，WorkflowExecutor抛定义错误，不能沿用普通run的fail-visible跳过，也不能凭历史成功进入post gate。已退出节点保留事实；缺省或显式false的旧节点仍按原规则处理。恢复注入生产NodeRunner后才重检映射、当前输入与checkpoint，再进入原gate。

最新快照协调的eligible_nodes与提议校验共用同一纯能力谓词。要求映射但read_agents缺失、无法解析/缺稳定配置身份或能力不满足时，不允许advance；合法wait/ask_human仍可说明卡点。采用时沿用现有最新输入/Agent上下文与固定run resolver重检，实际执行再次检查，冷恢复也不能绕过。库调用不提供read_agents时，显式约束同样fail-closed。

推荐开发Draft示例的只读计划/评审启用该要求；普通readonly与原始driver直接调用保留既有语义。该要求不提供OS隔离、模型访问证明、只读恢复能力或工具执行前拦截。ACP应使用实际协商权限与宿主审计，不冒称CLI映射；未来其他能力要求按真实语义扩展。

## 验证

覆盖发布schema拒绝可写组合、缺省身份兼容；满足/缺失/unmapped/错通道的协调提议；实际subprocess只读argv与拒绝前无进程/产物/人审；配置修复与最新PRD恢复；checkpoint能力漂移与冷恢复/热重载固定resolver。最终完整测试、类型检查、构建、实际HTTP验收与human review指南另行记录。

阶段67验证：16项定向测试（协调/NodeRunner/真实子进程/HTTP）与完整1342项/92文件通过；`npm run typecheck`、`npm run build:all`、`git diff --check`及103项本地文档链接通过。HTTP验收确认未映射节点无worker进程、不可重试且无人工审批；配置修复后以最新需求重新协调，mapped只读参数实际派发并停在人审等待。限制是确定性fixture，不证明OS隔离或真实模型权限。

阶段69补充：首次/原checkpoint缺NodeRunner拒绝、注入后恢复不重复有效worker、旧缺省/false兼容及已退出事实保留，4项新回归和最终1348项/92文件通过，typecheck/build:all/diff与111个本地文档链接通过。
