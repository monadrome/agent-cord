# 工作进度

## 2026-09-24

- 读取项目指令、README、核心 schema/ports、workflow、roadmap 和架构文档。
- 确认当前是 M2 核心内核，没有前端和后端服务层。
- 方案方向确定为：React/Vite 控制台 + TypeScript 后端服务 + 现有 core 作为领域内核 + SSE 实时事件 + 版本化 SDLC 配置。
- 已写入正式方案文档 `docs/proposal-console-platform.md`，包含目标架构、默认 SDLC、API、数据边界、后端优化、人工参与和分阶段验收标准。

## 2026-10-07

- 复核阶段 12 已提交实现与当前工作树，确认自定义 ACP/headless agent、配置身份、最新快照和节点级协调均已存在。
- 开始阶段 13：准备增加独立 Context Session Agent，目标是把 session-level 协调提议变成可验证、可恢复、可供 server 调用的协议能力。
- ADR-0032 先行；新增 ContextSessionAgent、严格 JSON 提议/schema、轮次事件与独立上下文预算，不注入事件正文/旧提议，结果返回前重检输入。
- server 增协调轮次创建/列表/读取/取消，固定 resolver、同需求在途互斥、同键并发合并；重启明确 interrupted，不重放模型调用。REST 幂等缓存拒绝跨 method/path 复用同键。
- 定向 47 测试 / 3 文件通过，包括真实 headless/ACP 子进程、在途配置固定、在途输入变更、取消/超时和重启恢复；准备全量 workspace 验证。
- 最终 470 测试 / 40 文件通过，`npm run typecheck`、`npm run build:all`、`git diff --check` 通过；补充未过滤 workflow 快照的取消隔离回归。
- 实际 HTTP 验收：ok/stale/cancelled/timeout 终态准确，过期提议为 null，health/doctor 全绿，没有 workflow.node 事件。临时预览 `http://127.0.0.1:7296`，工作区 `/tmp/cord-stage13-preview`，smoke-result.json 保留结果。
- 当前原型提供库与 REST，console 独立操作面板和 Draft 提议受控消费留作持续目标的下一阶段；不声称全部持续目标完成。
- GitHub 远端查询报 10 秒低速超时，准备按仓库约定保留本地功能提交并尝试有界推送。
- 本地功能提交 `12f0643`；HTTP/1.1 推送达到 45 秒上限，GitHub 报低于 1 bytes/sec 持续 15 秒。远端更新未确认，本地提交保留；预览 API 仍正常。
- 开始阶段 14：核验干净工作树与提交，接入协调 console 操作面和受控采用；先落 ADR，采用前重检最新输入/配置，推进仍交给已有 workflow runner。
- ADR-0033 与 adopted 事实、历史 status/当前新鲜度分离、原别名保留；采用在 RunService 槽位内重检，事件失败不派发、同轮并发/重启重放返回原 run。
- console 新增协调子视图和 typed client：agent/版本/超时、创建/取消、历史/结构化提议、来源跳转、server 新鲜度与显式采用；沿用现有 token 和 lucide 图标。
- 53 个定向用例 / 4 文件通过，build:all/typecheck 通过；进入实际浏览器和完整 workspace 验证。
- 全量首轮复现终态/槽位释放竞态，修复后 487 测试 / 41 文件通过；浏览器复现文档切换迟到读取覆盖编辑，已同步 loading 并限制加载/保存期间的操作。
- 第二轮 Playwright 完整通过，1440/390/320 无溢出/重叠，无 pageerror；已覆盖创建/取消/超时/坏输出/选择题/来源跳转/新鲜度/失败保留历史/采用/人工 gate/重复采用/空态/加载。
- 最后审查增加 coordination_round_id 的运行登记与 SQLite 旧表兼容，恢复缺少 adopted/requested 绑定事实时失败、不派发。29 个相关用例 / 3 文件与 typecheck 通过，准备最终全量与预览验收。
- 最终 491 测试 / 42 文件、`npm run typecheck`、`npm run build:all`、`git diff --check` 全通过；最新代码第三轮浏览器闭环再次通过，1440/390/320 无溢出/重叠、pageerror=0。
- 完整验收证据 `/tmp/cord-stage14-preview-r3/browser-result.json` 与 coordination-desktop/mobile/stale/adopted.png；保留可直接采用的离线预览 `http://127.0.0.1:7300/#/requirements/REQ-COORDINATION/coordination`，工作区 `/tmp/cord-stage14-preview-final`，preview-result.json 证明 current/adoptable/health/doctor 均为 true。
- 阶段 14 已实现并验证，进入本地提交与推送；持续目标下一步优先检查 SDLC 发布版本进度隔离，随后继续共享幂等边界与真实需求 dogfooding。
- 功能提交 `2f9823e`，推送成功（origin/exp/impl：`2559083` → `2f9823e`）；阶段 11–13 的积压提交一并同步。实际验收 SQLite run=completed 且持久化协调绑定正确，预览 health 仍为 true。

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

