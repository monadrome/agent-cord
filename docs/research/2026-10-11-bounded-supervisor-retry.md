# Supervisor有界自动重试：Human Review指南

## 目标与行为

Goal卡点后的独立supervisor可能返回非法提议或超时。声明`supervisor_max_attempts`后，宿主在相同输入、配置和发布预算下自动再解释同一卡点；不需要人工为这些错误逐次启动。默认仍一次，最大三次包含首次。

```yaml
run:
  agent: implementer
  goal:
    inputs: [src]
    checks:
      - { id: tests, bin: npm, args: [test] }
    supervisor_agent: context-coordinator
    supervisor_timeout_ms: 120000
    supervisor_max_attempts: 2
```

此片段需放在有review artifact和最终人工gate的完整流程中，参考[Goal示例](../../examples/goal-sdlc.yaml)。上限须为1..3的整数且同时声明supervisor；默认/1的初始请求不新增预算字段。

| 结果 | 自动行为 |
|---|---|
| failed / output | 当前输入和配置相同、预算剩余时重试 |
| timeout | 当前输入和配置相同、预算剩余时重试 |
| ok / wait或ask_human | 停止自动尝试，保留可供人处理的Draft |
| 配置、工具、存储、中断、取消或输入过期 | 停止自动尝试，保留实际历史 |
| 重启时已有request | 不重放，不自动续接旧链；显式人工retry仍可用 |
| 重启时尚无首次request | 核验原failed run和blocker后按发布策略解释 |

原worker只执行原Goal预算。自动supervisor不会答复问题、采用提议、启动新worker、增加预算、批准gate或合入发布。人工答复与独立retry-goal仍是两步操作，最终review绑定新交付版本。

## 审查入口

1. [ADR-0095](../adr/ADR-0095-bounded-supervisor-retry.md)：来源、预算和恢复决策。
2. [schema.ts](../../src/core/schema.ts)：发布上限与初始/自动子请求的严格字段约束。
3. [run-service.ts](../../apps/server/src/services/run-service.ts)：executor收束与lease释放后发起升级，cleanup核对run身份。
4. [coordination-service.ts](../../apps/server/src/services/coordination-service.ts)：读取发布预算、限制可重试结果、请求前后token/当前输入/配置核验及关闭收束。
5. [goal-coordination.ts](../../src/coordinator/goal-coordination.ts)：初始预算、连续父子链、actor、唯一子请求和成功子输入校验。
6. [session-agent.ts](../../src/coordinator/session-agent.ts)：started落盘后重新读取快照、源码、验证、执行与Agent配置观察；变化时零driver派发。
7. [goal-escalation.test.ts](../../apps/server/tests/goal-escalation.test.ts)：ACP/headless真实离线子进程、2/3次、timeout、漂移、fsync/中断、取消/关闭、冷恢复及来源伪造。

## 验收对应

| 验收条件 | 回归与证据 |
|---|---|
| 首次输出错误后自动成功 | ACP/headless各两轮，父failed/output、子ok、同blocker、system来源 |
| 自动次数不能扩充 | 2/3次上限，回调3不能改发布2；worker/Goal尝试仍一次 |
| 输入或身份变化停止 | PRD/源码/worker/supervisor漂移、归档/取消、request和started落盘窗口 |
| 非输出错误不重试 | 工具违规、缺配置、存储写失败、中断、取消与stale |
| 冷恢复不重复 | 完成链、活动子调用关闭、request落盘后中断；没有request时可补首次 |
| 来源不可伪造 | actor、自动标记、次数、根预算、父结果/配置、成功子输入、重复子请求 |
| 人工入口与权限保留 | 显式retry、答复、retry-goal独立核验；无自动human decision或节点退出 |

```bash
npx vitest run apps/server/tests/goal-escalation.test.ts apps/server/tests/goal-retry.test.ts apps/server/tests/workspace-lease.test.ts
npm test
npm run build
npm run typecheck
npm run build:all
git diff --check
```

接续定向验证：71项协调升级、33项Goal续跑、18项workspace lease，共122项通过。完整`npm test`为1637项/117文件通过，root build、typecheck、build:all与diff检查通过；本轮文档200个本地链接无缺失。

隔离真实TCP验收对ACP/headless分别完成：首次worker失败 → supervisor输出失败后自动第二轮成功 → 重启不重复 → 人工答复后worker仍未调用 → 独立retry-goal授权后worker通过实际自测 → 最终人工gate挂起 → 再次重启保留审批。每种协议supervisor两次、worker两次（第二次来自显式续跑授权）、审批一项、人工gate决定零、节点退出零，doctor=true；调用相同幂等键不重复启动。临时脚本与证据留在`/tmp/cord-stage85-real.mjs`和`/tmp/cord-stage85-real-result.json`，所有TCP服务已关闭，不是可持续访问的预览URL。

## 风险与限制

验证使用本机fixture和真实协议/进程/TCP，不调用付费模型；它证明宿主控制契约，不证明某个LLM必能修复业务任务。单轮发布超时和次数限制协调调用，supervisor费用/token的总额度尚未纳入此预算。能力声明、help或ACP握手不证明模型账户可访问或OS隔离。

当前工作区仍是shared_lease，worker与验证器的真实worktree/OS隔离待实现。固定resolver避免记录后热重载替换已绑定配置；查询按最新配置判断current，后续自动新请求发现漂移会停止。最终gate和真实Draft保持人工未决。
