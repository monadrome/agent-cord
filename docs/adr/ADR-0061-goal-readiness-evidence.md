# ADR-0061 ｜ Goal 就绪证据与协调新鲜度统一

- 状态：accepted（原型已实现）
- 日期：2026-10-09
- 关联：ADR-0056（Goal 交付）、ADR-0057（Goal 观察）、ADR-0045（验证证据一致性）、ADR-0030（checkpoint 新鲜度）
- 来源：当前 runner 与 execution-context 对 Goal ready 的消费核对

## 背景

runner 复用 Goal 时校验当前代码/指南与验证结果，协调投影只读取 ready payload。代码已变化或 ready 引用不存在的 worker/测试时，协调模型仍可能将历史 ready 当作当前可交付事实。两条消费路径必须接受同一完成证据。

## 备选方案

1. 仅向 prompt 添加“ready 可能过期”的软提示。
2. 在 server 复制 runner 的全部判断。
3. 共享结构化 Goal 证据解析，再由各宿主核验当前 input/source/artifact；协调观察增加新鲜度。

## 决策

采用方案 3。新增纯读侧 resolveGoalReadiness：以同一严格事件批次定位当前 Goal ready、其原 worker 完成和各声明验证。核验同 session/workflow revision/run/node、宿主来源、事件顺序、最新完成引用、命令 hash、真实零退出、ready 与验证的 input/source 身份、产物证据及尝试预算。未来/不存在/被新任务或验证替换的引用拒绝，取消 run 的 ready 不再有效，不回退旧成功。

runner 的 isCompletionReusable 与 server execution-context 共用该解析。runner 继续核验当前 input/source/guide；server 将历史 ready 状态与新鲜度分离：CoordinationGoal 新增 current（true/false/null）与 freshness_reason（current/stale_input/unavailable/invalid_evidence/run_cancelled/not_ready）。无新鲜度的旧 hook 缺省 current=null/not_ready，不得冒称当前 ready。

结构证据不合法的最新 ready 投影为 invalid/current=false，不回退前一个 ready；证据正确但当前输入/指南不匹配保持历史 ready/current=false/stale_input；读取故障保持 ready/current=null/unavailable。只有 current=true 的 ready 能作为 goal evidence 引用。blocked/retrying 等历史执行事实继续可引用，不因后续业务输入变化而改写原状态，也不自动解除 blocker。普通 workflow 进度/退出事实和人工 gate 语义保持原样。

ready 的新鲜度纳入协调 input hash 与完成/查询重检；更新代码、报告或验证使旧提议失效。兼容无 Goal 流程，不自动迁移、重放模型、批准 gate 或回滚退出节点。

## 理由（第一性原理推导）

1. ready 是一次交付审计的历史事实，当前可交付需要身份仍匹配，两者不能混用。
2. 协调与恢复共享证据规则，避免模型看到宿主实际上会拒绝的成功。
3. 结构证据与实际 IO 分离，坏来源和暂不可读不会被误判为同类，也不构造通过结果。

## 被否方案的否决理由（逐一）

- 方案 1：模型无法凭提示验证来源和文件身份，不能兑现 fail-closed。
- 方案 2：重复判断容易漂移，特别是未来事件和最新失败替换的解释。
- 过期后重写原 ready 事件：历史事实不可改；新鲜度只在读取投影层变化。

## 关键实现注意点

1. 解析使用数组内的因果顺序，不仅依赖单个 seq；支持事实在正常血统里的确定性排序。hash/reducer 保持纯函数，文件重检位于宿主。
2. 原任务 artifact_after_hash 是宿主补证据前的指南，不能与最终 guide hash 强制相等；必须仍有合法产物写入证据。最终 identity 来自 Goal ready。
3. 旧 ready 若缺必要来源证明则需重做，已退出节点不回滚。新鲜度只证明声明范围与证据身份，不证明完整业务正确或抗恶意篡改。
4. 验收覆盖真实 ready、源码/指南变化与修复、IO 故障、取消、未来/外部/替代完成、重复/失败/命令错配验证、当前 ready evidence 与在途变化 stale。
5. ready 必须链接同编号且先于 worker 的 Goal 启动；ready/worker/验证事件 ID 必须唯一，不能用重复或未开始的尝试冒充完整来源。
6. ready 过期且尝试耗尽时，预算 blocked 终态引用已消费的最大编号，不记录未启动的下一次；避免合法卡点超出声明上限后被投影为非法，仍可走自动升级。

## 证据来源

- src/coordinator/goal.ts isCompletionReusable 与 apps/server/src/services/execution-context.ts goals 投影。
- workflow/verification.ts 与 ADR-0045 的最新事实、不回退旧通过语义。
- [核心 feature](../core-features.md) 的完成审计与当前输入契约。
- [就绪来源验收](../research/2026-10-09-goal-readiness-evidence.md)：反例、真实宿主事件和协调新鲜度。
