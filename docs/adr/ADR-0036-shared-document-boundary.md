# ADR-0036 ｜ 文件证据与快照文档的共享访问边界

- 状态：accepted（用户授权的原型优化）
- 日期：2026-10-07
- 关联：ADR-0024（文件 checker）、ADR-0028/0029（文档边界）、ADR-0021（REST）、ADR-0035（写操作结果）
- 来源：持续 SDLC 优化与文件 checker/REST 的物理路径审查

## 背景

coordinator 已拒绝链接、管理路径与非普通文件，但 checker 只做词法校验并跟随链接，REST 也可读写链接目标。readDoc 把所有 IO 故障当 404，console 将其视为尚未生成，可能尝试覆盖旧文档。writeDoc 直接截断写入，失败时不能保留原文件。

## 备选方案

1. checker 与 REST 分别复制 coordinator 逻辑：三份边界迟早漂移。
2. 所有存在性检查读取完整正文：浪费资源，不能明确表达元信息检查。
3. 提升共享 core/session-files helper（选定）：统一普通文档路径、元信息、读取与原子写入，保持 coordinator 原导入兼容。

## 决策

1. 将已有 session-files 提升为 core 共享能力，导出 readSessionDocument、statSessionDocument、writeSessionDocument 与错误类型。coordinator 原文件保留 re-export，快照/写回行为继承同一边界。
2. 路径必须是规范相对路径；拒绝绝对、Windows/反斜杠、空段、点段、NUL、events.jsonl/ledger.yaml/agents.yaml 及 .git/.index/.sdlc（不区分大小写）。路径段不允许符号链接，叶文件必须普通且 nlink=1；session 目录本身不能是符号链接或非目录。缺失叶文件合法，错误父目录不可伪装缺失。
3. file-exists 从 no-follow 描述符读取元信息，不加载全文；file-nonempty/doc-has-section 从同一 helper 读取 UTF-8，任何不可验证错误 block，不返回有效证据锚点。修复普通文件后同 gate 可重新求值。
4. REST read/write/detail 的文档可用性用同一 helper。readDoc 真缺失为 404，SessionFileError 为 409，其他 IO 故障为 500；不把故障当未生成。详情可用性不把非法文件显示为可用。写回独占临时文件、fsync、rename，失败保留旧文件并清理临时文件，错误不回传文档内容。
5. 现有 HTTP 输入类型和状态机不变；写命令保留统一幂等生命周期，IO 失败属未知请求结果，核验状态后用新键提交新操作，不能盲目复用副作用。
6. 提供可复用 ACP/Claude 角色封装/Codex 注册与 agent SDLC 示例，使用结构化 parser 验证；示例不含凭据，不自动合入或批准关键 gate。真实 CLI 验收在临时工作区有界执行，日志只记录公开身份、快照/提议与状态，失败和外部依赖限制如实说明。

## 理由（第一性原理推导）

- 放行依据必须与快照文件的所有权边界一致，否则读者可以引用协调器不会接受的材料。
- 缺失和无法读取是不同事实，错误分类直接影响编辑与恢复行为。
- living 文档允许人修改，但保存失败不应损坏旧内容。

## 被否方案的否决理由（逐一）

- 复制边界：重复约束难以共同演进与验证。
- 全文存在性检查：检查对象是文件类型和身份，无需读取全部数据。
- 只靠 prompt 禁止越界：程序读写已具备可验证边界，不能退回模型自觉。

## 关键实现注意点

- 便携 Node API 的 no-follow 只强制最终文件，父目录检查不是 OS 沙箱或跨进程强事务；不宣称防御所有检查后父目录替换攻击。
- 系统级祖先路径别名（macOS /tmp → /private/tmp）不属于 session 内链接，保持支持。
- 不用文档 helper 读事实流或账本投影；这些仍经各自 EventStore/reducer 端口。
- 离线测试覆盖链接/硬链接/目录/保留文件/读取 IO/原子替换失败，真实 CLI 成功不能替代失败与恢复回归。

## 证据来源

1. coordinator/session-files 与已有真实文件测试。
2. workflow/checkers 的 stat/readFile 和 SessionService 的直接读写。
3. DocsTab 的 404 新文档回退和统一写请求生命周期。
