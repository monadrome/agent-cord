# ADR-0030 ｜ 恢复输入校验与版本化人工审批

- 状态：accepted（已实现）
- 日期：2026-10-06
- 关联：ADR-0023（节点恢复）、ADR-0028（最新快照）、ADR-0029（产物证据）、ADR-0021（人工 gate 桥）
- 来源：需求变更后的 worker 恢复与等待审批审查

## 背景

历史 agent.task.completed 的 ok 不能证明当前输入仍相同；snapshot_id 含事件链，每追加控制事件都会变化，也不能直接作为复用条件。等待中的 gate 原先跳过新检查，审批 ID 和暂存选择只绑定 node/gate，可能批准 worker 重跑后产生的新内容。

## 备选方案

1. 恢复时始终跳过 worker 和检查：成本低但会沿用过期结论，否决。
2. 恢复时始终重跑所有节点：浪费模型调用，破坏已退出节点的事实和恢复单位，否决。
3. 稳定输入指纹、产物校验与等待事件版本（选定）：只对未退出节点验证复用条件，人工决策绑定当前检查和等待版本。

## 决策

1. started/completed 增可选 execution_input_hash，使用规范化 JSON 的 SHA-256，涵盖需求身份/标题、完整工作流定义、节点、文档内容 hash、账本摘要、已退出进度和上下文预算。不包含事件序号、时间戳或控制事件；可写当前 artifact 的输入 hash 排除其内容，其结束后态另行验证。
2. NodeRunner 可提供 isCompletionReusable。恢复只在该方法确认输入相同且声明产物的当前 hash 与 completed 后态一致时跳过 worker。读取错误、无验证方法、旧事件无指纹均重新执行未退出节点。node.exited 的事实保持不变，不隐式回滚已退出节点。
3. resumed 的 entered 不直接清除 checkpoint；新失败任务会清除成功候选。worker 重跑会使该节点旧 post gate 等待失效。
4. gate 使用统一 evaluateGate 生成检查结果和 evaluation_hash。server 注入包含全部需求文档与账本的 gateInputHash，核心未注入时仍重新检查机器结果。等待返回或恢复后重新求值；依据变化时记录 gate.invalidated 并重新推进检查/审批，不记录伪造的人工拒绝。
5. gate.waiting 存 evaluation_hash；未变化的等待恢复复用原等待事件，变化或旧事件缺少指纹则重新发起。HumanGate 可返回结构化 recheck 控制响应，并携带当前等待上下文。
6. server 的 approval_id 使用 gate.waiting 事件 ULID，流程和节点从该事件投影，避免长路由参数。旧编码仍可解析，但写命令需当前等待版本，否则拒绝并要求读取当前审批。临时选择和 ask promise 按等待事件 ID 定位，不跨审批版本使用。
7. REST 决策在落 human.decision.recorded 之前调用同一 gate evaluator 校验指纹。依据已变则先落 invalidated、唤醒重检或恢复执行，再返回 409；无法读证据同样拒绝记录放行。核心在消费选择后再次校验，缩小并发变化窗口。

## 理由（第一性原理推导）

- 控制事件只说明流程推进，不改变任务语义；恢复指纹必须与事件链 provenance 分开。
- worker 可写自己的产物，该变化不能让自己的成功 checkpoint 自失效；后态指纹承担产物完整性校验。
- 人工选择批准的是一次具体证据状态，不能复用到另一轮 worker 或检查结果。
- 统一 evaluator 避免 server 复制 gate 状态机，变化通过事件留痕并重新推进。

## 被否方案的否决理由（逐一）

- 盲目复用：缺少最新输入证明。
- 全流程重跑：覆写已退出事实，增加无意义成本。
- 仅 node/gate ID：不能区别同一 gate 的多轮审批。
- 依据变化伪造人工 block：用户没有作出拒绝选择，不能污染决策事实。

## 关键实现注意点

- 沿用现有 SHA/canonicalJson/reducer；旧事件保持可读，不能证明新鲜度时 fail-closed 重跑或重审。
- gate.invalidated 只移除匹配等待版本；其后的新等待不受旧版本失效事件影响。
- 指纹校验是乐观检查，不替代跨进程 lease，也不声称包含 worker 在需求快照外读取的整个仓库状态。
- 同需求审批写命令串行处理，同一等待版本已有 human.decision.recorded 时拒绝第二次决策；幂等响应重放仍由 REST 钩子处理。
- 测试覆盖原输入多次恢复、PRD/账本/产物变更、等待期间共识推翻、重启暂存决策、新旧审批隔离与读取失败。

## 证据来源

1. executor.scan 的 agentDone 与 runGate pending 分支。
2. RunService.decided / PendingAsk 的静态 node/gate 定位。
3. ADR-0028/0029 的最新快照、输入与产物 provenance，以及 ADR-0021 的审批事件投影。
