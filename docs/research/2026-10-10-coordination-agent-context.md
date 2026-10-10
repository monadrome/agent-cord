# 协调流程Agent上下文与 Human Review 指南

## 问题与结果

原协调输入只绑定协调者配置。尚未派发worker时执行观察是missing/空run，worker模型、effort、角色或通道变化不会改变旧提议current。人工采用后可能执行未分析过的配置；协调prompt也不知道writer是否配置、声明哪些能力。

新增完整流程Agent上下文，server默认接入，库read_agents hook可选。按流程声明的node.run.agent和goal.supervisor_agent去重排序，最多128项；只给agent、resolution、configuration_hash和严格白名单的适配器能力。不spawn、不自动查询模型、不包括env/argv/角色正文/错误原文。能力仅声明，resolved不证明安装或模型权限/额度。未知或无稳定身份的next worker不能advance，合法wait/ask_human仍可解释卡点，来源是workflow节点。

prompt的workflow_agents和v11/v12输入hash绑定完整内容，轮次事件/REST只保存agent_context_hash，控制台记录信息显示该指纹。旧无hook库域保留，旧服务器成功提议不能声称已分析流程Agent，需要重新协调。未完成的旧采用run缺该证据时也拒绝自动恢复；不自动迁移尚无法证明的授权。

## 配置与执行边界

本轮协调使用固定resolver，热重载不改变模型实际输入；完成后查询/采用以最新定义核对current。worker身份变化独立于coordinator身份，可单独使提议失效。同样配置重新加载不因revision编号变化误判；格式/键序归一化，外部行为/env变化仍需context_revision。

采用固定实际run resolver，与提议Agent摘要及最新定义核对，防止A/B/A窗口“校验A、执行B”。记录后热重载保留授权的固定worker。冷恢复需要合法完成来源/顺序、同节点advance/输入及当前流程身份；配置变更或来源缺失拒绝自动派发，重新协调并显式采用新配置。已结束或非当前历史run保持原事实。

Goal retry与自动协调retry沿用原授权/预算规则；协调retry输入摘要同步绑定流程Agent。人工选择不批准gate，next worker修复后应新取最新快照。底层CLI/ACP运行时能力仍从显式查询获得，没有把静态元信息当运行时通过。

## 人审重点

- `src/coordinator/agent-context.ts`：唯一完整声明范围、严格能力字段/有界排序、不捕获解析错误正文、不启动进程。
- `session-agent.ts`：hook校验、metadata预算、input/hash/prompt、next worker约束和完成时重检；事件只存摘要。
- `CoordinationService`：查询/采用/retry重算，实际run固定resolver和记录前身份核对。
- `RunService.recoverCurrent`：完成actor/source/correlation、请求/完成/采用顺序、同节点/输入/hash，再比较当前配置；缺证据不派发。
- 控制台协调页 → 记录信息 → 流程Agent：核对公开摘要，角色正文仍不展示。

## 验收证据

纯测试覆盖worker/supervisor完整范围、重复/漏项/超量/非法能力、未知与缺hash、输入指纹/事件摘要、hook变化stale/修复。实际headless/ACP fixture协调验证prompt含公开writer身份，换worker后coordinator hash不变但旧提议current=false、采用409，新轮次执行B并等待人审。A/B/A拒绝未分析B，记录后重载执行授权A；冷恢复相同配置继续、改变配置和缺摘要/错误来源/错节点均拒绝，重新协调可恢复。

隔离TCP HTTP：协调调用2次、worker1次、审批1、人工决定0/节点退出0/doctor=true；只改writer就使旧采用409，不登记run，重新协调后产物为DRAFT_B。临时证据保留/tmp，原真实Draft未操作，没有付费模型调用。

这项上下文不证明CLI安装、模型质量或业务正确，不自动配置/替换Agent，也不替代OS隔离或最终review。未知外部变化仍依赖context_revision，runtime诊断结果未自动注入协调，后续按实际证据扩展。

最终验证：`npm test`1290项/87文件、typecheck/build:all/diff与123本地文档链接通过；Playwright1440/390/320三截图确认流程Agent摘要可见，无pageerror/页面横向溢出。最终代码冷预览恢复原待人审，worker仍1次。证据`/tmp/cord-stage64-real-result.json`、`/tmp/cord-stage64-browser-result.json`、`/tmp/cord-stage64-final-tests.json`。
