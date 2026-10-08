# ADR-0038 ｜ 只读 worker 的文本产物通道

- 状态：accepted（用户授权的原型功能）
- 日期：2026-10-07
- 关联：ADR-0023（NodeRunner）、ADR-0029（产物证据）、ADR-0030（恢复）、ADR-0036（文档边界）
- 来源：真实开发 SDLC 验证前对独立评审报告写回的审查

## 背景

readonly worker 返回完整报告时 coordinator 仍不写 artifact，后置门禁只能检查旧文件或占位。让评审 worker 获得写权限才能产报告，不符合只读评审角色。直接改变旧 readonly 行为又会覆盖原本声明为输入的 artifact。

## 备选方案

1. 所有 readonly 输出自动代写：破坏旧分析节点与输入文件语义。
2. 评审 worker 改为可写：权限扩展与任务职责无关。
3. 显式 run.output=text，coordinator 代写（选定）：worker 权限与产物通道分别声明。

## 决策

1. run 增可选 output（auto/text），缺省 auto 保持原行为：可写任务 agent 自写优先、文本回退；readonly 不写 artifact。text 必须有节点 artifact，非法定义加载失败，直接 NodeRunner 调用也在配置阶段失败。
2. text 模式提示 worker 在最终回复提供完整 Markdown，不自行写声明产物；readonly 继续传入 driver，任何报告写入由 coordinator 经共享文档 helper 完成。上游内容/最新 PRD/账本/版本 provenance 保持现有快照机制。
3. text 模式比较 artifact_before_hash 与派发后文件，观察到变化则保留现状并失败，不把 worker 文件通道冒充成功；完整有效文本才能原子代写，written_by=coordinator。空/占位/只有 metadata 或失败/取消结果不能产成功报告。
4. 语义输入 hash 将 text artifact 视为本节点输出，避免代写本身使 checkpoint 失效；复用仍要求 artifact_written 与完整 artifact_after_hash 一致。PRD、上游内容、账本、workflow/配置变化仍使未退出任务重跑，人工等待继续验证新版本。
5. 新任务事件在显式模式时记录 output。不新增自动判定权：报告内容存在/章节 gate 不证明结论正确，关键 gate 仍人工。真实开发 Draft 在隔离 worktree 保留，独立会话评审与宿主测试只提供人审依据，不自动合入。

## 理由（第一性原理推导）

- worker 的文件权限与宿主可接收的结果是两个维度，不能为保存报告而扩大模型权限。
- 从节点产物语义看，恢复必须区别输入与输出，否则当前结果会污染自己的新鲜度判定。
- 显式新通道可以演进工作流而保持已有分析节点行为。

## 被否方案的否决理由（逐一）

- 隐式代写：旧 readonly artifact 可能是被评审文档，不能覆盖。
- worker 可写：报告保存需要的是宿主接收文本，不需要让 worker 修改代码或事实文件。
- 文本直接放行：模型报告不能代替独立证据与人工授权。

## 关键实现注意点

- text 不改变取消、重试、事件存储失败或物理文件边界，观察到冲突必须失败并保留当前内容。
- Codex 没有显式最终字符串的流仍可使用内容通道 fallback；metadata 与明确空最终结果保持既有语义。
- 同模型新会话评审只证明会话独立，不等价于异构盲评或统计质量收益。
- 真实人工 gate 保持挂起，开发 Draft 不自动提交、推送或合入生产分支。

## 证据来源

1. coordinator.settleArtifact 的 readonly 返回与 context-pack 输出条件。
2. checkpoint 文档输入过滤和 artifact 后态校验。
3. examples 的计划/报告 gate 与现有参数化文件 checker。
