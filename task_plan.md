# 控制台与平台化方案

## 目标

为 agent-cord 增加一个前端控制台和可承载它的后端服务。控制台保留现有事件、账本、投票、工作流、agent driver 能力；用户可以直接创建需求、运行默认 SDLC、处理人工门禁，并通过配置定制自己的 SDLC。

## 阶段

- [x] 阶段 1：盘点现有 core、workflow、voting、driver 与 CLI 能力
- [x] 阶段 2：确定控制台信息架构、后端边界、默认 SDLC 与定制模型
- [x] 阶段 3：形成 API、数据模型、模块拆分、交付顺序与验收标准
- [x] 阶段 4：实现后端服务骨架（apps/server：Fastify REST + SSE + node:sqlite 派生索引 + 进程内 runner + 人工 gate 桥接；ADR-0021/0022）
- [x] 阶段 5：实现控制台 MVP（apps/console：React + Vite）
- [x] 阶段 6：端到端验收（全量 build/typecheck/test + 启动服务 smoke test，2026-09-25 全绿）

## 当前状态

方案已定稿（`docs/proposal-console-platform.md`）。2026-09-25 完成 MVP 实现：npm workspaces（根 + apps/server + apps/console）、REST/SSE API、默认 SDLC（simple-sdlc v1）、SDLC validate/publish、幂等键、server 重启恢复。工作区原有未提交改动（事件协议增强 + merge driver）全部保留，未做破坏性 git 操作。

## 未决问题

- ~~是否先做本地单用户模式~~ → 已定：本地单用户（ADR-0021 决策 8），多用户鉴权留待后续 ADR。
- ~~是否允许服务数据库保存派生运行索引~~ → 已定：node:sqlite 只存幂等键与 runs 登记，投影实时派生不落库（ADR-0021 决策 3）。
- 默认 SDLC 的节点和人工 gate 是否需要组织级强制项（后置）。

## 错误记录

- Fastify 的 `reply` 是 thenable：handler 里 `await reply.code(201)` 会死锁（等响应发出，而响应要等 handler 返回）。一律 `reply.code(...)` 不 await。

## 阶段 7：动态快照 provenance 与自定义 artifact 边界（已完成）

- [x] 为快照采集 workflow 声明的自定义 artifact，并生成可审计指纹
- [x] 为 coordinator 写回路径增加 session 目录边界校验与父目录创建
- [x] 在 agent.task 事件中记录 snapshot_id / event_seq，补成功、失败、恢复测试
- [x] 同步 ADR、协议文档、进度与调研记录
- [x] 运行全量 test、typecheck、build 和 diff 检查

## 错误记录（阶段 7）

暂无。

## 阶段 8：工作区独立 agent 配置与显式重载（已完成）

持续目标：优化 SDLC、自定义 ACP/Claude/Codex agent 与基于最新需求快照的协调 session agent，交付可验证的原型或生产实现。

- [x] 确认全局模板污染、读取失败静默降级、配置不能在线重载的现状
- [x] ADR-0027 与独立 registry：逐条诊断、无效别名阻断、driver 固定模板
- [x] agent 清单与重载 API：公开元信息、原子替换、失败保留有效配置
- [x] run 启动时固定 resolver，离线覆盖多工作区、在途重载与重启
- [x] 全量 test/typecheck/build 与 diff 审查
- [x] 本地提交 `f9dc09d`；推送因 GitHub 443 连接超时未完成，保留提交待网络恢复

### 验证记录

- 首轮 2 条旧解析测试仍断言单条无效配置应整体抛错；将按 ADR-0027 的逐条诊断语义更新，并补阻断错误别名的实际运行验证。
- workspace typecheck 优先读取根包的旧 `dist` 声明，新增导出需先 `npm run build` 再验证；根内核 source typecheck 已通过。
- 新增 server 测试的非人工分支未声明任何 gate，被发布校验正常拒绝；已给所有分支增加产物证据 gate，人工确认只在在途重载用例开启。
- 首轮全量 337/338 通过；旧 API 用例只等待最后一个 node.exited，runner 仍在登记终态/重建账本时就断言 completed。改为继续轮询实际对外完成状态，避免增加固定延迟。
- 首轮后台预览启动的 shell 进程未存活，实际 HTTP 拒绝连接；改用 detached Node 子进程并验证 pid/健康后启动成功。
- 补测复现重载并发同键返回 revision [2,3]，增加入口共享在途 Promise，首次响应持久化后释放映射，保证一次操作。
- GitHub 443 连接超时：停止无输出推送后，20 秒有界重试仍超时，保留本地提交；下一轮先核验远端并重试。

### 待继续核验

- 阶段 9 已解决 coordinator 的旧账本、跨 workflow 进度、链接路径和写回异常留痕。
- 阶段 10 已解决 ledger gate 的滞后/冲突放行、旧 artifact 误归因与协议日志冒充产物。
- 阶段 11 已解决未退出 worker 的输入/产物复用校验与版本化审批、等待期间变更重检、已落盘决策恢复。
- 继续核验普通文件 checker 的物理路径边界、同 workflow ID 不同发布版本的已退出进度是否隔离，以及 agent 配置变化的任务输入标识。
- 全局 REST 幂等缓存仍需审查其他写入口的并发同键与跨路由复用；本轮仅为 agent 重载入口合并同键在途请求。

