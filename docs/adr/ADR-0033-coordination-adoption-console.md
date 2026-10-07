# ADR-0033 ｜ 协调提议的受控采用与 console 工作台

- 状态：accepted（用户授权的原型迭代）
- 日期：2026-10-07
- 关联：ADR-0032（协调轮次）、ADR-0030（输入/审批版本）、ADR-0027（registry 快照）、ADR-0021（console 投影）
- 来源：持续 SDLC 优化目标与独立协调原型的操作闭环审查

## 背景

独立协调轮次仅提供库/REST，用户需要从自由 JSON 中手工提取提议。历史 ok 不能证明当前输入仍相同，started 中的实际 driver 名也不能替代自定义 registry 别名。直接把建议节点送入 runner 会误导用户以为模型可任意跳转。

## 备选方案

1. console 根据 status/input_hash 自行推导与启动：重复核心逻辑，不能验证当前文件和 agent 配置。
2. 新造按模型建议跳转的执行器：与已有拓扑、恢复和 gate 语义冲突。
3. server 重检 + 显式人工采用 + 既有 runner（选定）：提议只确定绑定版本和真实下一节点，启动后照常执行完整 SDLC。

## 决策

1. 协调 next_action.advance 的 eligible_nodes 收敛为拓扑顺序第一个未退出且依赖已退出的节点；任何待人工 gate 都阻止 advance。complete、wait 和 ask_human 保持 Draft，不由采用接口制造 gate 决策或节点退出。
2. 轮次投影保留 requested 的 agent 别名，并增加 current（true/false/null）、adoptable、adoption_reason 与 adopted_run_id/adopted_at。历史 status 不变；current 只代表本次查询的输入比对，不能替代写时重检。无配置身份、读取失败或旧事件无指纹时 fail-closed。
3. POST /requirements/:req_id/coordination/:round_id/adopt 表示“采用并启动 SDLC”。只接受 ok/advance，核验绑定版本未归档、workflow 一致、当前快照/配置指纹相同、建议是真实下一节点；采用校验位于 RunService 的在途槽位内，普通 run 并发时返回 409。
4. 新事实 coordinator.round.adopted 保存 round_id、workflow_id、node_id、input_hash、run_id，由 human actor 经 session.events.append 追加。先校验、登记 run、落采用事实，再 launch；事件失败不得派发，run 登记为 failed。run 操作登记保留可空 coordination_round_id，并兼容旧 SQLite 表。恢复时，绑定协调轮次的 run 必须存在匹配 adopted 事实与 requested 的 SDLC 版本，否则记 failed 而不派发；避免登记与采用落盘之间的中断绕过门禁。落盘后中断由已有 run 恢复机制处理，不把协调提议当 worker checkpoint。
5. 同轮并发采用合并为同一次操作；已采用轮次从事实返回原 run，不重复启动，即使后续输入已变化。不同轮次和普通 run 仍受每需求在途互斥约束。采用命令必须有 Idempotency-Key。
6. console 增需求详情“协调”视图，使用 typed client 消费上述投影。选择 agent/SDLC 版本/超时，创建与取消协调，查看轮次、提议、风险、来源、快照/配置身份与新鲜度；采用是明确人工按钮，已采用显示绑定 run。失败刷新保留已加载内容，SSE/轮询更新投影，卸载释放订阅/定时器。

## 理由（第一性原理推导）

- 查询时有效不代表写入时有效，决定性校验必须在宿主的运行槽位中进行。
- 模型只提出下一步，程序负责依赖与恢复，人负责采用和关键 gate；新功能不能形成第二条推进路径。
- 采用属于人工操作事实，必须可追溯到提议版本和真实 run，不能只保存在浏览器。

## 被否方案的否决理由（逐一）

- console 判定：缺少当前文件和实际 registry 访问，必然存在状态漂移。
- 模型跳转执行器：打破现有恢复/拓扑约束，扩大控制面而没有验证收益。
- 自动采用：与 Draft 和人工 gate 边界冲突。

## 关键实现注意点

- 采用启动整个绑定 SDLC，从真实下一节点续跑；不承诺只执行建议节点，不修改流程定义。
- 采用结果与轮次自身完成状态分开，历史 adopted/ok 不被后续输入变化改写。
- 仍是单进程原型，跨进程 lease 和外部文件并发修改的强事务不在本次范围；worker 每节点继续读取最新快照并执行 gate。
- console 的来源导航只覆盖已有文档/账本/概览接口，自定义 artifact 显示来源定位符。

## 证据来源

1. `coordinator/session-agent.ts`：严格提议、语义输入 hash 与新会话。
2. `RunService.start` / `workflow/executor.ts`：在途槽位、拓扑与人工 gate。
3. `RequirementDetail` / typed client：server 投影与详情子视图。
