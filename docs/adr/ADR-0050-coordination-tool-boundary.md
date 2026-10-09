# ADR-0050 ｜ 独立协调轮次的工具事件边界

- 状态：accepted（实现选型）
- 日期：2026-10-08
- 关联：ADR-0032（独立协调）、ADR-0049（协调输入身份）
- 来源：阶段 36 的协调消费者忽略 tool_use 事件

## 背景

独立协调只分析宿主提供的最新需求快照，prompt 和 ADR-0032 均禁止工具调用。readonly 仍允许读文件、查询 Git 等工具，自定义 ACP/headless driver 可以报告 tool_use 后继续输出合法 JSON；当前消费者会忽略这些工具事件并接受提议。轮次是否合规不能只由模型最终文本决定。

## 决策

协调消费循环遇到任意 tool_use，即中止传给 driver 的 AbortSignal、关闭迭代器并丢弃提议，保存 failed/driver 与固定中文原因。包括只读工具、未知或空工具负载，以及合法 result 之后才报告的工具事件。工具名称、参数、结果和 raw 均不进入协调事实；迭代器清理失败不能覆盖已经确认的工具违规原因。

该中止是宿主策略失败，不生成 cancel_requested，不冒充用户取消。用户实际取消仍按既有 cancelled 优先级处理，事件追加失败仍上抛；重启不重放失败调用，新轮次读取新快照并使用新 driver 会话。普通 worker 的工具通道保持原行为。

ACP 的取消发送序列只启动一次；消费方提前关闭和 prompt 收尾共用并等待该有界序列，再关闭连接或回收进程，避免立即 iterator.return 抢在 session/cancel 发送之前杀掉 agent。等待仍受既有发送预算与 SIGTERM/SIGKILL 上限约束。

协调输入绑定 tool_policy=none.v1，带执行观察的域从 v6 升为 v7，无执行观察的库模式从 v4 升为 v5。完成、查询和采用共用该策略身份；旧域成功提议保留历史但须重新协调，不凭缺失的工具审计信息推断合规。

## 理由

角色边界由消费工具事件的宿主执行，跨供应商封装采用同一契约。复用现有 failed/driver、AbortSignal 和进程清理机制，不增加新的工具执行端口、凭据记录或模型调用。

## 边界

这是报告工具事件后的终止与结果拒绝，不能证明事件到达前没有副作用，也不能发现 driver 隐瞒的操作或替代 OS 沙箱。只读配置和外部 CLI 权限仍须正确设置。不会回滚已发生的文件变化、批准 gate 或采用真实 Draft。

## 证据

- `src/coordinator/session-agent.ts` 的事件消费循环和 ADR-0032 的拒绝工具约定。
- `src/driver/headless.ts` / `acp.ts` 将供应商工具通知统一映射到 tool_use。
- 外部架构资料与实际反例、验收记录见 `docs/research/2026-10-08-coordination-tool-boundary.md`。
