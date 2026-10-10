# ADR-0068 ｜ 跨 driver 只读工具审计

- 状态：accepted（宿主审计原型）
- 日期：2026-10-09
- 关联：ADR-0011（每任务 driver）、ADR-0038（只读报告）、ADR-0050（协调工具边界）、ADR-0060（ACP 权限策略）
- 来源：公开 agent SDK 的 PreToolUse/guardrail 模式与 agent-cord headless/ACP 事件归一化审查

## 背景

`run.readonly` 会传给 ACP/headless driver，内置 CLI 也会尽量使用只读参数；但自定义 wrapper 的工具集合和权限行为无法由宿主假设。普通 worker 任务之前只消费文本、终态和 usage，未对已经归一化的 `tool_use` 做统一审计，因此未知 headless 工具可能在只读节点产生副作用后仍被当作正常任务继续处理。

## 备选方案

1. 继续完全信任各家 CLI 的 readonly 参数与 ACP permission 行为。
2. 把所有 worker 工具事件都当作违规，保证严格但无法运行真实只读评审。
3. 在 coordinator 对 readonly worker 做保守审计：明确读工具和可证明的无副作用命令允许，写工具、未知工具和无法解析的命令 fail-closed。

## 决策

采用方案 3。coordinator 消费 driver 已归一化的 `tool_use` 事件；readonly 任务允许有限读工具名称和不含 shell 控制语法的只读命令（`git diff/log/show/status` 等）；写工具、`file_change`、未知工具、缺少命令输入、危险 git 参数或含重定向/管道/替换语法的命令立即形成 `agent.task.completed{status: failed, failure_stage: driver, retryable: false}`，结束当前迭代器并不自动重试。错误原因只保存稳定的工具类别，不保存工具输入原文。

该审计是跨 driver 的事实兜底，不是执行前 hook、OS 沙箱或副作用回滚。ACP 的结构化 read/edit permission、Codex 的 read-only sandbox、Claude 的参数限制和源码/产物新鲜度检查仍分别生效；可写 Goal 不受该只读 allowlist 限制。协调 agent 原有 `tool_policy=none.v1` 继续拒绝任何工具事件。

## 理由

1. `readonly` 是工作流契约，不应只在某一家 CLI 的启动参数里成立。
2. 未知工具无法证明无副作用，fail-closed 比“看起来像读取”更适合无人值守路径。
3. 只允许结构化读工具和受限命令，保留 Claude/Codex/Kimi 的常见只读评审能力，不把跨 driver 语义扩大成自由 shell 解析器。
4. 违规任务不自动重试，避免反复执行同一越权动作并把权限问题误判为瞬态错误；最终 Goal/协调升级仍沿用现有事件事实。

## 被否方案的否决理由

- 方案 1：自定义 wrapper 可能忽略 readonly，宿主无法证明只读语义。
- 方案 2：会误拒绝合法的 ACP `read`、Claude `Read` 和 Codex 安全只读命令，降低可插拔 agent 的实际可用性。
- 通过正则完整解析 shell 并自动批准：命令语义、环境、git 配置和 OS 权限超出该层可证明范围，仍应交给 CLI/OS sandbox。

## 限制

工具事件通常在 driver 报告时已经执行，审计不能撤销已发生的副作用；没有工具事件的恶意 wrapper 也无法被该层发现。生产部署仍应提供独立 worktree、OS 沙箱、网络策略和进程级审计。后续若引入统一的跨 driver pre-tool hook，应新建 ADR 取代本审计的兜底地位。

## 验证重点

覆盖明确读工具、Claude 风格 `Bash(git diff:*)`、Codex `command_execution` 安全命令、写工具、`file_change`、未知工具、shell 控制语法、危险 git 参数，以及普通 readonly 节点不写 artifact 和不自动重试。验证不把该策略描述为 OS 隔离证明。
