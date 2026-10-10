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

设置顺序是 mode → provider → 按ID排序的扩展 → model → effort，逐步使用最新完整回执。新provider解锁的模型/扩展在切换后校验；后续设置反向重置provider时仍拒绝，不自动来回调整。首次/原生恢复/无prompt inspect共用同一策略。明确provider配置的新hash绑定`explicit-session-selections.provider-first.v1`，旧provider checkpoint/审批/协调需重新核验；未声明provider保持原顺序与身份，见 [ADR-0083](../adr/ADR-0083-provider-configuration-order.md)。

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
- 运行 [provider-launch.test.ts](../../tests/driver/provider-launch.test.ts) 的真实四分支argv、缺映射、路由依赖/回执拒绝、显式session恢复与无prompt查询，以及 [launch.test.ts](../../tests/driver/launch.test.ts) 的运行漂移。
- 运行 [provider-delivery.test.ts](../../apps/server/tests/provider-delivery.test.ts) 的真实TCP Goal自动修复/宿主自测/冷恢复、查询幂等、worker路由改变使旧提议失效与最新PRD协调。cold原run用剩余预算重新验证，不重授预算或自动记录人工决定。

Provider 选择只绑定启动身份，不证明 CLI 安装、凭据、额度、网络、模型质量或 OS 隔离。Goal 宿主验证、只读工具审计和最终人工 gate 继续独立生效。验收使用确定性 ACP/headless fixture，不调用真实 LLM。

## 实际验收

阶段70的隔离HTTP流程实际执行两次anthropic/large/high调用，宿主检查先失败再通过，review.md含宿主验证与源码变更证据，审批1、人工决定0、节点退出0、doctor通过。PRD更新后历史ready为current=false/stale_input；新协调current=true仅说明它基于最新快照提出wait，不能放行旧交付。

控制台 `/#/agents` 搜索 `provider-coordinator`，展开能力后可查看“模型路由”，显式查询返回provider候选 `openai / anthropic`。类别未声明仍由配置ID明确映射，安装/模型访问保持未核验。桌面与移动截图及最终验证记录见 [progress.md](../../progress.md)，临时证据为`/tmp/cord-stage70-real-result.json`与`/tmp/cord-stage70-browser-result.json`，不入仓库。
