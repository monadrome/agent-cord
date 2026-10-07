# 真实 Context Session Agent 接入验证

日期：2026-10-07。范围：本机 Codex CLI 0.160.0、现有登录环境、隔离临时 git 工作区；不是统计质量实验，也未验证全部 agent/provider。

## 场景与结果

两轮都经实际 AgentService registry → CoordinationService → ContextSessionAgent → HeadlessDriver.run 调用，没有 mock 或自定义替换 resolver。任务只读，超时 90 秒，模型使用本机当前配置，effort=low。第一轮 PRD 范围为 VERSION_A 的提议浏览；更新 PRD 后第二轮范围为 VERSION_B 的浏览与取消，不包含自动执行。

两轮均为 ok/current=true，提议 summary 分别包含 VERSION_A/B 的正确范围。两次 snapshot_id、input_hash 和 agent_session_id 不同；第二轮完成后重新查询第一轮得到 current=false。PRD 原文未被 worker 修改，没有 node/task 执行事实，没有人工采用或放行；session doctor=true。

| 指标 | VERSION_A | VERSION_B |
|---|---:|---:|
| 输入 token | 18814 | 18814 |
| 输出 token | 213 | 201 |
| 缓存输入 token | 4224 | 0 |
| 任务结果 | ok | ok |

这些用量来自 CLI 终态回执，未估算费用，未据此推导效率或质量收益。输入包含 CLI 自身上下文，不代表应用拼装包的单独 token 数。

## 实际发现与修复

初始两次调用都 failed/output，但模型已产生合法 JSON：CLI 把弃用配置通知放在 item.completed/error，旧 parser 将其作为正文拼接，破坏严格 JSON。修复将已知 error/warning item 标 metadata，顶层 turn.failed/error 仍保持失败；不使用 JSON 子串提取规避校验。补流级 thread ID 回执，更新被 CLI 忽略的 ask_for_approval 为官方当前 approval_policy，详见 ADR-0037。

官方来源：[OpenAI 审批与安全文档](https://developers.openai.com/codex/agent-approvals-security)，通过搜索并实际获取正文核验 approval_policy 与 read-only/never 组合。没有改写本机用户配置，其他配置通知保留在 driver raw/metadata，不写入协调产物。

## 可复用与限制

仓库 examples 提供 ACP、Claude Code 角色封装、Codex 配置及计划/人工审核 SDLC，离线 parser 回归覆盖配置、角色 JSON 和 gate。真实验证证明该本机 CLI 组合与严格协调协议可以闭环，不证明 Claude/ACP 已有真实模型验收，也不证明代码生成质量或整条真实开发流程已完成。

验收产物只保留在临时工作区：real-result.json、HTTP/浏览器结果与截图；不把实际会话数据或凭据提交为 fixture。后续应使用可公开的真实开发需求，验证计划 worker、独立评审与人工 gate 的完整链路。
