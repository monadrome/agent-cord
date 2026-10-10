# ADR-0083 ｜ ACP Provider 依赖配置顺序

- 状态：accepted（已实现并验证）
- 日期：2026-10-10
- 关联：ADR-0082（Provider选择）、ADR-0075（动态配置回执）

## 决策

ACP provider选择可能改变可用模型、effort与扩展选项。声明provider时按mode → provider → 按ID排序的扩展 → model → effort设置，每一步使用最新完整configOptions回执；最终重新核验所有显式选择并冻结。扩展或model设置若反向重置provider，仍拒绝，不自动来回调整或退回其他路由。

声明provider的启动身份绑定新策略 `explicit-session-selections.provider-first.v1`；旧provider配置身份变化，冷恢复/审批/协调按现有规则重新核验。未声明provider保留原顺序、策略与身份，不改变旧工作流。类别仅作展示，provider ID仍由option_ids显式指定。

## 验证与边界

覆盖provider解锁模型/扩展的真实ACP子进程顺序、候选/类型/忽略设置/反向重置/运行漂移、显式恢复与无prompt查询；自定义headless四分支实际provider argv/遗漏拒绝/固定快照。增加TCP Goal与最新快照协调、冷恢复和人工gate验证；UI provider名称与候选沿用server投影。所有模型使用确定性fixture，不证明真实provider访问或权限隔离。

阶段70最终1367项/94文件、typecheck/build:all/diff与125个本地文档链接通过。隔离HTTP worker两次同路由自动修复/宿主检查、人审1/人工决定0/节点退出0/doctor通过；新PRD下旧ready明确过期，新协调基于当前快照提出wait。1440/390/320浏览器三截图通过，桌面与最窄截图已查看，pageerror为空。审查入口和迁移见 [Provider指南](../research/2026-10-10-provider-launch.md)。
