# 工作进度

## 2026-09-24

- 读取项目指令、README、核心 schema/ports、workflow、roadmap 和架构文档。
- 确认当前是 M2 核心内核，没有前端和后端服务层。
- 方案方向确定为：React/Vite 控制台 + TypeScript 后端服务 + 现有 core 作为领域内核 + SSE 实时事件 + 版本化 SDLC 配置。
- 已写入正式方案文档 `docs/proposal-console-platform.md`，包含目标架构、默认 SDLC、API、数据边界、后端优化、人工参与和分阶段验收标准。

## 2026-09-25

- 按交接文档 `/tmp/agent-cord-handoff.KcQZOB/KIMI_HANDOFF.md` 执行实现；保留工作区未提交改动（事件协议增强 + merge driver）。
- 新增 ADR-0021（控制台与 server 分层）与 ADR-0022（SDLC 生命周期与版本绑定）；docs/adr/README.md、README.md、AGENTS.md 同步。
- npm workspaces 改造：根（agent-cord 内核）+ apps/server + apps/console；root exports 增加 `development` 条件指向 src（dev/test 免构建），`types`/`default` 仍指向 dist（发布不变）。
- apps/server（Fastify 5）：contracts（zod DTO，经 `@agent-cord/server/contracts` 共享给前端）、SessionService（投影实时派生）、RunService（进程内 runner + HumanGate 挂起 promise 桥接 + 重启恢复）、SdlcService（默认 SDLC 物化 + validate/publish）、IndexStore（node:sqlite，只存幂等键与 runs）、SSE（Last-Event-ID 回放）、统一错误、静态托管 console dist。
- apps/server/tests/api.test.ts：13 个用例全绿（幂等重放、默认 SDLC 端到端人工 gate、拒绝 → blocked、SSE 回放/实时/Last-Event-ID、重启恢复、索引删除重建、SDLC 校验/发布/绑定运行、doctor）。
- 踩坑：Fastify `reply` 是 thenable，`await reply.code(...)` 死锁（已记入 task_plan.md 错误记录）。
- apps/console（React 19 + Vite 7）由子代理实现中。

- apps/console 完成（子代理）：hash 路由 + Dashboard / 需求列表与创建 / 需求详情（概览时间线、文档编辑、账本、投票、SSE 事件、审批）/ SDLC 管理；`src/api.ts` 类型化 client（复用 `@agent-cord/server/contracts`，写命令自动带幂等键）。13 个用例全绿。
- 修复：新建需求后立即 `rebuildLedger()`，doctor 不再对新建需求误报漂移。
- 全量验证：`npm test` 24 文件 / 252 用例全绿；`npm run build` / `npm run build:all` / `npm run typecheck` 均通过。
- smoke test（CORD_ROOT=/tmp/cord-smoke，端口 7290）：健康检查 → 创建需求（同键重放 event_id 相同）→ 编辑 PRD → 启动 simple-sdlc v1 → SSE 回放 + Last-Event-ID=3 跳过已见 → review 人工 gate「确认放行」→ 7 节点全 exited、run completed、ledger 投影自洽、doctor 全绿；重启与删除 cord/.index 后状态从事件流恢复；`/` 与 SPA 深链均返回控制台页面。

## 2026-10-06

- 目标：可插拔 SDLC + 协调 agent（自定义 agent 派发 + 最新快照上下文），含开源调研（Claude Agent SDK subagents 独立上下文、OpenAI Agents SDK handoffs/guardrails、ACP 并入 LF A2A）。
- 新增 ADR-0023（node.run 声明执行体 + NodeRunner 端口 + 协调 agent 派发 + agents.yaml 注册）与 ADR-0024（checks[].with 参数化 checker）；docs/adr/README.md 索引同步（22→24）。
- schema/ports 契约扩展：EVENT_TYPES 增 `agent.task.started/completed` 及 payload schema；节点增 `run{agent,prompt?,readonly,timeout_ms?}`；checks 项增 `with` 参数；ports 增 NodeRunner/NodeRunContext/NodeRunStatus，CheckerContext 增 params/node_id。
- src/coordinator（协调 agent）：snapshot（每节点重建最新快照）、context-pack（两层剪裁：高信号层 PRD+上游产物+账本，定位符层文件路径，taskInstructions 占位符）、coordinator（NodeRunner 生产实现，artifact 双通道写回：agent 自写优先、代写 draft 带溯源头；不抛错，失败记事件）。
- src/workflow：执行器改为 pre gates → node.run（agentDone 扫点跳过已 ok，未注入记 notes）→ post gates；恢复时失败/超时的 agent 任务重试；8 个内置 checker（新增 file-exists/file-nonempty/doc-has-section/anchors-min-count/event-emitted，参数非法 fail-closed，path 限 session 目录内）。
- src/driver：agents.yaml 解析/注册（acp | headless | 自定义 args 模板，名 `^[a-z0-9][a-z0-9-]{0,63}`），叠加层优先于内置清单，逐条降级 warnings；server 启动时加载 `cord/agents.yaml`。
- apps/server：SDLC 草稿（draft.yaml，publish 后清除）、版本归档（索引表登记，归档禁止启动新 run → 409，幂等）、模板库四档（minimal/standard/strict/agent-collab）；RunService 注入 nodeRunner，agent 任务失败 → run failed。
- apps/console：需求详情启动 run 可选 SDLC+版本；SDLC 页重写（模板载入、草稿保存/恢复、克隆版本、归档切换）。
- smoke（CORD_ROOT=/tmp/cord-smoke）：模板库取 agent-collab 改 claude→fake → 校验发布 → 启动 run → align/plan/implement/verify 四节点经 fake agent 执行、coordinator 代写 plan.md（含代写溯源头）→ review 人工 gate 放行 → completed。
- 全量验证：303 测试 / 30 文件全绿；`npm run typecheck` / `npm run build:all` 通过；docs/protocol.md、docs/current-architecture.md、README.md 同步。
