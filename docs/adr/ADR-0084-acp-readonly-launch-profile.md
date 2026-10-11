# ADR-0084 ｜ ACP 独立只读启动配置

- 状态：accepted（已实现并验证）
- 日期：2026-10-10
- 关联：ADR-0075（配置一致性）、ADR-0083（Provider顺序）、ADR-0079（查询生命周期）

## 决策

ACP定义/options增加可选 `readonly_launch: AgentLaunch`，是完整独立配置；task.readonly=true的新session与显式原生恢复都选此配置，不与launch合并。未声明时继承原launch与原有拒绝语义。独立配置在注册时核验严格ACP选项、精确option_ids、重复映射，拒绝非plan mode与非空config_options；候选/设置回执/运行漂移仍在实际session核验。不从readonly配置推断权限或OS隔离，省略mode不证明agent当前处于plan。

新配置身份域为 `cord.agent-config.acp.v6`，包含两套完整launch及其各自顺序策略；改变任意一套使旧checkpoint/审批/协调按现有规则重新核验。在途driver/resolver保持构造时快照，旧无readonly_launch的参数、身份和能力元信息不变。公开能力可选 `readonly_configuration: explicit`，只描述独立声明；headless的readonly_launch映射与严格节点要求仍为CLI专有语义。

`POST /agents/:name/inspect`增加可选readonly boolean；默认false保持原响应形状，只读响应增加readonly=true。只有ACP接受只读配置查询，headless/未知driver拒绝该模式以免误称已核验。新任务mode进入查询在途共享key，false/缺省等价；不同任务配置查询冲突409，完成不缓存，关闭/重载/幂等按原契约。

控制台ACP独立配置提供执行/只读查询选择，结果标明真实查询配置，跨模式历史不冒称当前所选结果；仍核对最新revision/hash。查询不发prompt、回调worker session或授予工具权限。typed client以可选第三input参数保留旧name/key调用。

后续 [ADR-0088](./ADR-0088-headless-readonly-launch-profile.md) 将完整readonly_launch与任务查询扩展至headless；具明确cli_help的headless可按模式查询帮助配置项，原始args仍拒绝。本ADR的ACP协商/权限与v6身份规则保持，readonly_configuration=explicit共享为独立配置声明语义。

## 验证与边界

真实ACP子进程覆盖完整替换、模型/provider/effort/mode映射、新会话/原生恢复、无profile旧拒绝、注册错误/运行漂移/查询无prompt。真实TCP验证同别名Goal实现、readonly报告与最新快照独立协调、人审未决、两套身份/固定resolver/冷恢复、按任务查询幂等/共享/冲突。桌面/手机核验模式选择与历史结果。确定性fixture不证明真实LLM访问、wrapper权限隔离或跨模式原生session副作用；Goal宿主检查、readonly工具审计、最终gate仍独立执行。

最终1384项/96文件、typecheck/build:all/diff与124个本地文档链接通过。隔离实际HTTP同别名code/code/plan/plan、宿主失败后修复通过、审批1/人工决定0/仅deliver退出/doctor通过；最新PRD协调提出wait。Playwright1440/390/320九截图与六次模式查询通过，pageerror=[]，桌面/最窄/跨mode历史截图已查看。配置/迁移和审查入口见 [Human Review指南](../research/2026-10-10-acp-readonly-launch.md)。
