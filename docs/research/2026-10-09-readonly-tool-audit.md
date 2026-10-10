# 跨 driver 只读工具审计

日期：2026-10-09

## 调研观察

Claude Agent SDK 的官方 hooks 文档提供 `PreToolUse`，可以按工具名在执行前返回 allow/deny/ask/defer，并提供 `PostToolUse`、`SubagentStart/Stop` 等审计点。OpenAI Agents SDK 的 guardrails 将输入和输出校验独立于 agent loop。两者说明生产 agent 系统普遍把工具策略和结果验证拆成宿主控制面，但这些回调不是 ACP/headless 的共同能力。

编码 agent 编排实践还普遍使用独立 worktree、计划/评审 gate 和硬性重试/预算边界；这些措施与 agent-cord 当前事件事实、Goal 宿主验证和人工最终 gate 一致。它们也共同暴露一个现实边界：如果通用 wrapper 没有 pre-tool 回调，平台只能在归一化事件出现后审计，不能声称撤销已经发生的副作用。

## 采用判断

本阶段不把任何厂商 SDK 加入核心依赖，也不把自由 shell 解析器当作安全策略。实现一个小的宿主 fail-closed 只读审计：明确读工具和受限无副作用命令继续运行，未知/写入/危险命令形成不可自动重试的 driver failure。该层补足自定义 headless wrapper 的最低契约，同时保留 ACP permission、CLI 参数和 OS 沙箱的独立职责。

## 来源

- Claude Agent SDK hooks：<https://code.claude.com/docs/en/agent-sdk/hooks>
- OpenAI Agents SDK guardrails：<https://openai.github.io/openai-agents-python/guardrails/>
- Addy Osmani 的 agent orchestration 模式（worktree、并行、质量 gate）：<https://addyosmani.com/blog/code-agent-orchestra/>
