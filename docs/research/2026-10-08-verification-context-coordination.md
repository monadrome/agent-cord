# 真实机器验证观察与协调提议验收

日期：2026-10-08。范围：独立临时 git 工作区、本机 Claude Code 2.1.220 architect 角色、新会话协调、120 秒预算。未采用提议、未批准 gate、未合入代码。

## 实际链路

宿主执行 `node --test tests/math.test.mjs`，验证临时函数的加法语义。初始实现相减，真实退出码 1；修复成相加后重新取得验证上下文再执行，真实退出码 0。状态、退出码和输出摘要通过幂等 REST 写入当前 run。

每次记录后经 AgentService → CoordinationService → ContextSessionAgent → 真实 Claude 命名角色调用。两次均得到 ok/current=true 的严格 wait 提议，summary 分别包含 failed/passed，并引用对应当前 verification event_id。新测试结果与源码变化后旧轮次 current=false；协调轮次只保存观察摘要，宿主测试日志没有注入模型。

原 intake 人工审批 ID 保持不变，human.decision=0，没有 worker 派发和节点退出；PRD 原文不变、session doctor=true。机器通过不替代人工 gate。

## 失败与恢复

第一轮真实调用因模型引用 workflow/human-intake 而 failed/output：该值是 gate.id，不是 node.id。严格验证正确拒绝；prompt 补充 node ID 的明确白名单，验收 PRD 要求单个验证来源后在新工作区重跑。没有提取 JSON 子串或放宽来源校验来隐藏失败。

## 浏览器

缓存 Playwright 与本机 Chrome 验证 1440/390/320 宽度无横向溢出，pageerror=0。验证来源链接导航到事件视图并展开对应 passed 结果；桌面和手机截图经查看确认无内容重叠。

## 限制

该验收证明结构化结果可被真实协调者引用，不证明模型判断质量、异构评审或外部 CI 身份认证。观察依赖受信宿主、输入范围完整性；缺失/过期或不可读结果不能成为当前有效来源。事件流与截图、模型结果正文仅留在临时验收目录。
