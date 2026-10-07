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
- 继续审查 gate 的 ledger checker 是否仍使用滞后投影，以及旧 artifact 是否被误归因于当前 worker。
- 全局 REST 幂等缓存仍需审查其他写入口的并发同键与跨路由复用；本轮仅为 agent 重载入口合并同键在途请求。

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
