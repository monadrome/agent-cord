# 自动 Goal 升级协调重试验收与 review 指南

日期：2026-10-09。协议见 [ADR-0065](../adr/ADR-0065-goal-coordination-retry.md)。

## 行为

supervisor 输出非法、超时或协调期间输入变化后，原自动 round 保留终态事实。服务端提供 coordination_retry 的 available/reason、当前输入 token 和子 round；用户点击“重试协调”，重新核验同一 blocker、当前 failed run、SDLC 版本和当前 supervisor 配置，创建新受限 round。

修复 supervisor 配置后可以获取新 token 重试同别名；旧 token 拒绝。请求三字段保存父 round/token/configuration，使用 human actor 表示明确重试，初始自动请求仍由 system/goal-supervisor 生成。固定 resolver 贯穿校验/派发，记录前重载或输入改变拒绝，记录后重载不替换在途 agent。request 后输入改变记录未派发失败，不冒称协调已执行。

一个父 round 只创建一个子 round，同依据/同键或不同键重放均返回已有子 round；需要再次重试时必须处理最新失败子 round。中断后只标记 interrupted，不自动重放 supervisor。已有答复/Goal 授权、版本归档、blocker 变化、普通轮次或活动子 round 均拒绝新调用。

## Review 定位

- `src/core/schema.ts`：retry_of_round_id/retry_input_hash/retry_configuration_hash 全有或全无的兼容约束。
- `src/coordinator/goal-coordination.ts`：初始自动请求和人工重试来源、父子因果链、唯一子请求与身份；Goal 授权恢复共用。
- `apps/server/src/services/coordination-service.ts`：当前快照 token、固定 resolver、同需求重试合并、request 先于派发和冷来源隔离。
- `apps/server/src/app.ts`、`contracts.ts`、`apps/console/src/api.ts`：幂等 REST 与 typed client。
- `apps/console/src/pages/CoordinationPanel.tsx`：服务端重试投影、重试后选中新 round、父/子轮次导航，操作与“重新执行 Goal”分开。
- `tests/driver/fixtures/goal-supervisor.mjs`：同配置首次坏输出/后来正常，真实 ACP/headless 的恢复对照。

## 验证

覆盖 ACP/headless 重试成功、修复配置/最新 PRD token、旧 token、不同键并发/重放、请求 fsync 失败、记录前后重载/输入变化、request 后中断、来源字段/actor/config 伪造拒绝、超时/取消、归档/答复/非最新/普通 round 拒绝。typed client 经真实 HTTP 重试问题、记录答复、独立授权 Goal，冷恢复核验来源链且不重复调用。

## 限制

重试只调用 supervisor，不启动 worker、不增加 Goal 预算、不代答或批准 gate；后续人工答复与 Goal 执行授权仍独立。协调调用沿用发布 supervisor_timeout_ms，尚无 token/费用治理。工作区脚本仍是信任边界，测试不能证明恶意 worker 的隔离。
