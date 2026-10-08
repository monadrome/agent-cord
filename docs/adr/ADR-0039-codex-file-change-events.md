# ADR-0039 ｜ Codex 文件变更事件保持工具语义

- 状态：accepted（真实开发 Draft 验收驱动的修复）
- 日期：2026-10-07
- 关联：ADR-0037（CLI 通知）、ADR-0029（正文通道）、ADR-0038（报告通道）
- 来源：Codex CLI 0.160.0 在隔离开发工作区的文件变更事件

## 背景

真实实现 worker 发出 item.started/completed，item.type=file_change，payload 含 changes 与 status。现有 parser 仅识别 tool/command/function_call/patch，将 file_change 原始 JSON 当正文，污染失败摘要，也可能污染最终文本 fallback。相同运行还触及共享 node_modules 的 Vite 临时缓存写限制，超时后任务保持失败，不能拿部分文件伪装 completion。

## 备选方案

1. 将所有未知 item 当 metadata：可能丢弃自定义 CLI 的正文。
2. 从最后文本抽取报告：隐藏协议映射问题和混合输出。
3. 按明确 file_change 类型映射工具事件（选定）：保留粒度，不把文件操作当报告内容。

## 决策

1. item.type=file_change 映射 AgentEvent.tool_use，name=file_change、input=changes，raw 保留状态/原文；started/completed 均按此规则。现有文本、通知和顶层失败语义保持不变。
2. coordinator 的正文汇总不接收 tool_use，不通过 substring 或末段提取绕过正文校验。文件结果仍由 artifact 前后 hash 判定，工具通知不证明文件写入成功。
3. 真实超时留 task timeout 与现有 Draft，先核验进程终态和宿主测试，再用更新后的需求快照恢复未退出节点；不手工追加 ok/exited 或消费人工 gate。

## 理由（第一性原理推导）

- 文件操作描述与最终报告是不同数据，协议角色必须在 parser 层表达。
- 工具成功状态不能代替文件证据，部分产物也不能替代任务终态。
- 恢复应基于可观察事实，而不是假定调用已经成功。

## 被否方案的否决理由（逐一）

- 未知全过滤：破坏已有自定义 driver 兼容边界。
- 最后一段提取：格式巧合不能证明完整结果。
- 直接标成功：绕过事件/产物新鲜度与后置 gate。

## 关键实现注意点

- 共享依赖写缓存限制是 sandbox 的实际约束，不移除只读权限。需要时使用 Vite 支持的 configLoader=runner，并明确记录原命令的失败与替代验证。
- 全库 HTTP 测试在 sandbox 内可能因 listen 权限被拒，宿主独立执行；不把环境失败当作功能失败或反过来。
- Draft 保持在独立检出，不自动合入。

## 证据来源

1. 真实 worker 的 file_change/changes/status 事件。
2. 原 parser 的类型识别与 coordinator 的 tool_use/metadata 分流。
3. 超时事实、57 个新增目标测试的宿主实际输出。
