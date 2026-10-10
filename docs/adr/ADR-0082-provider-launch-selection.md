# ADR-0082 ｜ Provider 作为显式 Agent 启动能力

- 状态：accepted（实现中）
- 日期：2026-10-10
- 关联：ADR-0073（严格启动能力）、ADR-0075（ACP 启动状态一致性）、ADR-0080（自定义 headless 参数映射）

## 决策

启动配置增加可选 `provider`，与 `model`、`effort` 同属显式 LLM 路由维度。它只有在适配器声明并实际映射时才有效：ACP 必须提供 `option_ids.provider`，在 session 配置候选与每次设置回执中核验；自定义 headless 必须在完整 argv 分支使用 `{{provider}}`；内置 CLI 未声明 provider 时拒绝配置。缺少映射、候选不存在、类型改变或后续回执漂移均在 prompt 前或执行中 fail-closed。

所有声明 provider 的新会话/恢复/只读分支须保持映射一致，并进入 configuration_hash、任务输入身份与协调 Agent 上下文。provider 不等价于 model，不从环境变量、模型名称、CLI 默认值或 prompt 推断。未声明 provider 的旧配置保持原身份与行为。

只读 ACP 仍可选择 provider，但不能因此放宽 mode、工具或权限策略；headless provider 参数也不提供 OS 隔离或凭据验证。provider 路由不改变 Goal 的宿主生命周期、验证与人工 gate；跨 provider 的质量/费用证明仍由实际运行与宿主证据提供。

## 验证

覆盖 ACP provider option ID/值/类型/回执漂移、自定义四分支 argv 与遗漏映射拒绝、内置 CLI 不支持配置、配置 hash/协调快照绑定和实际无 prompt inspect。使用确定性 fixture，不调用付费模型。
