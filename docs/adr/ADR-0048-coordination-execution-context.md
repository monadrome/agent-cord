# ADR-0048 ｜ 协调 run 与 worker 执行观察

- 状态：accepted（实现选型）
- 日期：2026-10-08
- 关联：ADR-0032（独立协调）、ADR-0034（执行版本）、ADR-0044/0047（观察与严格读取）
- 来源：阶段 34 的执行失败协调缺口

## 背景

独立协调只看到文档、账本、进度/人工等待和机器验证。worker 在同一节点 started→failed/timeout 而未产出文档时，协调输入不变，模型无法区分未执行与执行失败。历史 started 也不能单凭事件证明进程仍活着。

## 决策

NodeRunContext 与 agent.task.started/completed 增可选 run_id，executor 透传当前 run，worker 经 append 记录；已有 checkpoint 按 workflow 版本与输入复用的语义不变。

ContextSessionAgentOptions 增可选 read_execution_context。server 从同批严格事件定位当前发布绑定 run，为声明 node.run 的节点投影当前 run 的最新任务事实，最多 128 项；只保留 node/event/run 身份、status、attempt/max_attempts、failure_stage/retryable。无任务为 missing，坏最新 payload/correlation 为 invalid，不回退旧成功。无 run_id 的旧任务不猜测归属。

run 观察包含 run_id、登记 status 与当前宿主 active 标记。active 只来自当前匹配 run 的进程内槽位，不从旧 started 推断。started 表示已记录启动，不证明 CLI 当前活着或已有终态。任务 ok 不代表机器验证或人工 gate 通过，任务事实也不保证对应当前修改后的文档/源码。

执行观察进入 prompt、输入 hash 和完成/查询/采用重检。绑定观察时使用 v5 输入域，轮次只保存 execution_context_hash；无 hook 保留 v4 库模式。active run 时 eligible_nodes 为空，不接受 advance/complete；失败/取消且 inactive 可提出重试方向，但采用仍经人工与既有 runner。

新增 agent_task/event_id 提议来源，只接受当前 run 最新且合法的任务观察。控制台来源链接定位并展开任务事件；不注入 error、text、prompt_excerpt 或 driver raw。

## 理由

协调应了解当前执行事实，才能安排等待、补充信息或重试。使用受限宿主投影既保持新鲜度，也避免原始失败日志成为模型指令或第二份状态机。

## 边界

该观察不认证 OS 进程或外部 agent 身份，不自动重试模型、不批准 gate、不回滚已退出节点。冷启动 active=false，历史 started 保留事实语义。旧无 run_id 任务仍可审计/按既有输入复用，但不作为当前 run 任务来源；旧协调输入须重新协调。
