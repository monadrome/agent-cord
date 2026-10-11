# ADR-0093 ｜ Agent工作区隔离能力声明

- 状态：accepted（实现中）
- 日期：2026-10-10
- 关联：ADR-0069（workspace lease）、ADR-0070（跨进程执行锁）、ADR-0078（协调Agent能力快照）

## 背景

当前 RunService 用单 workspace lease 和本地跨进程锁避免并发污染，但 worker 实际仍在共享工作区运行；这不是 Git worktree、容器或 OS sandbox。此前能力快照没有这项字段，协调模型和控制台只能从文档推断，容易把 lease 误认为隔离。

## 决策

`AgentCapabilities.workspace_isolation` 增加明确枚举：`shared_lease`、`worktree`、`os_sandbox`。现有 ACP/headless driver 统一声明 `shared_lease`，并通过 CoordinationAgentCapabilitiesSchema 投影给 Context Session Agent；控制台 Agent 详情显示“共享工作区（lease）”。能力上下文变化使协调输入身份变化，旧协调提议按既有新鲜度规则失效。

该字段是声明事实，不是运行时授权或证明。`shared_lease` 表示宿主当前只提供同 workspace 冲突保护；不承诺路径隔离、进程权限、网络限制、Git worktree 或副作用回滚。未来引入真实 worktree/容器时，driver/RunService 必须先实现并测试对应执行路径，再声明更强枚举，不能仅修改 YAML 或能力投影。

不把字段加入当前 agent configuration_hash：现有 driver 的实际启动参数和在途 resolver 不变；协调能力快照已包含字段，因此 Context Session Agent 不会沿用隔离语义不同的旧提议。只读审计、workspace lease、人工 gate 和 Goal 宿主验证继续独立生效。

## 运行诊断与验证

新增能力 schema、ACP/headless声明、server catalog/console展示与协调上下文回归；server 另提供只读 `/workspace/lease` 投影，区分free/held/unresolved/unavailable，不接管或清理锁。断言环境/argv/prompt不进入投影。当前值为 shared_lease，生产实现仍明确限制；完整测试和 Human Review 指南见[阶段记录](../research/2026-10-10-workspace-isolation-capability.md)。
