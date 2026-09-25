# 核心协议速查

> 本文只列当前实现依赖的规则和入口。完整 Zod 定义以源码为准；设计取舍以 ADR 为准。

## 1. 事件 Envelope

权威定义：[`src/core/schema.ts`](../src/core/schema.ts) 的 `EventEnvelopeSchema`。

每个事件包含：`event_id`、`session_id`、血统内 `seq`、`prev_event_hash`、点分层 `type`、`schema_version`、带时区时间戳、`actor`、`correlation_id`、`payload` 和 `source.adapter`。

写入约束：

- `event_id` 使用 ULID，不能由内容哈希派生。
- `seq`、`prev_event_hash`、`timestamp` 只能由 EventStore 分配。
- 事件必须属于当前 session。
- 单行 JSON 追加并 fsync；成功落盘后才派发进程内通知。
- 写入结果不确定时，当前 store 停止继续追加，必须重新打开。

当前事件家族包括：

| 家族 | 作用 |
|---|---|
| `session.*` | 需求 session 生命周期 |
| `ledger.*` | 账本条目提议、确认、推翻和锚点漂移 |
| `vote.*` | 投票开始与完成 |
| `gate.*` | gate 等待和解决 |
| `workflow.node.*` | workflow 节点进入和退出 |
| `human.*` | 人工选择记录 |

事件类型目录在 `EVENT_TYPES`；新增类型需要同步 schema 和 ADR。

## 2. Ledger 投影

权威实现：[`src/core/reducer.ts`](../src/core/reducer.ts)。

事件流按因果关系排序后交给纯 reducer，输出包含：

- `reducer_version`
- `input_hash`
- `output_hash`
- `entries`

条目状态为 `provisional → confirmed → overturned`。`confirmed → provisional` 只允许通过 `ledger.entry.anchor_drifted`。条件字段 `expected_status` 或 `based_on` 不满足时，reducer 标记 `conflict`，不静默择胜。

`ledger.yaml` 是可再生投影，不是第二个事实来源。修改事件后应使用 `rebuildLedger()` 重建，并用 `doctor()` 对账。

## 3. Workflow 和 Gate

权威 schema：`WorkflowDefSchema`、`GateDefSchema`；加载器：[`src/workflow/loader.ts`](../src/workflow/loader.ts)；执行器：[`src/workflow/executor.ts`](../src/workflow/executor.ts)。

Workflow 必须声明节点、依赖和 gate。gate 至少包含：

- `role`
- `attach.node` 与所属节点一致
- `attach.when`：`pre` 或 `post`
- 一个或多个 `checks`
- `pass.require`：`all` 或 `any`
- `on_fail`：`block`、`warn` 或 `escalate`
- 可选的 `timeout`

checker 结果是 `pass`、`block` 或 `warn`。未知 checker、抛错和非法返回值都按 `block` 处理。

人工 gate 的事实顺序是：

```text
gate.waiting → human.decision.recorded → gate.resolved
```

## 4. 投票

权威实现：[`src/voting/executor.ts`](../src/voting/executor.ts)。

- voter 数量为 2 或 3。
- 每票独立调用 provider，选项顺序可单票置换。
- 输出必须符合结构化 verdict schema。
- 锚点经过 verifier；不可验证的票按弃权处理。
- 记录结论、模型、prompt hash、usage、响应 hash 和锚点重合度。
- 少数派理由进入 `VoteRecord.minority`。

投票执行器只返回记录，不直接写账本；写回必须由调用方追加 `vote.completed` 和后续账本事件。

## 5. 版本和兼容性

- 事件 envelope 当前为 `schema_version: "1"`。
- reducer 当前为 `REDUCER_VERSION = "1"`。
- Workflow 当前为 `agent-cord.dev/v1alpha1`。
- 修改跨模块契约前先更新对应 ADR，并补成功、失败和恢复路径测试。

