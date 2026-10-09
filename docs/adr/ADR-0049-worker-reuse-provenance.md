# ADR-0049 ｜ 跨 run 的 worker checkpoint 复用事实

- 状态：accepted（实现选型）
- 日期：2026-10-08
- 关联：ADR-0030（checkpoint）、ADR-0048（执行观察）
- 来源：阶段 35 的新 run 复用任务被投影为 missing

## 背景

同一流程取消人工等待后启动新 run，runner 可以验证输入/源码/产物并复用原始成功任务，但没有新的 agent.task.completed。阶段 34 只投影当前 run 的任务，协调者于是看到 missing，无法引用实际被采用的 checkpoint。

## 决策

新增 agent.task.reused 事件：workflow_id/revision、当前 run_id、node_id、completion_event_id，以及原始任务可用的 execution_input_hash/source_hash/configuration/artifact 摘要。executor 仅在 NodeRunner.isCompletionReusable 返回 true 且原完成事实属于另一个 run（或旧无 run_id）时追加；当前 run 的原生完成事实仍直接使用，不伪造新的完成或模型调用。

同一 run/node/原完成事件只记录一次，恢复沿用已有复用事实；新 started/completed 使该节点的复用记录失效。追加失败上抛，不能进入后续 gate。没有当前 run_id 的库模式保持原 notes 行为，不猜测运行身份。

执行观察新增 reused 状态与 completion_event_id（其他状态为 null，旧 hook 可缺省）。仅引用同 session、同流程版本/节点、合法 ok 的更早 completed，且原完成至复用之间不存在该节点更新的 started/completed；坏引用、错 correlation 或坏最新复用投影为 invalid，不回退旧成功。原完成的 attempt 超过 max_attempts 时，checkpoint 与复用引用均拒绝，保持直接观察与复用观察一致。

观察 hook 使用 CoordinationExecutionContextInput，旧实现可省略有默认值的新字段；消费端 schema 归一化为 null。复用观察不声明新的 attempt/max_attempts，编号只来自原完成事件的历史内容。

复用观察的 event_id 指向当前 run 的 reused 事实，completion_event_id 指向原始真实完成，不把复用当作当前新执行。模型可使用 agent_task 来源解释 reused；仍不得当作测试或人工 gate 通过。绑定执行观察的协调身份升级为 v6，无 hook 保持 v4 库模式。

控制台沿用事件定位：提议来源先展开当前复用事件，其中原完成链接可继续展开已加载的原始 completed。仅提供导航，不在前端复制复用判定或生成状态。

## 理由

复用是经过验证的宿主动作，应有自己的审计事实。显式连接新 run 与原结果，让模型知道实际执行来源，同时保留“没有重复调用”的事实语义。

## 边界

不改变现有输入/源码/产物复用判定，不自动批准或回滚节点。复用仅证明记录时宿主校验通过，后续输入改变仍按既有规则失效；不认证外部进程或事件作者。旧协调域需重新协调，原始任务和已有人工等待保持不可变。
