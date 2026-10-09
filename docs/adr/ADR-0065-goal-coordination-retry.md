# ADR-0065 ｜ 绑定 blocker 的协调轮次重试

- 状态：accepted
- 日期：2026-10-09
- 关联：ADR-0058（自动升级）、ADR-0063（Goal 恢复）、ADR-0064（验收覆盖）
- 来源：supervisor 输出失败/stale 后只能手工重新发起普通协调

## 背景

自动 Goal 升级是受 blocker 约束的协调轮次。supervisor 结果格式错误、超时、输入在执行期间变化时，原轮次终态失败或 stale；普通协调入口需要用户重新选择 agent 和版本，且不能证明它仍解释同一 blocker。重复触发可能并发调用 supervisor，失败重试的语义也不够可见。

## 决策

新增 `POST /api/v1/requirements/:req_id/coordination/:round_id/retry`，接收服务端 `coordination_retry.input_hash` 与 Idempotency-Key。只接受同 blocker 最新轮次的 `failed/timeout/stale/cancelled`，或未答复且 current=false 的历史成功轮次；读取其绑定 supervisor、SDLC 版本和 blocker，重新核验当前 failed run、最新 blocked 事件与快照，再创建新的受限协调轮次。不会启动 worker、增加 Goal 预算或复用旧 round 的回答。

修复 supervisor 配置后允许用户读取最新 token 并明确重试同一别名；token 绑定完整协调输入、父轮次最新完成事件与当前配置 hash，旧 token 409。首个 await 前固定 resolver，预留协调槽位，在 request 前和派发前重检输入与当前配置；request 后热重载不改变在途 resolver。

`coordinator.round.requested` 新增一组可选 `retry_of_round_id/retry_input_hash/retry_configuration_hash`，新重试完整记录，旧请求全缺省兼容，部分声明拒绝。重试请求使用 human actor 与 console-server 来源，初始自动请求保留 system/goal-supervisor。共享来源解析核验父 round 同 blocker/版本/agent、因果顺序、合法终态、无答复/续跑和唯一直接子请求；投影及后续 Goal 授权恢复共用。相同父轮次/token 重放已有子 round；不同 token 或非最新父轮次 409，不再次派发。冷重启不重放已开始的 supervisor，未完成标记 interrupted，后续只可从新的失败子 round 明确重试。

控制台在自动升级失败/stale 轮次展示“重试协调”，不显示为 Goal 重新执行。按钮只重跑 supervisor，完成后仍需人工答复/Goal retry 或最终 gate；happy path 不增加操作。

`coordination_retry` 的 available/reason/token/子 round 来自 server；前端不推导新鲜度或重试资格。沿用发布的 supervisor_timeout_ms，不能携带任意预算、agent 或版本字段。

## 备选方案

1. 用户重新输入 agent/版本发起普通协调，无法保留受限 blocker 的续跑入口。
2. 自动重放所有失败 supervisor，依赖 in-memory 次数去重。
3. 显式 token 重试，持久父子来源、固定输入/配置校验和单子请求。

## 理由

1. supervisor 失败是协调层失败，不应迫使用户重新构造 Goal 来源或误启动 worker。
2. blocker 是权限和预算边界，重试解释同一事实不授予新执行预算。
3. 新 round 保留事件溯源和新鲜度检查，避免旧失败结果覆盖新快照。

## 被否方案

- 普通协调重建不保留 Goal 新预算授权需要的 blocker 来源。
- 自动无限重放不能证明新输入/授权，且重启丢失次数会重复付费调用。
- 仅内存父子登记在冷恢复或索引重建时丢失 provenance，因此从事件解析。

## 实现注意

1. 新请求记录前与首次派发前重检；请求已经落盘后的输入变化须留下终态，无法持久化时报告未确认。
2. 原轮次状态与当前有效性分开；历史 ok/current=false 没有答复时可以按最新 token 重试，current=true 不重复。
3. 当前 failed run/blocker、发布版本、配置身份和父完成事实共同约束 token，所有状态通过 events.append。
4. 坏来源需求在冷恢复隔离，查询不展示可用问题，其他需求和健康服务继续可用；不改历史或补虚假成功。

## 限制

重试不能修复真实 blocker，也不代替人工答复；连续失败仍需要人工处理或更新 SDLC/agent 配置。费用/token 动态预算和跨 driver 权限仍不在本 ADR 范围。

## 证据来源

- `CoordinationService.start/escalateGoalBlocker` 和 `ContextSessionAgent` 当前快照/输出限制。
- [验收与 review 指南](../research/2026-10-09-goal-coordination-retry.md)。