### run 取消与执行体可靠性（ADR-0025）

- 目标：run 必须能停（agent 跑飞只能杀进程不可接受）+ 瞬态失败（限流/网络）不该让人重跑整个 run。生态收敛证据：Temporal 的 Signal 先落历史再响应、LangGraph interrupt、vibe-kanban 停止语义。
- 新增 ADR-0025；docs/adr/README.md 索引同步（24→25，实现选型 8→9 项，地图补第 17 行）。
- 新事件 `workflow.run.cancelled`（payload：workflow_id / run_id / reason?）；`NodeRunStatus` 与 `agent.task.completed.status` 增 `cancelled`（不算失败、不计入 failed 终态、不触发重试）。
- AbortSignal 贯穿链：`ExecutorOptions.signal` → 节点边界检查 + `NodeRunContext.signal` → coordinator 尝试边界检查 + `AgentTask.signal` → driver abort 即杀进程树并关闭事件流。人工 gate 挂起处 ask 与 abort 竞速，取消不落 `gate.resolved` 假判定。
- 关键实现教训：async generator 暂停在队列 `next()` 时 `iterator.return()` 会排队等当前 await 解决——worker 静默期消费方 break 收不掉进程。因此取消必须是 driver 级契约（`task.signal`），不能只是消费侧 break。
- `node.run.retry { max_attempts(1-10, 默认1), backoff_ms(默认0) }`：coordinator 按尝试循环、线性退避、可被取消即时打断；重试的上下文包附「上次尝试失败」摘要；每次尝试落独立 started/completed（带 attempt/max_attempts）。驱动解析失败属定义性错误，不重试。
- 终态判定 `computeFinalStatus` 按 run_id 匹配取消事件（历史 run 的取消不污染新 run）；取消使该流程未决 gate 从审批投影移除；run 终态枚举增 `cancelled`。`session-service.scanPendingApprovals` 的取消分支必须先于 gate 键守卫处理（取消事件没有 node_id/gate_id）。
- API：`POST /runs/:run_id/cancel`（幂等键；重复取消/已终态返回现状）。无在途执行器（server 重启后）也能取消：事件落盘 + 直接登记终态。
- apps/console：需求详情页增取消按钮与终态展示；api client 增 `cancelRun`。
- 新增 apps/server/tests/run-cancel.test.ts（3 用例）：取消等待人工的 run（事件落盘/终态/审批失效/重取消幂等）、取消在途 agent 任务（`fake-cli.mjs --sleep 60000` 被抢先终止，取消耗时 < 15s，completed{status:cancelled}）、取消后重新 start 断点续跑。fixture `--sleep` 复现了静默期死锁，driver 级 signal 契约修复后取消延迟从 60s+ 降至亚秒。
- 修掉一处被新用例放大的既有测试竞态：api.test.ts 的 SSE 用例只等首个 `workflow.node.entered` 就收尾，在途 run 会继续追加事件，与 afterEach 的 `rm -rf` 竞态（ENOTEMPTY：删掉 events.jsonl 后又被写回；全量跑 2/3 失败）。改为等 run 停在 review 人工 gate（停住后不再写盘）。
- 全量验证：322 测试 / 31 文件全绿（连跑 6 次无 flake）；`npm run typecheck` / `npm run build:all` 通过；docs/protocol.md、docs/current-architecture.md、README.md 同步。

## 2026-10-06（阶段 7）

- 基线复核：`npm test -- --run` 322 测试全绿，`npm run typecheck` 全绿。
- 发现动态 SDLC artifact 未进入快照，以及 artifact 写回缺少 session 路径边界和上下文 provenance。
- 新增 ADR-0026；`readSnapshot` 按 workflow artifact 动态采集，记录完整文档 hash、事件 seq、事件链 hash 和稳定 `snapshot_id`。
- `agent.task.started/completed` 带快照 provenance；自定义 artifact 进入上游上下文与定位符层。
- coordinator 写回限制在 session 目录内，支持嵌套路径、父目录创建和临时文件替换；越界路径落失败事件。
- 新增嵌套写回、越界失败、动态 artifact 和 provenance 回归测试；全量验证现为 325 测试 / 31 文件全绿，`npm run typecheck`、`npm run build:all`、`git diff --check` 全绿。

## 2026-10-06（阶段 8）

