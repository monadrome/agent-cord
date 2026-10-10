# ADR-0073 ｜ Agent 能力描述与严格启动控制

- 状态：accepted
- 日期：2026-10-10
- 关联：ADR-0027/0031（固定配置身份）、ADR-0055（宿主 Goal）、ADR-0063（原授权恢复）

## 决策

将 agent 能力识别作为 driver 原子能力。能力表区分适配器静态声明和 ACP 运行时协商，未探测不声称已安装、已认证或模型可用。`AgentDriver.capabilities` 可选，兼容外部实现；内置 driver 提供固定描述。工作区清单公开能力，不公开 argv、环境或角色正文。

启动维度分开：`kind`/显式前缀选择 ACP 或 headless；`launch.bare` 控制 CLI 的最小上下文；`launch.auto` 控制 CLI 自动审批；`launch.model/effort` 选择模型与推理强度；ACP 的 `launch.mode` 选择协议 session mode；`run.goal` 继续负责宿主交付生命周期。Goal 不依赖厂商是否有原生 goal 参数，不能以 auto 代替自测或完工审计。

显式选项必须应用，否则拒绝注册或在发送 prompt 前失败。headless 内置模板只接受已声明旋钮；自定义 argv 通过明确占位符映射 model/effort/resume，不进行 shell 拼接。ACP model/effort 要用 `option_ids` 明确映射到协议配置 ID；扩展配置使用 `config_options`，支持 select/boolean。不得根据 UX category 猜 ID。session/new/load 后核验 mode、选项值与设置回执；只读任务拒绝非 plan 的 mode，不能通过 auto 放宽只读。

有效启动参数、协议配置和原生恢复映射进入配置身份，env/凭据仍排除。自定义无恢复映射用 null，不再哈希一份实际无法恢复的 argv；旧自定义配置身份可能变化，冷恢复会保守重验而不冒称旧任务可复用。配置哈希变化会沿用已有恢复/审批失效机制。原生 resume 必须明确 session ID，ACP 检查 loadSession；不支持 resume 的自定义 argv 必须拒绝，不能悄悄开新会话。

固定工作流节点恢复在既有 Goal recovery 命令增加可选 `node_id` 约束：只允许请求 token 绑定的原授权未退出节点，保留 checkpoint、截止时间、尝试与 usage 预算、配置/源码身份和人工 gate。不得回滚已退出节点或把 CLI 会话 ID 作为工作流事实。任意历史节点 rewind 不在本能力的保证范围内。

## 验证

离线 fixture 验证实际 argv、ACP 协商/设置/拒绝路径、配置身份、只读、session resume 与固定节点恢复。全量测试、typecheck、build:all、diff 检查后提交。公开研究与人审指南说明已验证边界。
