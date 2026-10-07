# ADR-0029 ｜ 最新账本门禁与当前产物证据

- 状态：accepted（已实现）
- 日期：2026-10-06
- 关联：ADR-0020（事件事实来源）、ADR-0023（artifact 双通道）、ADR-0028（最新快照与失败恢复）
- 来源：SDLC 门禁与 worker 产物溯源审查

## 背景

协调器已从事件构建最新快照，但 ledger gate 仍读取可能滞后的磁盘投影，且把 conflicted confirmed 条目视为放行证据。artifact 校验则把执行前已有的非空文档归为当前 agent 自写，新返回文本不会更新旧文档，空输出也可能因为旧文件存在而放行。

## 备选方案

1. 保持旧投影和文件存在判定：成本低，但无法证明当前任务基于有效共识并交付了产物。
2. 所有节点前清空 artifact：会删除人工草稿与失败恢复证据，否决。
3. 最新事件投影 + artifact 前后内容指纹（选定）：复用 reducer 获取 gate 的最新状态，以派发快照中的文件 hash 为当前尝试基线。

## 决策

1. `ledger-has-confirmed` 有 session 时读取当前事件并调用纯 reducer；没有 session 的默认目录读取使用 events.jsonl 严格解析并投影。不写 ledger.yaml，事件不可读或格式错误不回退旧账本。
2. 只有 confirmed 且 conflict=false 的条目可作为证据；传入 entry_id 必须合法，否则 block。显式注入的 readLedger adapter 继续支持，由宿主负责提供最新投影，返回值仍经 schema 验证。
3. 当前尝试记录 artifact_before_hash；结束后记录 artifact_after_hash 和 artifact_changed。文件在派发后发生可观察内容变化且内容有效时，沿用 written_by=agent；它表示在 worker 运行区间观察到文件变化，不保证操作系统写者身份。
4. artifact 内容未变化时不能记为 agent 自写；返回完整非空文本则 coordinator 代写 draft。声明可写 artifact 却没有新内容与最终文本时，以 failed/artifact 结束，不用旧文件或占位文档冒充产物。readonly 节点不代写、不要求新产物。
5. 代写前与临时文件替换前再次比较预期 hash。观测到目标已变化或被删除时，保留现状并记不可重试的 artifact 失败；若观测到变化后的内容不合法，也不覆盖它。
6. 失败事件继续使用 ADR-0028 的 failure_stage/retryable；新增前后 hash 与 changed 字段均可选，旧事件保持可读。修复后重启节点重新生成快照。
7. driver 保留明确的空最终字符串；null 仅表示未提供最终文本。已识别的初始化、协议进度、思考、用户回声等辅助文本标记 `TextEventData.channel=metadata`，仍保留原始事件，coordinator 不把它们拼入 fallback 产物。

## 理由（第一性原理推导）

- 门禁证据应是当前共识状态，投影副本滞后不能改变事件已发生的推翻事实。
- 冲突表示结论不能自动择胜，不能被 confirmed 字面值覆盖。
- 文件存在只能证明过去有产物；前后指纹与当前返回文本才能解释当前任务的贡献。
- 产物是 living 文档，保护人工草稿与并发编辑比盲目覆盖更重要。

## 被否方案的否决理由（逐一）

- 旧账本：会让被推翻或冲突的结论继续参与放行。
- 清空旧产物：破坏上下文和恢复证据。
- 旧文件非空即本次成功：伪造当前 worker 的写回来源。

## 关键实现注意点

- 前后 hash 使用完整 UTF-8 内容，不使用 prompt 截断内容；空文件与不存在分别用 hash 与 null 表示。
- 内容比较是乐观检查，不是操作系统级 compare-and-swap；检查与 rename 间的外部恶意替换仍需宿主权限和后续跨进程 lease。
- 同内容的再生成可经完整最终文本走 coordinator draft 通道；仅报空结果且文档内容完全未变，无法证明本次产出，按失败处理。
- 测试覆盖新确认/推翻/冲突、坏事件与读取恢复、旧 artifact 更新、空输出、运行中有效写入和冲突保留。

## 证据来源

1. `workflow/checkers.ts` 的 readLedger 与 confirmed 过滤逻辑。
2. `coordinator/coordinator.ts` 的非空文件写者归因与 `snapshot.ts` 的完整内容指纹。
3. ADR-0020 / ADR-0028 的事件权威、冲突与失败恢复承诺。
