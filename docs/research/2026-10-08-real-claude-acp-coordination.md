# 真实 Claude/ACP Context Session Agent 验证

日期：2026-10-08。范围是本机已安装并完成认证的 Claude Code 2.1.220 与 Kimi Code 2.1.1；两次调用都在独立临时 git 工作区、只读协调任务和 120 秒预算内完成。运行结果只保留摘要、hash、session 回执和 doctor 状态，不提交模型正文、凭据或原始事件。

## 场景与结果

通过真实 `AgentService` workspace resolver → `CoordinationService` → `ContextSessionAgent` → `HeadlessDriver`/`AcpDriver` 调用，不使用 mock driver。

1. `claude-coordinator` 使用 `claude --agents/--agent architect` 命名角色封装；PRD marker 为 `CLAUDE_CONTEXT_OK`。
2. `kimi-coordinator` 使用真实 `kimi acp`；调用前更新 PRD marker 为 `KIMI_CONTEXT_OK`，验证快照必须重建。

两轮均返回 `ok`、`current=true`，提议 summary 命中对应 marker，行动为只读 `wait`，来源引用当前 `prd.md`。两轮 `input_hash`、`snapshot_id`、`agent_session_id` 均不同；事件流没有 `workflow.node.*` 或 `agent.task.*`，PRD 未被协调 agent 修改，session doctor 为 true。

| agent | driver | proposal | configuration hash | session receipt |
|---|---|---|---|---|
| claude-coordinator | `headless:claude-coordinator` | `wait` | present | present |
| kimi-coordinator | `acp:kimi-coordinator` | `wait` | present | present |

## 边界

这证明真实 Claude 命名角色与真实 ACP agent 可以通过最新快照协调入口完成严格 JSON 提议和新鲜度隔离，不证明代码生成质量、异构盲评正确性、整条开发 Draft 已批准或代码已经合入。人工 gate 继续保持人工处理。
