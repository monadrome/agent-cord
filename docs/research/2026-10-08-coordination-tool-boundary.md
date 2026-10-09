# 独立协调工具边界调研与验收

日期：2026-10-08。阶段 36。目标是让仅分析最新快照的 Context Session Agent 在自定义 ACP/headless driver 报告工具行为时有宿主拒绝边界。

## 设计审查

按 agent-optimizer 的上下文、任务边界和外部验证原则审查：独立协调 prompt 禁止工具，但消费者只处理 text/result/error。忽略 tool_use 允许读事件流、旧会话或任意未采集文档的模型返回合法 Draft，违反 ADR-0032 的角色约定。readonly 与没有工具是不同约束，不能用只读 CLI 模式代替宿主判断。

## 外部参考

- Anthropic [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)：workflow 的工具和模型调用由预定义代码路径编排，角色边界与实际工具接口需明确，并用隔离环境验证。本文为架构参照，不是 agent-cord 的行为测试或防护保证。
- ACP [Tool Calls](https://agentclientprotocol.com/protocol/v1/tool-calls)：agent 通过 session/update 报告工具调用与更新，执行发生在 agent 内部；权限请求是 MAY，并非每次执行之前的强制拦截点。pending/in_progress/completed 都是工具行为事实。因此宿主必须拒绝工具通知对应的协调结果，不能声称拦截所有外部执行。首次读取 `/protocol/session-updates` 实际返回 404，未当作协议证据。

## 改进与验证计划

ADR-0050：任意工具事件触发 AbortSignal 与迭代器关闭，轮次保存 failed/driver，不保存工具负载；结果先到达也不能接受随后出现工具通知的轮次。策略绑定输入身份，使旧策略提议不可继续采用。

先用离线反例覆盖正常工具、未知/空负载、result 后工具、清理异常和历史身份，再校验真实 headless/ACP 子进程回收、REST 不可采用、重启不重放和修复后新轮次可恢复。真实 Draft gate 保持人工未决。

## 边界

事件驱动的拒绝不能撤销工具通知前已经发生的副作用，也不认证第三方 driver 的报告完整性。原始网页、运行目录、模型输出和截图只保存到临时目录，不提交仓库。

## 实际验收

11 个协调核心/REST 反例全部先复现；定向回归另外发现 ACP 的 abort 后立即 return 会抢在 session/cancel 发送前杀进程，新增 driver 反例先复现再修复。工具违规保留固定失败原因，工具参数与清理异常不落事实；普通 worker 的工具测试仍通过。

最终全量 807 测试 / 62 文件、build:all/typecheck 通过。隔离 git 工作区真实 HTTP 验证 headless/ACP 工具后静默调用立即 failed/driver、采用 409、进程与孙进程回收，ACP 收到一次 session/cancel。重启保留失败事实，不重放调用。

更新 PRD 为 B 后，真实 Claude architect 封装仅调用一次、工具数 0，返回包含最新 B 标记的 wait Draft，来源仅 prd.md；人工 gate 仍待审。首次启动即刻查询短暂 current=false，复查同一原轮次恢复 true，input_hash 不变、审批 ID 不变，不重复调用模型。事实链检查通过，刷新可重建 ledger 后 doctor=true。worker、人工决定、节点退出、采用与用户取消均为 0。

Playwright/本机 Chrome 的 1440/390/320 宽度验证两种失败详情无提议或采用按钮、固定原因完整展示、正文边界与文档来源跳转正常，无横向溢出/pageerror。桌面/手机截图已查看，无内容重叠。预览：`http://127.0.0.1:7313/#/requirements/REQ-ROLE-BOUNDARY/coordination`。临时运行证据不入库。
