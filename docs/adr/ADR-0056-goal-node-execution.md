# ADR-0056 ｜ 节点内 Goal 交付、宿主验证与有界修复

- 状态：accepted（节点内原型已实现）
- 日期：2026-10-09
- 关联：ADR-0055（默认 Goal 交付）、ADR-0023（唯一节点生命周期）、ADR-0030（checkpoint/审批）、ADR-0040/0041/0045（验证事实）
- 来源：默认 Goal 核心 feature；当前 coordinator、验证输入与 server runner 核对

## 背景

任务重试不覆盖成功调用之后的测试失败。当前实现节点退出后，verify 的测试失败无法自动返回修改代码，又不能回滚退出事实。完整开发交付需在尚未退出的节点中形成代码、验证和 review 指南。

## 备选方案

1. 修改 DAG 退出语义，给 verify 添加回到 implement 的边。
2. ACP driver 自行续发 prompt，并以模型回复作为测试证明。
3. 在 NodeRunner 内包装 Goal，使用现有 worker 任务执行与宿主命令验证，成功后再返回节点 ok。

## 决策

采用方案 3。节点 `run.goal` 声明 `inputs`（1-64 个源码/依赖路径）、`checks`（1-16 个唯一 id 的 bin/args 命令与 timeout_ms）、`max_attempts`（默认 3，上限 10）、`timeout_ms`（默认 30 分钟，上限 24 小时）、`no_progress_limit`（默认 2）。artifact 必须声明，作为 human review 指南；Goal worker 必须可写，不能同时使用 run.retry。原有未声明 goal 的单次任务行为保持兼容。

Goal 需要 run_id 与宿主 `read_verification_input` 钩子；返回当前 input_hash/source_hash，server 复用 readNodeInput。goal.inputs 纳入既有验证源码并集。每次 worker 正常结束后，宿主读取当前身份，按顺序运行已发布命令（argv 数组，无 shell），重检身份，审计指南的“变更 / 验收 / 风险”非空章节，附加宿主实际验证证据，再记录绑定最终指南的验证事实。命令执行期间输入变化时不得记录通过。

宿主新增 `goal.attempt.started` 与 `goal.attempt.completed`：绑定 workflow/run/node、尝试号，completed 区分 ready/retrying/blocked/cancelled，包含 failure_kind、原因、原 worker 完成引用、当前 input/source/guide hash 和验证事件引用。全部经 events.append；存储失败上抛，不能继续派发。原 agent.task.completed=ok 只代表 worker 调用与报告，Goal ready 才能让节点执行成功。

首条 started 的 timestamp 作为同 run/node 的总时长基线，尝试数与无进展签名从事件恢复；进程中断也消费该次尝试，同一 run 不重新授予预算。失败反馈携带实际命令状态及有界输出供下一次 worker 修复；原输出只在内存，不进入事件/指南，事件保存完整输出流 hash。无进展按源码摘要与失败集合判断，报告文字变化不算代码进展。

完成复用需同时满足同 run、最新 ready 引用匹配、当前 input/source/guide hash 匹配、声明命令 hash 与最新宿主验证事实一致；未退出 Goal 的新 run 重新验证。人审期间代码/指南变化使旧 ready 无效，剩余预算内再执行。Goal 失败归为 run failed 并给出具体原因；预算/配置/输入阻塞等待用户处理或显式新 run，不自动批准人工 gate。

## 理由（第一性原理推导）

1. 节点内闭环保留唯一恢复单位，测试失败可以改代码而不回滚历史退出事实。
2. 宿主实际命令结果提供独立于模型自述的信号，argv 与版本化 workflow 定义命令授权范围。
3. 输出指南与被测代码分别核验，宿主补充的证据不能改变被测源码身份。
4. 持久化尝试与时长防止重启无限续跑，明确终止原因使卡点可复核。

## 被否方案的否决理由（逐一）

- 方案 1：改变退出事实与 DAG 恢复语义，形成重复执行和审批漂移。
- 方案 2：通信成功不证明目标完成，无法统一 headless 和宿主证据。
- 全量自动批准 ACP 权限：越出既有授权范围，Goal 只改变执行持续性。

## 关键实现注意点

1. 命令只用于已授权工作区中的可重放验证；可写脚本、环境和依赖仍是信任边界，不提供 OS 沙箱或恶意 worker 抗篡改证明。部署/迁移命令不应作为检查项。
2. 输出流持续计算 hash，仅保留有界尾部作失败反馈；不存原始日志、env 或凭据。review 指南链接实际结果事件，完整日志持久化留后续协议。
3. 子进程独立进程组，超时/取消杀进程树；整个 Goal deadline 传给 worker 和命令。缺二进制/源码不可读等配置或环境错误停止循环。
4. Goal 交付就绪后仍走原 post gates，最终人审不被替代。本轮原型使用显式 goal 配置与推荐模板，尚不自动迁移既有发布版本，也不实现独立协调的自主监督或人工澄清续跑 UI。
5. 覆盖自动修复、首轮成功、伪造文本、缺指南、输入变更、配置错误、无进展、预算、取消、冷恢复和最终人审。
6. 控制台文档页以 server 投影列出当前 SDLC 声明的 artifact；新增只读 GET artifacts?path 接口，拒绝未声明路径，沿用普通文件访问边界。固定四份快照的编辑接口保持兼容，产物视图不可保存。

## 证据来源

- src/coordinator/coordinator.ts、src/workflow/executor.ts 的任务与退出边界。
- apps/server/src/services/run-service.ts 的 readNodeInput 与现有机器结果 checker。
- [核心 feature](../core-features.md) 与 [ADR-0055](./ADR-0055-goal-driven-draft-delivery.md)。
