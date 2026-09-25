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
