# Agent 启动能力：调研、配置与 Human Review 指南

## 判断

默认按 Goal 交付代码、自测证据和人审指南符合当前项目方向：一次模型调用结束不足以代表交付，宿主验证与失败修复能减少正常路径中的人工调度。Goal 是平台生命周期，不应依赖 ACP 或某家 CLI 的同名开关。最终 review、关键 gate、合入与发布仍人工完成。

能力识别和启动控制也应是底层原子能力。原实现会忽略不支持的旋钮，ACP 不能统一选择模型，自定义 wrapper 的 resume 可能退化为新会话；这些行为会让上层 Goal 和恢复无法可靠绑定实际执行配置。此次实现先解决这些可验证缺口，保留各厂商能力差异。

## 调研证据

- [Claude CLI reference](https://code.claude.com/docs/en/cli-reference)：bare、permission-mode、model/effort 和角色控制。2026-10-10 本机 `claude --help`/`--version` 核验版本 2.1.220、bare 与 auto。bare 会跳过 CLAUDE.md 自动发现和部分定制加载，本机说明认证严格使用 API key/apiKeyHelper，因此没有默认启用。
- [OpenAI Docs CLI reference](https://developers.openai.com/codex/cli/reference)：exec、显式 resume、模型与配置覆盖。本机 codex-cli 0.160.0 help 核验对应命令。Codex exec 原有无人值守 sandbox/approval 参数保留；没有把 Claude auto 或 bare 翻译成 Codex 的同名能力。
- [ACP config options](https://agentclientprotocol.com/protocol/session-config-options)：配置 ID/允许值、完整 currentValue 回执、boolean 能力协商；category 仅用于 UX，不能作为正确性必需条件。因此使用明确 option_ids，不猜类别映射。
- 已安装 `@agentclientprotocol/sdk` 1.5.0 的类型契约核验 loadSession、session mode、select/grouped select/boolean 结构和扩展响应。通过 Firecrawl 获取公开文档；未进行付费模型调用。

## 配置

工作区 `cord/agents.yaml` 示例：

```yaml
agents:
  writer:
    kind: headless
    template: claude
    launch:
      model: sonnet
      effort: high
      auto: true
      max_turns: 12
      budget_usd: 3
  protocol-worker:
    kind: acp
    bin: your-acp-wrapper
    args: [acp]
    launch:
      model: your-model-id
      effort: high
      option_ids: {model: llm, effort: thinking}
      mode: code
      config_options: {extended: true}
  custom:
    kind: headless
    bin: your-wrapper
    args: [run, --model, '{{model}}', --effort, '{{effort}}', '{{prompt}}']
    resume_args: [resume, '{{resume_session_id}}', --model, '{{model}}', --effort, '{{effort}}', '{{prompt}}']
    launch: {model: your-model-id, effort: high}
```

ACP 的 ID、mode 和值均为示例，必须以实际 session 协商为准。`launch.bare: true` 仅当前 Claude 模板支持，明确承担上下文/认证加载差异后再开启。旧顶层模板旋钮仍接受；与 launch 重复且值不一致时拒绝。自定义参数只能使用已映射的占位符，完整 resume_args 不继承 args。参数直接传给 subprocess，不经 shell；替换一次，不展开 prompt 内的占位文本。

Goal 在 SDLC 的 `run.goal` 中声明，包含宿主检查、输入、review 产物和预算。不要将 `launch.auto` 当作 Goal 开关。ACP auto 类行为必须选择实际协商的 mode 或配置；文件预授权仍使用已有 permission_policy。

## 查询与恢复

1. `GET /api/v1/agents`：查看静态能力和配置身份，installation=unchecked。
2. `POST /api/v1/agents/:name/inspect`，body `{}`、Idempotency-Key：ACP 创建临时 session 并核验配置，返回 protocol_version、native_resume、mode、配置 ID/类型和模型/effort 候选。没有 prompt；工具权限请求/工具报告一律拒绝，不使用 worker 预授权。初始化行为由外部适配器负责。headless observation=null，仅静态声明。
3. 修改配置后 `POST /api/v1/agents/reload`，使用新的幂等键；新 run 用新 resolver，在途 run 保持原配置。查询返回其自身 revision/hash，调用方需与当前清单比较。
4. 原生 CLI session：库的 `driver.resume(explicit_session_id, task)`。ACP 未声明 loadSession、自定义没有完整 resume_args、空 session ID 均拒绝，不静默用最新会话。
5. 固定 workflow 节点：读取 `GET /api/v1/runs/:run_id/goal-recovery`，用返回 token 提交 `{input_hash, node_id}` 到同 URL 的 POST。只能指定返回的原授权未退出节点，保留预算和 checkpoint；不能迁移到另一个节点或回滚已退出事实。

## Human Review

优先检查 `src/driver/launch.ts`、`headless.ts`、`custom-template.ts` 和 `acp.ts`：unsupported/重复配置、实际 argv、readonly、配置回执重置和 resume 映射。再检查 `AgentService.inspect` 的固定 revision/hash、无 prompt/有限投影，以及 `RunService.recoverGoalOnce` 的首次与重放节点约束。

验证入口是 `tests/driver/launch.test.ts`、`apps/server/tests/agent-registry.test.ts` 和 `goal-retry.test.ts`。离线 fixture 实际启动 subprocess，覆盖 grouped/boolean 配置、未知 ID/值/类型、拒绝/忽略/后续重置配置、readonly、resume 和 no-prompt inspect；真实 TCP HTTP 验证查询、幂等重放与错误，固定节点恢复验证不新增人工终审或授权预算。

限制：静态模板能力不代表当前 CLI/凭据/模型权限/额度已验证；ACP 握手也不证明模型可调用或业务结果正确。命令/配置的外部副作用不由这一层隔离。任意历史节点 rewind、原生 turn checkpoint/fork、provider 路由、工具/MCP/网络与 worktree 还需各适配器明确实现，不能用 prompt 承诺代替。

最终验证：`npm test` 1181 项 / 81 文件、`npm run typecheck`、`npm run build:all`、`git diff --check` 通过；相关文档 100 项本地链接无缺失。隔离预览实际 TCP HTTP 的健康、能力清单与 ACP inspect 均 200，同键重放结果一致；原真实 Draft 未操作。