- 上一轮已完成并推送 `b06b96b`，本轮开始时工作区干净；上一轮属于已验证的功能进展。
- 复核 driver 与 server，确认全局模板污染、逐条诊断不完整及缺少在线重载。
- 开始实现工作区独立 agent 配置快照与清单/重载 API，在途 run 固定启动配置。
- 已实现 ADR-0027：自定义 args 使用工作区私有模板，driver 固定模板、旋钮、参数和 env；无效别名不能退回同名内置 agent。
- 新增 `AgentService`、`GET /agents` 与幂等 `POST /agents/reload`，串行原子替换；文件整体错误/IO 故障保持当前有效配置，响应仅公开元信息。
- 26 项定向测试通过，含真实子进程的跨工作区同名隔离、在途 run 固定旧配置、新 run 使用新配置、并发重载、删除、修复和挂起 run 重启续跑。
- README、协议、架构与 ADR 索引同步，开始最终全量验证。
- 重载入口补并发同键共享一次操作，失败后允许同键重试；修复旧 API 测试等待 node.exited 后过早断言 completed 的竞态。
- 最终验证：339 测试 / 32 文件通过，`npm run typecheck`、`npm run build:all` 与 `git diff --check` 通过。
- 实际 HTTP smoke：公开清单、显式重载、同键重放、临时 fake worker SDLC 到人工 gate 并完成；并发同键返回 revision [2,2] 且当前 revision 只递增一次。
- 预览服务 `http://127.0.0.1:7291`，临时工作区 `/tmp/cord-stage8-preview`，日志 `/tmp/cord-stage8-preview.log`；不写入仓库运行时数据。
- 本地功能提交 `f9dc09d`。GitHub 443 连接超时，首次推送未返回，停止后 20 秒有界重试仍失败；本地提交保留，远端尚未确认更新。

## 2026-10-06（阶段 9）

- 本轮开始工作区干净，HEAD 为 `8977912`。确认上一轮实现与测试已完成，远端检查仍超时。
- 开始完善最新快照：从一次事件读取派生账本、进度与 provenance，按 workflow 隔离进度；补准备/写回失败留痕与实际文件边界。
- ADR-0028 先行；账本直接从当前事件批次 reducer 投影，workflow 进度隔离，冲突保留并在上下文中标注。
- 新增 session-files：普通文档校验、保留路径拒绝、符号链接/硬链接拒绝、独占随机临时文件 + fsync + rename + 故障清理。
- 准备/配置/driver/artifact 的普通失败都有任务 completed 与 failure_stage/retryable，永久配置不重试；事件追加失败上抛，取消监听器完成后释放。
- 44 个 coordinator 定向测试通过，覆盖最新 PRD/账本多节点同步、写回恢复、瞬态重试、准备取消、事件追加故障、链接与原子写失败清理；开始完整 workspace 验证。
- 最终全量 366 测试 / 34 文件通过，`npm run typecheck`、`npm run build:all`、`git diff --check` 通过。
- 实际 HTTP smoke：人工 gate 期间更新 PRD 并追加账本事件，磁盘账本尚未更新时下一 worker 的 prompt 仍收到最新输入；快照目录错误落失败阶段，修复后重新 start 断点完成；health/doctor 全通过。
- 预览 `http://127.0.0.1:7292`，临时工作区 `/tmp/cord-stage9-preview`，结果 `/tmp/cord-stage9-preview/smoke-result.json`，日志 `/tmp/cord-stage9-preview.log`。
- 本地功能提交 `2af6de5`；推送返回 RPC/HTTP 408、sideband 断连，远端 `ls-remote` 核验在 15 秒内超时。提交保留，远端是否更新未确认；后续网络恢复时核验并推送全部待同步提交。

## 2026-10-06（阶段 10）

