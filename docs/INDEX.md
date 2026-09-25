# agent-cord 文档索引

> 当前实现状态：M2 最小闭环 + 控制台 MVP 已实现（2026-09-25）。先看当前实现，再按需要阅读协议、ADR 和设计归档。

## 主文档

| 文档 | 内容 |
|---|---|
| [README.md](../README.md) | 安装、运行、控制台操作和当前能力边界。 |
| [current-architecture.md](./current-architecture.md) | 当前代码的分层、数据布局、运行路径、API 和非目标。 |
| [protocol.md](./protocol.md) | 事件、账本、workflow、gate 和 voting 的实现协议速查。 |
| [10-roadmap.md](./10-roadmap.md) | 后续工作、已完成项和未实现能力。 |
| [adr/](./adr/) | 不可替代的架构决策记录。 |
| [research/](./research/) | 调研和设计评审归档，不作为当前实现说明。 |

## 阅读路径

| 目的 | 顺序 |
|---|---|
| 只想运行项目 | [README](../README.md) |
| 想理解当前代码 | [current-architecture.md](./current-architecture.md) → [protocol.md](./protocol.md) |
| 想修改跨模块协议 | [protocol.md](./protocol.md) → [adr/](./adr/) → 源码和测试 |
| 想了解未来设计或风险 | [10-roadmap.md](./10-roadmap.md) → 旧章节 → [research/](./research/) |

如果时间只够读一份技术文档，读 [current-architecture.md](./current-architecture.md)。它描述的是当前代码，而不是未来设计。

## 术语速查

| 术语 | 当前含义 | 入口 |
|---|---|---|
| **共识快照** | 单个需求的文件夹，含快照文档、账本和事件流。 | [current-architecture.md](./current-architecture.md) |
| **全局 session** | 以单个需求为锚定单位的流程上下文。 | [02-requirements.md](./02-requirements.md) |
| **账本** | `ledger.yaml` 中的带证据结论集合，由事件流确定性投影。 | [protocol.md](./protocol.md) |
| **事件流** | `events.jsonl` 中的 append-only 事实来源。 | [protocol.md](./protocol.md) |
| **门禁** | workflow 节点上的可配置检查点。 | [protocol.md](./protocol.md) |
| **校验器** | gate 引用的具体校验能力；未知或异常时 fail-closed。 | [protocol.md](./protocol.md) |
| **盲评投票** | k=2~3 票独立提交结论和证据锚点。 | [protocol.md](./protocol.md) |
| **证据锚点** | 结论与代码、测试、契约、知识或文档的可审计连接点。 | [04-consensus-ledger.md](./04-consensus-ledger.md) |
| **上下文包** | 提供给工作单元的最小上下文派生视图。 | [07-context.md](./07-context.md) |

## 参考文档约定

- 当前代码以 `src/`、`apps/` 和测试为准；当前行为入口见 [current-architecture.md](./current-architecture.md)。
- 跨模块契约以 `src/core/schema.ts`、`src/core/ports.ts` 和 [protocol.md](./protocol.md) 为准。
- 架构取舍以 [ADR](./adr/) 为准；正文不重复论证已经定稿的方案。
- `01`~`09`、`11`~`13` 和 `proposal-console-platform.md` 保留为历史设计和详细背景，不作为当前实现说明。
- `research/` 保存调研快照，外部版本、star、限额等信息需要重新核验后才能作为当前事实。