## 阶段 11：恢复输入校验与版本化人工审批（已实现并验证）

- [x] 核验当前分支与阶段 10；上一轮实现和远端同步属于已验证进展
- [x] ADR-0030：稳定 execution_input_hash、未退出节点的 completion 复用校验
- [x] gate 统一求值指纹、等待前后重新检查、依据变化时 invalidated/recheck
- [x] 审批 ID 绑定 workflow/node/gate/waiting 事件，旧请求与旧暂存决策不能用于新审批
- [x] 覆盖不变输入恢复、PRD/账本/产物更新、人工等待变化、重启与旧审批拒绝
- [x] 全量验证、实际服务验收与文档同步
- [ ] 提交与推送

### 验证记录（阶段 11）

- 首轮类型检查定位到 HumanGateAnswer 新响应的窄化与 evaluation_hash 参数放置，已修正。
- 审批 JSON 编码超过 Fastify 参数上限，改用等待事件 ULID；随后补齐遗漏的 ULID_RE import。
- 旧 checkpoint 用例没有真实上游进度，改成完整 executor 在 completed 与 exited 之间模拟中断。
- 首轮全量 422 测试 / 37 文件通过，build:all 通过；输入/产物变更、连续恢复、版本化审批与已落盘决策恢复有明确回归。
- 实际预览首轮因 fixture 的 file-nonempty 参数漏填被阻断，脚本超时退出并确认 pid 不存在；改用结构化 YAML 参数后重新运行。
- 最终 424 测试 / 37 文件通过，typecheck/build:all/diff 检查通过；额外覆盖同名跨 workflow 审批、迟到旧失效事件和等待同步取消。
- 实际 HTTP 验收：不变输入重启 worker 调用保持 1 次，PRD 更新后旧审批 409、worker 调用 2 次，共识推翻后机器 block，health/doctor 通过。

## 阶段 10：最新账本门禁与当前产物证据（已实现并验证）

- [x] 核验阶段 9 的实际提交与工作区；上一轮为已验证进展，远端仍待确认
- [x] ADR-0029：ledger gate 从最新事件投影，排除冲突条目，读取失败不回退旧投影
- [x] artifact 前后指纹、旧内容不误归因、新文本代写、无产物失败与观测到的写回冲突阻断
- [x] 覆盖 checker/session/目录读取、瞬态恢复、产物恢复与 server 闭环
- [x] 全量测试、typecheck/build、实际服务验收与 diff 审查
- [x] 本轮提交 `16090c6`；使用 HTTP/1.1 成功推送 exp/impl，阶段 8/9 的积压提交一并同步

### 验证记录（阶段 10）

- 首轮回归复现 15 个失败：旧账本放行、冲突放行、非法 entry_id 扩大范围、旧产物误归因、无输出假成功和失败部分产物复用。
- 实现后新回归通过，3 个旧 loader 测试因 fake 事件流为空失败；更新替身为带合法血统链的事件数据，并把读故障注入事件端口。
- 更新后 132 个相关测试通过；继续补真实 IO 阶段编辑冲突、session 身份边界与 server 端到端产物指纹验证。
- 首轮 server 空结果用例等待超时：CLI adapter 把明确 `result: ""` 转为 null，导致 coordinator 回退协议/进度日志。修复空字符串语义，标记已识别辅助输出，不拼作产物。
- 最终 401 测试 / 35 文件通过，typecheck/build:all/diff 检查通过；真实 HTTP 旧共识阻断、空输出阻断、修复恢复、前后指纹与 doctor 验收通过。
- HTTP/1.1 远端查询成功，exp/impl 当前为 b06b96b，此前本地提交确未同步；本轮使用该传输设置尝试推送。
- 推送成功：b06b96b → 16090c6，远端 exp/impl 已包含阶段 8、9、10 的实现和验收记录。

## 阶段 9：协调快照一致性与失败恢复（已实现并验证）

- [x] 复核工作区与阶段 8；属于已完成的本地实现进展，推送仍待网络恢复
- [x] ADR-0028：同一事件批次派生 ledger/progress/hash，进度按 workflow 过滤
- [x] session 文档读取/写回校验：拒绝事实文件、链接与非普通文件，独占临时文件原子写入
- [x] 快照准备/写回错误记 started/completed；不可重试错误止步，事件写入失败上抛
- [x] 覆盖最新账本、跨流程进度、失败恢复、文件边界与事件存储故障
- [x] 全量验证和实际服务验收
- [x] 本地提交 `2af6de5` 并尝试推送；HTTP 408 断连，远端核验超时，保留本地提交

### 验证记录（阶段 9）

- 远端 `ls-remote` 在 15 秒内未返回，已停止本轮检查；继续本地功能工作，结束时有界重试推送。
- 新增回归先复现 14 个失败点，原先 19 个行为通过；实现后首轮 33 个定向测试通过。
- build 暴露 AbortSignal 的 TypeScript 跨 await 窄化问题；取消复查改为显式 Boolean 读取最新状态。
- 最终验证 366 测试 / 34 文件通过，typecheck/build:all/diff 检查通过；实际 HTTP 最新上下文与失败恢复闭环、health/doctor 均通过。
- 推送报 RPC/HTTP 408 与 sideband 断连，`ls-remote` 15 秒超时；不能把伴随的 Everything up-to-date 当作成功，远端更新仍未确认。
