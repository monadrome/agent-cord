# 真实源码绑定的 Context Session Agent 验收

日期：2026-10-08。范围是本机 Claude Code 2.1.220 命名角色与独立临时 git 工作区，使用现有认证、只读协调和 120 秒预算。没有采用提议或批准 gate；运行数据、会话 ID 和模型正文不提交为 fixture。

## 场景

流程的验证 checker 声明 `inputs: [src]`。通过真实 AgentService → CoordinationService → ContextSessionAgent → HeadlessDriver 调用 Claude 的 architect 命名角色。PRD 保持相同，要求仅返回 `SOURCE_CONTEXT` 的严格 JSON wait 提议。

第一次调用针对 source_version=1；宿主只将 src/draft.ts 改为 source_version=2，再调用同一 agent 和发布版本。

## 结果

- 两次均 ok/current=true，返回有效 wait 提议，包含要求的 PRD marker。
- 源码改变后再次查询旧轮次得到 current=false；新轮次的 source_hash 和 input_hash 均不同，会话 ID 也不同。
- PRD 原文不变，源码只由宿主修改；轮次事件保存摘要而非源码正文。
- 无 workflow 或 agent.task 执行事件，无 human.decision.recorded，session doctor=true。

## 限制

本次证明真实角色封装与源码输入身份可通过协调入口贯通，不证明模型理解了全部代码、测试通过或异构评审质量。协调者保持只读提议权限；源码范围完整性由流程作者负责。未声明范围仍采用文档/配置输入语义。
