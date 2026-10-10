# Provider 启动选择：配置与 Human Review 指南

## 契约

`provider` 是独立的 LLM 路由字段，与 `model`、`effort` 分开记录。它不从模型名字、环境变量或 prompt 推断。

ACP 示例：

```yaml
kind: acp
bin: your-acp-wrapper
launch:
  provider: anthropic
  model: claude-sonnet
  effort: high
  option_ids:
    provider: provider
    model: llm
    effort: thinking
```

`provider` 和 ID/value 只是形态示例，必须来自该 ACP session 的 `configOptions`。没有 `option_ids.provider`、候选值不匹配、设置回执忽略或后续 `config_option_update` 漂移，driver 会在 prompt 前或执行中取消。

自定义 headless 使用 `{{provider}}`：

```yaml
args: [run, --provider, '{{provider}}', --model, '{{model}}', --effort, '{{effort}}', '{{prompt}}']
resume_args: [resume, '{{resume_session_id}}', --provider, '{{provider}}', --model, '{{model}}', --effort, '{{effort}}', '{{prompt}}']
launch: {provider: anthropic, model: model-id, effort: high}
```

如果同时提供只读分支，四种完整 argv 都必须保留 provider/model/effort 映射。内置 Claude、Codex、Kimi 模板没有统一 provider 参数，显式配置会拒绝注册，不能静默忽略。

## Human Review

- 检查 [launch.ts](../../src/driver/launch.ts) 的严格 provider schema 与 `option_ids.provider`。
- 检查 [acp-launch.ts](../../src/driver/acp-launch.ts) 的候选、设置回执和漂移重检，确认 provider 与 model/effort 使用同一 session 状态。
- 检查 [custom-template.ts](../../src/driver/custom-template.ts) 四分支一致性和单次 argv 替换；检查 [headless.ts](../../src/driver/headless.ts) 内置模板拒绝未声明 provider。
- 运行 [launch.test.ts](../../tests/driver/launch.test.ts) 的 provider 成功、缺 ID、漂移和 custom argv 用例；再执行完整测试、typecheck、build。

Provider 选择只绑定启动身份，不证明 CLI 安装、凭据、额度、网络、模型质量或 OS 隔离。Goal 宿主验证、只读工具审计和最终人工 gate 继续独立生效。验收使用确定性 ACP/headless fixture，不调用真实 LLM。
