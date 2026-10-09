# ADR-0062 ｜ Goal 续跑授权绑定实际 agent 配置

- 状态：accepted
- 日期：2026-10-09
- 关联：ADR-0059（人工续跑）、ADR-0031/0054（配置身份）、ADR-0060（权限策略身份）
- 来源：续跑配置校验与 resolver 捕获时序审查

## 背景

retryGoalOnce 的 check 每次读取当前 resolver，实际 launch 使用中间另一次捕获的 resolver。配置在这几次读取之间重载可能出现校验 A、捕获 B、再次校验 A 后启动 B。授权事实只有不可反解的 input_hash，冷恢复无法独立证明本次 agent 仍是人授权的角色/模型/权限策略。

## 备选方案

1. 依赖每次检查当前清单，忽略启动快照和冷恢复身份。
2. 在授权事务中全局锁定 agents.reload。
3. 授权事务捕获一个 resolver，所有检查均核验其身份与当前定义一致；授权持久化非敏感配置 hash，恢复前再次核验。

## 决策

采用方案 3。retry-goal 在首个输入校验前捕获 resolver；检查当前 worker/supervisor 配置身份与该快照一致，再用快照组装输入，记录和派发使用同一个 resolver。事务中发生实际配置变化时旧 token 拒绝；授权落盘后配置重载不改变在途 run 的 agent。

goal.retry.authorized 新增可选的一组 agent_configuration_hash、supervisor_configuration_hash、node_input_hash；新授权必须全部写入，旧事件全部缺省仍可读取。原 input_hash 域保持 v1，保存字段为其既有组成部分，不添加 argv、角色原文或 env。结构验证拒绝只声明部分字段。

冷恢复和人工 gate 消费前核验当前待执行 worker 身份。新授权使用持久化 agent_configuration_hash，角色/模型/权限策略变化时 failed/409，不派发新 agent、不自动通过普通 start 重建预算。无身份的旧授权仅能从授权之后原 worker started/completed 的合法 configuration_hash 归因；没有调用事实时无法证明身份，拒绝恢复派发。还原相同配置后，在原 run 上继续恢复或审批；不创建新预算、不回放仍有效的 Goal。

授权已落盘但 worker 尚未启动的恢复窗口同时校验 node_input_hash；需求/代码/答复变化后不得在无人确认下执行原授权。已开始的 Goal 继续使用现有动态输入/次数与时长机制，正常代码输出不被当作授权篡改。历史授权与已完成产物保留，不回滚退出节点。

## 理由（第一性原理推导）

1. 人授权的是具体模型/角色/权限，不是随时可替换的 agent 名；校验和执行必须使用同一身份。
2. 配置快照已是现有架构，无需全局锁阻断其他需求重载，只需证明本次捕获与授权一致。
3. 冷恢复没有旧闭包，必须用事件里的稳定 hash 验证；输入 token 的聚合 hash 不能代替可检查身份。

## 被否方案的否决理由（逐一）

- 方案 1：独立读取不能约束实际执行快照，重载竞态与冷切换仍存在。
- 方案 2：全局变更锁耦合无关需求，增加长等待且恢复时仍需持久身份。
- 静默重启不同 agent：未经人工重新授权变更角色或权限，与 Draft-only 之外的授权来源不一致。

## 关键实现注意点

1. 身份核验使用 server 当前 run 的固定 resolver；warm 在途配置不受新清单影响。恢复先验证结构来源，再查身份，再决定复用/派发。
2. 旧授权兼容必须严格核验任务同 session/run/node/版本、宿主来源及授权后的顺序，坏的首条任务不能回退后来成功。
3. failed 身份漂移的已授权 run 可显式 recover；真实授权缺失仍拒绝。普通 run 的恢复不改变；恢复预算不重新开始计时。
4. 测试覆盖捕获 resolver 竞态、授权前重载、授权后重载固定、冷配置漂移/还原、首次派发前输入变更、旧授权有/无来源、幂等重放与最终人工 review。

## 证据来源

- apps/server/src/services/coordination-service.ts 的 retryGoalOnce/readGoalRetryState。
- RunService.start/launch/recover 与 AgentService.resolver 固定快照契约。
- [人工续跑验收](../research/2026-10-09-human-goal-retry.md)。
