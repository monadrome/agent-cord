# ADR-0042 ｜ 只读 worker 的源码输入与恢复新鲜度

- 状态：accepted（实现选型）
- 日期：2026-10-08
- 关联：ADR-0030（checkpoint）、ADR-0038（只读报告）、ADR-0041（声明源码输入）
- 来源：阶段 28 的 worker 与 gate 输入身份审查

## 背景

声明源码范围已使旧测试结果和审批失效，但 NodeRunner 的 execution_input_hash 不包含源码。源码变更后恢复可能跳过评审 worker，留下针对旧代码生成的报告。

## 备选方案

- 每次恢复都调用 worker：使完全相同的输入也重复调用，失去 checkpoint 的用途。
- 将工作区 IO 放进核心纯 hash 函数：破坏确定性边界并绑定 server 的范围配置。
- 宿主注入源码摘要读取函数，协调器负责生命周期绑定与重检：复用既有扫描边界，保持库的可扩展性。

## 决策

CoordinatorOptions 增加可选 read_source_hash(node) 钩子。server 对 readonly worker 从 verification-passed.with.inputs 的节点并集获取源码摘要，可写 worker 返回 null。库宿主可显式提供自己的可靠摘要函数。

派发时摘要纳入 execution_input_hash，并记录 agent.task.started/completed.source_hash。绑定源码的身份使用 v3 域；未绑定保留 v2 兼容身份。恢复重新读取摘要，完全相同才复用未退出节点的历史 ok；旧任务没有源码身份时重新执行。

只读 worker 完成后、产物写回前再次读取源码摘要；摘要变化或无法验证时记 failed/snapshot，不代写报告，不伪造成功。失败后的下一次尝试基于最新输入执行。可写 worker 的自身源码产出不纳入此只读规则。

server 关闭时 abort 并等待活跃 runner 收束，关闭期间不由旧 runner 更新派生运行终态；等待事实和原 run 身份保留供重启恢复。关闭不是用户取消，不新增 workflow.run.cancelled 或人工决定。

## 理由

报告与机器证据应针对同一份可识别的代码。输入绑定使恢复知道报告是否仍适用；写回前重检保护执行期间的改动。摘要 IO 留在宿主，核心 hash 仍是纯函数。

## 被否方案

无条件重新调用浪费已证明有效的 checkpoint。仅让 gate 失效不能证明旧报告已重新评审；hash 函数自行读取文件会混淆纯计算与 IO。

## 实现边界

声明范围必须覆盖评审所依赖的代码；未声明范围的节点保留文档范围语义。已退出节点不自动回滚。便携文件扫描不承诺跨进程原子快照，必须配合隔离工作区。人工 gate 继续人工处理。

## 证据来源

现有 executionInputHash、NodeRunner.isCompletionReusable、readonly 报告写回流程、声明源码清单 helper 及阶段 28 回归测试。
