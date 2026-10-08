# 真实 Agent Driver 接入冒烟验证

日期：2026-10-08。范围是本机已安装并完成认证的 Claude Code 2.1.220 与 Kimi Code 2.1.1；调用使用临时工作目录、只读任务和 120 秒预算，不把模型正文、凭据、原始事件或会话 ID 写入仓库。

## 结果

- `headless:claude`：返回预期终态 `CLAUDE_SMOKE_OK`，无 error 事件；回执包含 Claude session ID。
- `headless:claude-architect`：从 `examples/agents.yaml` 加载角色定义，实际 argv 包含 `--agents`、`--agent architect`、`--permission-mode plan` 和只读工具白名单，返回预期终态 `CLAUDE_ROLE_SMOKE_OK`，无 error 事件。
- `acp:kimi-acp`：通过真实 `kimi acp` 完成 initialize → session/new → session/prompt，返回预期终态 `KIMI_SMOKE_OK`，无 error 事件；每个输出事件与终态均带同一 session 回执。

## 修复

真实 ACP 冒烟发现原实现只在终态 data 中保留 session ID，`AgentEvent.session_id` 顶层没有统一回填，宿主无法可靠取回恢复身份。`AcpDriver` 现在在会话建立后对通知、工具、权限、错误和终态统一补齐顶层回执，并保持 `result`/`error` data 的兼容字段。握手或建会话前失败仍允许没有 session ID。

离线 ACP 回归覆盖回执、权限、超时、取消、加载恢复和进程清理；真实调用仅证明本机 CLI/认证组合可用，不代表其他 provider、模型质量或异构评审已完成验证。
