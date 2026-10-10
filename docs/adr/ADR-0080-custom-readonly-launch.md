# ADR-0080 ｜ 自定义 headless 的只读启动与恢复映射

- 状态：accepted（已实现并验证）
- 日期：2026-10-10
- 关联：ADR-0073（严格启动）、ADR-0068（只读工具审计）、ADR-0078（流程Agent上下文）

## 决策

自定义YAML headless args增加可选完整 `readonly_args`、`readonly_resume_args`；自定义模板支持 `{{readonly}}`，仅替换为当前任务的true/false文字。选择规则为正常/只读 × 新会话/原生恢复，参数分支不相互追加。readonly_resume_args要求有resume_args与readonly_args；缺少独立readonly恢复分支时，该能力不声明支持，显式readonly resume在spawn前拒绝，不能退回可写resume或新会话。

模型/effort映射必须在所有声明分支一致，resume分支必须绑定显式session ID；若基本args绑定prompt，所有完整分支也必须绑定prompt。未知占位符、反向模式占位符、漏映射和仅出现在只读分支的模型选项拒绝该别名，不回退内置agent。替换只进行一次，不经shell，不递归展开用户prompt。

未声明独立只读分支的旧配置保留新任务argv；可在args/resume_args使用readonly占位符表达wrapper已接收任务模式。新增能力 `readonly_launch: mapped/unmapped` 和 `readonly_resume: supported/unsupported` 仅描述headless参数映射，不承诺OS隔离或工具执行前拦截。内置模板显式声明plan/sandbox启动与恢复映射；外部HeadlessCliTemplate未声明supports_readonly时为unmapped，未显式声明supports_readonly_resume=true时为unsupported并拒绝只读恢复。ACP仍消费已有协议权限边界，不伪造CLI映射声明。

实际分支argv及不可用readonly resume的null进入现有配置hash；只有受影响的定义改变身份。能力进入公开清单与严格CoordinationAgents，协调输入自然绑定模式变化；server重载保持在途driver快照，冷恢复/审批继续沿用已有配置身份检查。自定义raw args依旧不自动探测安装/协议。

## 兼容性

旧自定义新任务继续使用原args；可写resume仍使用resume_args。旧配置或外部模板仅声明普通resume但没有只读恢复映射时，显式只读resume现在在spawn前拒绝，配置hash也可能变化，旧未退出checkpoint/协调提议/审批按现有身份规则重新核验。迁移时为wrapper添加完整分支或readonly占位；外部模板实现真实只读恢复后再显式声明支持。内置模板的实际argv不变。

## 验证

覆盖四种实际启动argv、bool占位/一次替换、分支/映射错误、readonly resume拒绝前无进程、配置身份/固定快照、真实SDLC实现与只读评审、最新PRD独立协调和最终人工gate。只读工具审计/ACP权限与源码验证保留，wrapper需要自行实施只读，未报告的副作用不能由本层证明不存在。

最终全量1326项/90文件、typecheck/build:all/diff通过；42项定向回归包含外部模板显式声明与无进程拒绝。隔离TCP与1440/390/320浏览器验收通过，实际wrapper不调用LLM。配置、迁移与审查入口见 [Human Review指南](../research/2026-10-10-custom-readonly-launch.md)。
