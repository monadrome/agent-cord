# 节点只读启动映射：配置与 Human Review 指南

## 适用范围

`readonly: true` 只表示任务意图，具体 wrapper 是否真的选择只读参数由 Agent 适配器决定。需要把“未映射不能派发”作为流程不变量时，在节点上声明：

```yaml
run:
  agent: reviewer
  readonly: true
  require_readonly_mapping: true
  output: text
```

该字段要求当前 agent 是 headless，并公开 `readonly_launch: mapped`。ACP、缺少能力快照、无法解析、配置身份为空和 `unmapped` 都不满足。缺省字段保持旧流程行为；不会自动把所有只读节点变成严格准入。

## 运行边界

1. Context Session Agent 读取本轮固定流程 Agent 快照。严格节点不满足能力时 `eligible_nodes=[]`，只能提出 wait/ask_human。
2. 采用与启动之间仍使用固定 resolver；NodeRunner 在 driver 解析后、spawn 前重检，失败记录不可重试 configuration failure，不代写 artifact。
3. checkpoint 复用重新读取能力。即使 configuration_hash 未变化，能力从 mapped 变为 unmapped 也不能复用旧成功。
4. 库模式缺少 NodeRunner 时，严格节点在 post gate 前抛定义错误；原成功 checkpoint 也不能绕过。恢复注入生产 NodeRunner 后才执行/复用；已退出事实不回滚，缺省或 false 保留旧规则。
5. 修复 agents.yaml 后必须 reload，并基于最新需求快照重新协调；旧提议/审批按已有 workflow 与 agent identity 规则失效。

能力只证明参数映射。它不证明 wrapper 遵守模式、CLI 已安装、模型可访问、OS 沙箱、网络或工具边界。跨 driver readonly tool audit、ACP permission policy、源码/产物验证和人工 gate 仍分别生效。

## Human Review

- 核对 [schema.ts](../../src/core/schema.ts) 的布尔类型与 readonly 组合校验；省略字段的老流程应保持兼容。
- 核对 [agent-context.ts](../../src/coordinator/agent-context.ts) 与 [session-agent.ts](../../src/coordinator/session-agent.ts) 的共同准入谓词，确保缺能力只能 wait/ask，不可 advance。
- 核对 [coordinator.ts](../../src/coordinator/coordinator.ts) 在 spawn 前和 completion reuse 前检查能力，失败不触发 retry、进程或 artifact 写回。
- 运行 [readonly-mapping.test.ts](../../tests/coordinator/readonly-mapping.test.ts) 和 [server readonly-mapping.test.ts](../../apps/server/tests/readonly-mapping.test.ts)，再运行完整 `npm test`、`npm run typecheck` 与 `npm run build:all`。
- HTTP 验收应观察未映射任务无 worker pid、无审批；修复后 worker 的 argv 有 `--readonly true`，报告进入人工等待，不能自动记录 human decision 或 node exited。

临时验收使用确定性 fixture，不调用真实 LLM。该功能解决流程准入，不替代最终代码审查、关键 gate、合入和发布的人工作业。