- 开始时工作区干净，HEAD 为 `da86b5d`；上一轮已实现并验证最新协调快照与失败恢复。
- 确认 ledger gate 仍有旧投影和冲突放行风险，artifact 仍会把执行前文档误记为当前 agent 产物；开始以最新事件和前后指纹修复。
- ADR-0029 先行，ledger gate 从最新事件投影，排除冲突条目、拒绝坏事件与跨 session 数据，保留显式投影 adapter 并验证 schema。
- artifact 按当前快照比较前后 hash，旧内容不误归因，无新产物失败；代写检查预期 hash，临时文件替换前发生编辑时保留人工内容并清理临时文件。
- 真实子进程测试发现明确空 CLI 结果被转成 null 并回退进度日志，已修复空字符串语义；headless/ACP 辅助文本保留 raw 并标记 metadata，不拼进产物。
- 88 个 driver/coordinator/server 定向测试通过，含空输出真实子进程阻断、配置重载修复、新产物指纹和最新 ledger gate 恢复；进入全量验证。
- 最终 401 测试 / 35 文件通过，`npm run typecheck`、`npm run build:all`、`git diff --check` 通过。
- 实际 HTTP 验收：旧磁盘 confirmed 已在事件中推翻时被阻断；新确认未刷投影也可恢复；worker 明确空结果不覆盖旧文档，重载修复后生成新产物，前后 hash 与文件一致，doctor 通过。
- 预览 `http://127.0.0.1:7293`，工作区 `/tmp/cord-stage10-preview`，结果 `/tmp/cord-stage10-preview/smoke-result.json`，日志 `/tmp/cord-stage10-preview.log`。
- 改用 HTTP/1.1 查询远端成功，exp/impl 当前仍为 b06b96b；准备同步本轮与此前全部本地提交。
- 本轮实现提交 `16090c6`；HTTP/1.1 推送成功（b06b96b → 16090c6），阶段 8/9 的积压本地提交已一并同步，无需改全局 Git 配置。

## 2026-10-06（阶段 11）

- 开始时工作区干净，HEAD 与 origin/exp/impl 均为 `2559083`；上一轮已完成并推送。
- 确认历史 ok 的盲目复用、pending gate 绕过检查、审批暂存未绑定版本；开始实现输入校验与版本化审批。
- 新增 ADR-0030：稳定 execution_input_hash 与 NodeRunner.isCompletionReusable，未退出节点输入或产物变化时重跑，控制事件不使 checkpoint 自失效。
- gate 使用统一 evaluateGate 与 evaluation_hash，等待前后重检、gate.invalidated 版本失效；过期 worker 先重跑再审批。
- 审批 ID 为 gate.waiting ULID，暂存/已落盘选择按版本消费，旧审批 409，同版本并发选择只记录一次；已决策审批不重复展示，重启自动消费匹配的持久化选择。
- 首轮全量 422 测试 / 37 文件通过，build:all 通过，开始最终类型检查与实际 HTTP 验收。
- 最终 424 测试 / 37 文件通过，`npm run typecheck`、`npm run build:all`、`git diff --check` 通过。
- 实际 HTTP smoke：输入不变重启只执行 worker 1 次且审批 ID 不变；人工等待时 PRD 更新使旧审批返回 409、先重新派发最新输入再生成新审批（worker 共 2 次）；账本推翻使旧审批失效并机器阻断，没有伪造人工决策。health/doctor 通过。
- 预览 `http://127.0.0.1:7294`，临时工作区 `/tmp/cord-stage11-preview`，结果 `/tmp/cord-stage11-preview/smoke-result.json`，日志 `/tmp/cord-stage11-preview.log`。
- 本地实现提交 `9b42fa0`；推送报 GitHub 低速超时，45 秒有界重试未返回，远端 ls-remote 15 秒核验超时。提交保留，远端更新未确认；预览 health 仍为 200。

## 2026-10-06（阶段 12）

- 工作区干净，HEAD `05cd4d8`；上一轮为有已验证实现的进展，远端仍待核验。
- 开始将有效 agent 启动身份纳入任务恢复/审批指纹，并为已有 agent 清单与重载 API 增加 console 工作台。
- ADR-0031 先行：内置 driver 固定 configuration_hash，排除全部 env；task 记录 agent_configuration_hash，并纳入 execution_input_hash v2 与审批上下文。在途 run 保持原身份，重启参数变化拒绝旧审批并重新生成任务。
- console 新增 Agent 导航与工作台，typed client 复用公开 DTO，提供搜索/来源/协议筛选、诊断、刷新、显式重载和失败保留清单；仅新增 lucide-react 图标依赖。
- 436 测试 / 38 文件通过，typecheck/build 通过；真实 HTTP 验证 live reload 不改变在途配置、重启变更使旧审批 409 且 worker 重跑。
- Playwright + Chrome 验证 1440/390/320 宽度无溢出/行内重叠；筛选、tooltip、按钮在请求期间禁用、重载成功/失败保留清单、loading/empty/error retry 全通过，pageerror 为 0。桌面/手机截图已人工检查并修正页头与长名称断行。
- 预览 `http://127.0.0.1:7295/#/agents`；临时工作区 `/tmp/cord-stage12-preview`，smoke-result.json / browser-result.json 与 agents-desktop.png / agents-mobile.png 保存实际验收证据。
- 唤醒后重跑全量 436 测试 / 38 文件通过，`npm run typecheck`、`npm run build:all`、`git diff --check` 通过；阶段 12 进入提交与推送。
