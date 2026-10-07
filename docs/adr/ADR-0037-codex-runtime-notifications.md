# ADR-0037 ｜ Codex 非终态通知与会话身份回执

- 状态：accepted（真实 CLI 验收驱动的修复）
- 日期：2026-10-07
- 关联：ADR-0011（headless）、ADR-0029（辅助输出）、ADR-0031（启动身份）、ADR-0032（协调提议）
- 来源：Codex CLI 0.160.0 真实协调调用与规范化输出诊断

## 背景

两次真实调用都返回了合法提议和用量，但 item.completed 的 error 条目携带非终态的配置通知，parser 把整个事件当正文拼接，导致严格 JSON 校验失败。终态 turn.completed 没有 thread_id，driver 又没有维护 thread.started 的回执，最终 agent_session_id 丢失。现有 Codex 模板的 ask_for_approval 配置已被本机 CLI 忽略。

## 备选方案

1. 从混合文本寻找 JSON 子串：可能把多个结论择一，削弱严格结果边界。
2. 把每个 error item 当任务失败：非终态通知会使合法任务失败。
3. 区分终态与辅助通知，保留会话回执（选定）：已知辅助 item 标 metadata，终态错误仍 failed；模板使用官方当前审批配置。

## 决策

1. Codex item.* 中 error/warning 类型属于辅助通知，保留 raw 与通知正文并标 TextEventData.channel=metadata，不参与协调 JSON 或 worker 文档 fallback。顶层 error/turn.failed/is_error 仍映射 error，不静默成功；其它未知文本维持已有兼容行为。
2. HeadlessDriver 每次 execute 保存当次会话回执（初始化/线程开始或显式结果），为后续 result/error 的统一 session_id 槽位和 data 回填。新 run 不共享上次身份，resume 初始化使用请求身份，CLI 明确回执优先。协调仍每轮 run，不改成长会话。
3. Codex 模板改用 `approval_policy="never"`，保留 readonly 对应 read-only/可写对应 workspace-write，不提升 OS 权限；配置身份随实际参数更新，使未退出任务重新核验。
4. 使用标准事件解析与现有 strict JSON 校验，不添加子串提取或 fence 回退。真实回归保存失败阶段、来源和用量，重新调用证明 VERSION_A/B 使用不同 session 和输入 hash；测试默认离线。

## 理由（第一性原理推导）

- 任务成功与通知不是同一事实，辅助内容不能成为产物或破坏结果解析。
- 会话身份是流级回执，终态未重复字段不代表没有身份。
- 配置被 CLI 忽略时不能声称审批策略已生效，需核验真实参数与官方契约。

## 被否方案的否决理由（逐一）

- JSON 子串：隐藏混合/多结果问题，不能证明模型提供了单一合法提议。
- error item 一律失败：真实证据显示任务仍 end_turn 且合法输出。
- 清空用户配置：擅自影响工作区以外设置，不能用于修复本项目的协议映射。

## 关键实现注意点

- 通知识别按结构化 item 类型，不依赖消息内容或英文错误措辞。
- 不写入用户 Codex 配置，当前环境其它配置通知保留但不当正文。
- CLI 的外部配置/模型变化仍不属于 agent 配置身份覆盖范围；两轮成功不等价于统计质量评估。

## 证据来源

1. 两次真实 Codex 0.160.0 规范化流：error item 配置通知、agent_message 合法 JSON、turn.completed 用量。
2. [官方审批与安全文档](https://developers.openai.com/codex/agent-approvals-security)：approval_policy 与非交互 never 组合。
3. 本机 codex --help / exec --help 与现有 driver fixture。
