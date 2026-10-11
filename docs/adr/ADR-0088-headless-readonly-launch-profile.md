# ADR-0088 ｜ Headless独立只读启动配置

- 状态：accepted（已实现并验证）
- 日期：2026-10-10
- 关联：ADR-0084（ACP独立配置）、ADR-0087（Wrapper旋钮）、ADR-0077（CLI帮助查询）

## 决策

Headless定义/options增加可选完整`readonly_launch: AgentLaunch`。task.readonly=true的新任务/原生恢复以该配置替代knobs+launch，不合并；缺省继续使用原配置。两套配置分别按模板声明旋钮校验，自定义完整分支占位缺值在构造hash时拒绝，不回退可写配置；readonly CLI参数/auto优先与宿主工具审计保留。

独立定义使用`cord.agent-config.headless.v3`，同一hash覆盖四种实际argv及可选context_revision，即使空独立配置也与未声明区分。任意分支模型/角色/有效参数变化使任务/审批/协调重新核验，热重载仍固定原resolver，冷恢复使用当前定义。公开readonly_configuration=explicit扩展为ACP/headless共享语义，仅描述独立参数配置，不证明权限/OS隔离；headless专有readonly_launch映射能力不变。

Headless inspect可接收readonly任务模式，但仍只执行固定version/help命令。cli_observation.launch_options.configured按所选配置投影，advertised只来自help，不发送模型/角色/prompt或验证额度。server的readonly=true查询接受ACP或具明确cli_help的HeadlessDriver；原始args无profile拒绝该任务查询，不返回虚构核验。不同任务模式按现有共享key冲突，默认查询/响应兼容。

控制台可查询的headless独立配置提供执行/只读选择，结果mode来自响应，mode与revision/hash共同核验；跨mode历史标“其他任务配置”。未声明独立配置、旧headless配置身份/argv/能力不变。

## 验证

真实子进程四分支的独立模型/effort/角色/bare/auto/额度映射、完整替换不继承、缺值/不支持拒绝、旧hash/空profile/冷漂移与snapshot。固定CLI帮助两mode配置项不同、实际argv无prompt/角色/模型、查询共享/冲突/幂等/重载/关闭兼容。TCP Goal实现与独立只读评审/最新快照协调、cold不重做、两套身份新鲜度与最终人审。离线fixture不调用付费模型，不替代Goal宿主完成审计/资源与OS隔离。

最终1480项/106文件、typecheck/build:all/diff与151个本地文档链接通过；补充custom四种组合实际调用后14项driver再次通过，生产实现未改变。5项TCP回归与隔离实际HTTP确认writer/高effort/角色/资源与独立review/低effort/角色/资源选择、宿主自测、最新PRD协调、人审1/人工决定0/仅deliver退出/doctor通过。1440/390/320十二截图/六mode查询通过，包含内部表格滚动到底可见，无pageerror/横向溢出，桌面/最窄/跨mode历史与底部已查看。审查和限制见 [Human Review指南](../research/2026-10-10-headless-readonly-launch.md)。
