# 调研发现

## 当前实现可直接复用

- `src/core` 已提供事件信封、单写者 JSONL、确定性 reducer、账本重建和 doctor。
- `src/workflow` 已提供 YAML workflow schema、引用校验、拓扑执行、内置 checker、人工 gate 接口和事件恢复。
- `src/voting` 已提供 k=2~3 盲评投票、结构化模型输出、锚点校验和少数派留痕。
- `src/driver` 已提供 ACP 与 headless driver，包含超时、权限请求和进程清理。
- `src/index.ts` 已把上述模块作为库 API 导出。

## 当前缺口

- 没有 daemon、HTTP API、SSE/WebSocket 事件推送或运行实例索引。
- CLI 只有 init/new/doctor/demo/events，没有面向用户的需求工作台和 workflow run 命令。
- workflow 仍是 M2 内置 checker；CEL 和 MCP 外部 checker 尚未接入。
- `SessionHandle` 以文件夹为边界，缺少项目、用户、SDLC 定义、运行、审批任务等产品层对象。
- 前端工程、设计系统、鉴权和配置版本管理均不存在。

## 设计结论

- 控制台只负责展示、配置和发起命令；状态判定继续由 backend/core 完成。
- 事件流继续是权威事实；服务数据库只能存派生索引、任务队列和连接状态。
- 前端实时更新优先采用 SSE；写操作用 REST/JSON，避免第一版引入双向 WebSocket 状态协议。
- SDLC 定义使用版本化 YAML/JSON schema，UI 生成配置，不允许在控制台执行任意脚本。
- 第一版采用本地单用户模式，保留 workspace/user/role 边界，为后续多用户鉴权留接口。

## 实现校准（2026-09-25，MVP 落地）

- npm workspaces 注意：根包不会被自动链入 node_modules，子包引用根包用 `"agent-cord": "file:../.."`；根 exports 增加 `development` 条件（→ src/index.ts），tsx/vitest/tsc customConditions 用它免构建跑 dev 与测试。
- Fastify：`reply` 是 thenable，handler 中 `await reply.code(...)` 死锁；SSE 用 `reply.hijack()` + `reply.raw` 手写帧。
- node:sqlite（Node 25 内置）做派生索引零原生依赖；`forceCloseConnections: true` 让 app.close() 不被 keep-alive 拖住。
- 人工 gate 桥接：执行器先落 `gate.waiting` 事件再调 `HumanGate.ask` —— ask 时扫事件流即得当前审批定位键；重启后无在途执行器时决策进暂存 Map，恢复执行时消费。
- 审批幂等定位：`approval_id = base64url(node_id/gate_id)`，审批无独立事实存储，全部从事件流投影。

## 实现校准（2026-10-06，快照与自定义 artifact）

- `readSnapshot` 原先只读取 `prd.md`、`plan.md`、`adr.md`、`findings.md`；自定义 SDLC 的上游 artifact 会被上下文包遗漏。
- `settleArtifact` 原先直接 `join(session.dir, node.artifact)`；workflow 定义可携带 `../` 或绝对路径，存在越出 session 目录的写入风险。
- coordinator 派发事件只有 prompt 摘要，没有记录本次上下文基线；加入 snapshot 指纹和事件序号后，可审计 worker 使用的最新快照来源，恢复仍按事件流重新采集。

## 实现校准（2026-10-06，工作区独立 agent 配置）

- `registerAgentsYaml` 把自定义 args 写进 headless 的全局 Map；`HeadlessDriver.buildArgv` 每次重新查 Map，同名条目会污染其他工作区或已构造的 driver。
- `parseAgentsYaml` 对所有条目整体校验，单条 schema 错误会阻断整个文件，与逐条降级的文档承诺不符。
- `loadAgentsFile` 捕获全部读取异常并视为文件不存在，权限/IO 故障会静默失去自定义配置。
- server 启动时只加载一次 `agents.yaml`，缺少清单与重载入口；计划增加配置快照，让在途 run 固定其 resolver，后续 run 使用新配置。

## 实现校准（2026-10-06，协调快照一致性）

- `session.readLedger` 仅读磁盘投影，coordinator 在 run 尚未结束时可能看不到最近的 ledger 事件；直接调用纯 reducer 处理本次 readOrdered 返回的事件，可避免副本滞后且不写投影文件。
- `readSnapshot` 没有 workflow 过滤，同名节点的历史退出会进入当前流程的上下文。
- 快照准备和 artifact 写回位于 coordinator 的 driver try/catch 之外，会出现 started 后没有 completed 的异常；驱动解析失败也会被外层 retry 循环重复执行，与文档不符。
- 目录词法校验不能发现符号链接，固定 `${file}.tmp` 也可指向外部文件；artifact 可命名为 events.jsonl/ledger.yaml，必须在派发前拒绝。
