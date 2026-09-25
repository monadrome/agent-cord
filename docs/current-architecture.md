# 当前实现架构

> 状态：已实现的 M2/MVP（2026-09-25）。本文描述仓库当前代码，不替代 ADR 的决策记录。

## 1. 一句话概览

agent-cord 是一个本地单用户的需求协作服务：事件流保存事实，纯 reducer 生成账本，workflow runner 推进 SDLC，Fastify server 提供 REST/SSE，React console 只展示 server 投影。

```text
React console
    │ REST 命令 / SSE 事件
    ▼
Fastify server
    ├── SessionService：需求文件夹、文档和投影
    ├── RunService：workflow runner、人工 gate、恢复
    ├── SdlcService：YAML 校验和发布版本
    └── IndexStore：幂等键与运行登记（派生数据）
    │
    ├── cord/<req-id>/events.jsonl  事实来源
    ├── cord/<req-id>/ledger.yaml   reducer 投影
    └── cord/.sdlc/                 SDLC 发布版本
```

## 2. 仓库边界

| 目录 | 当前职责 |
|---|---|
| `src/core` | EventEnvelope、JSONL store、哈希链、reducer、session、doctor |
| `src/workflow` | YAML workflow、拓扑执行、内置 checker、人工 gate 端口 |
| `src/voting` | k=2~3 盲评、锚点校验、投票判定和留痕结构 |
| `src/driver` | ACP 与 headless agent driver |
| `apps/server` | Fastify REST/SSE、运行服务、SDLC 服务、派生 SQLite 索引 |
| `apps/console` | React/Vite 控制台；不复制 reducer 或状态机 |
| `tests`、`apps/*/tests` | 与源码对应的离线测试和 server API 测试 |

跨模块结构以 [`src/core/schema.ts`](../src/core/schema.ts) 和 [`src/core/ports.ts`](../src/core/ports.ts) 为准。

## 3. 数据和写入路径

每个需求对应 `cord/<req-id>/`：

```text
prd.md plan.md adr.md findings.md  # 可人工编辑的快照文档
events.jsonl                       # append-only 事实来源
ledger.yaml                        # 可重建的账本投影
```

状态变更只能通过 `session.events.append`。事件写入时由 store 分配 `seq`、`prev_event_hash` 和时间戳，落盘并 fsync 后才通知订阅者。`ledger.yaml` 由 `createReducer().reduce(events)` 重建；`doctor` 检查事件链、序号、session 身份和投影一致性。

`cord/.index/server-index.sqlite` 只保存幂等键和 run 登记。删除它不会删除需求事实，但会丢失运行查询和幂等重放缓存。

## 4. Workflow 和运行

Workflow 定义是 `agent-cord.dev/v1alpha1 / Workflow` YAML。加载时检查 schema、节点依赖、gate 引用、环和 checker 名称。执行器按稳定拓扑序推进节点：

1. 读取事件流，跳过已经有 `workflow.node.exited` 的节点。
2. 写入 `workflow.node.entered`。
3. 顺序执行 gate；checker 抛错或返回非法结果时 fail-closed。
4. 人工 gate 写入 `gate.waiting`，由 server 的审批接口恢复。
5. 写入 `gate.resolved` 和 `workflow.node.exited`。

server 当前使用进程内 runner。同一需求同时只允许一个在途 run。重启时根据 run 登记和事件流重新扫描节点；已完成节点不重跑，未完成节点重新求值。

默认 `simple-sdlc v1` 流程为：

```text
intake → align → plan → implement → verify → review → done
```

当前默认流程包含证据 gate 和人工 review gate，但尚未自动产出真实投票结果。

## 5. Server 和 API

server 默认监听 `127.0.0.1:7250`，工作区由 `CORD_ROOT` 指定。核心接口包括：

- 查询：`/health`、`/dashboard`、`/requirements`、需求详情、timeline、ledger、votes、runs、approvals。
- 命令：创建需求、编辑快照文档、启动 run、处理人工审批。
- 实时：`/requirements/:req_id/events/stream`，使用事件 `seq` 作为 SSE id，并支持 `Last-Event-ID` 回放。
- SDLC：列表、读取版本、validate、publish。
- 维护：`POST /doctor`。

写命令需要 `Idempotency-Key`。错误统一返回 `code`、`message`、`details` 和 `request_id`。

## 6. Console

console 使用 hash 路由，页面包括工作台、需求列表、需求详情和 SDLC 管理。它通过 `apps/server/src/contracts.ts` 共享 DTO，只消费 server 投影；事件流、账本和 workflow 状态不在浏览器重复计算。

## 7. 当前非目标

以下能力仍属于后续工作：

- 飞书等 IM 适配、多用户鉴权和远程部署；
- run 取消、持久化任务队列和跨进程 lease；
- CEL、外部 checker 插件和权限审批桥；
- 知识库检索、文档防腐钩子；
- 默认 SDLC 的真实 agent/voting 产出。

详细决策见 [`docs/adr/`](./adr/)，未来设计和调研见 [`docs/research/`](./research/) 以及旧版章节文档。

