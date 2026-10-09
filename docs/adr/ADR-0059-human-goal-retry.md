# ADR-0059 ｜ 人工答复后的 Goal 续跑与新预算授权

- 状态：accepted（原型已实现）
- 日期：2026-10-09
- 关联：ADR-0056（Goal 预算）、ADR-0058（自动升级）、ADR-0052/0053（答复与撤回）、ADR-0034（运行绑定与恢复）
- 来源：自动升级真实验收；持续优化目标要求卡点处理后能恢复交付

## 背景

blocked Goal 已自动生成人工问题，答复也能进入最新快照，但当前只有无来源的普通启动入口。重新启动会重置 Goal 的次数与总时长，必须明确区分“记录事实”与“授权一份新预算”，并能在中断后核验其来源。

## 备选方案

1. 记录任意答复后自动启动新 run。
2. 让人继续调用普通启动命令，无法追踪答复与新增预算。
3. 单独的人工 retry-goal 命令，绑定具体问题、有效答复、原 blocker 与当前输入，授权原发布版本的预算后启动新 run。

## 决策

采用方案 3。协调 view 增加可选 `goal_retry`：当前可执行性/原因、当前 input_hash、已发布的 max_attempts/timeout_ms 及已启动的 run_id。仅自动 `goal_blocked` 轮次的有效 ask_human 答复支持续跑；答复必须是当前同题最新、未撤回且与原问题完成一致。原 run 必须仍是该需求当前 failed run，blocker 仍是该节点最新合法 blocked；执行版本、supervisor 与 agent 配置须可验证，输入/源码不可读或版本归档时拒绝。

`POST .../coordination/:round_id/retry-goal` 要求 Idempotency-Key、answer_event_id 与当前 input_hash。该独立命令是人工执行授权，记录答复本身不授予预算，选项标签不用于推断权限。允许用户在答复后修复代码、更新事实或 agent 配置；展示最新待执行身份，旧输入 token 返回 409，重新读取 view 后再授权。

宿主预留同需求运行槽位后重新核验，先记录新 `workflow.run.started{goal_retry_round_id}`，再追加 `goal.retry.authorized`，最后才派发 worker。授权事实保存 round、答复、原 failed run、Goal event、新 run、当前输入 hash 与发布预算。新 run 按同版本恢复进度，已退出节点保持原事实，未退出 Goal 重新执行/验证；不回滚退出事实、不复用原 blocked 的验证、不改变最终 gate。

同 round 的同答复/同输入重复命令返回同一新 run；不同输入不冒充同一次授权，必须通过新轮次形成新的卡点。授权写入失败不派发；冷恢复必须验证 started 与授权及答复/原 blocker 的因果链，缺失或坏来源 fail-closed。有效启动后撤回答复不自动取消已授权 run，用户仍使用现有 cancel；历史选择与授权都保留。

## 理由（第一性原理推导）

1. 卡点答复是输入事实，执行与资源消耗是另一件事，需要可独立追踪的人工命令。
2. 新预算绑定原发布流程，使用现有 Goal run 边界即可续跑，不需要改 DAG 或引入隐式无限重试。
3. 当前输入 token 让人批准可定位的执行版本，代码修复与配置变化不能偷偷改变已经查看的授权依据。
4. 授权事实先于派发，恢复才可证明这份预算有人工来源，避免崩溃窗口自动扩预算。

## 被否方案的否决理由（逐一）

- 方案 1：任意澄清不等于执行授权，尤其不能把“等待/终止”等文字解释成同意。
- 方案 2：用户能续跑但无法证明本次为何重新获得预算，幂等与恢复没有明确来源。
- 原地增加旧 run 预算：旧 deadline/尝试与授权混在同一生命周期，需要更大预算协议；本轮显式新 run 保留旧失败事实。

## 关键实现注意点

1. 原 supervisor 提议的 current 在答复后自然变化；续跑依据独立计算，包含当前输入、有效答复、原 blocker/问题版本和 agent 身份，不能复用答复前 input_hash。
2. RunStartGuard 增可选 goal_retry_round_id，普通人工采用保持 coordination_round_id；二者互斥。派生索引可重建，授权与 started 是事实。
3. 继续时采用原发布 max_attempts/timeout_ms，不自动增大单次预算、不实现费用/token 配额；需要不同上限时另行发布流程并普通启动。
4. 实现应覆盖答复/撤回、输入变化、并发/不同幂等键、record 前竞态、授权写失败、冷恢复、索引删除和真实开发交付到最终人审。
5. started 已落盘但授权失败时，仅当前同轮次的 failed run 可被新命令重新尝试，并须证明没有授权、worker/Goal started 事实；副作用未知或已经派发时拒绝。幂等结果未确认需新键，不回放旧操作。
6. 索引删除时旧 failed Goal 按自身 blocked 事实恢复，不继承新 run 的人审等待；授权链同时用于 view/replay 与冷恢复，预算与原发布版本不一致时拒绝。

## 证据来源

- [自动升级验收](../research/2026-10-09-automatic-goal-escalation.md)、Goal run 内预算与最新澄清投影。
- RunService 的预留槽位、启动事实、RunStartGuard 与 CoordinationService 的来源校验。
- [续跑验收](../research/2026-10-09-human-goal-retry.md)：真实模型、模拟人工授权、幂等与冷恢复。
