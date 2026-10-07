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
- [ ] 提交与推送

### 验证记录

- 首轮 2 条旧解析测试仍断言单条无效配置应整体抛错；将按 ADR-0027 的逐条诊断语义更新，并补阻断错误别名的实际运行验证。
- workspace typecheck 优先读取根包的旧 `dist` 声明，新增导出需先 `npm run build` 再验证；根内核 source typecheck 已通过。
- 新增 server 测试的非人工分支未声明任何 gate，被发布校验正常拒绝；已给所有分支增加产物证据 gate，人工确认只在在途重载用例开启。
- 首轮全量 337/338 通过；旧 API 用例只等待最后一个 node.exited，runner 仍在登记终态/重建账本时就断言 completed。改为继续轮询实际对外完成状态，避免增加固定延迟。
- 首轮后台预览启动的 shell 进程未存活，实际 HTTP 拒绝连接；改用 detached Node 子进程并验证 pid/健康后启动成功。
- 补测复现重载并发同键返回 revision [2,3]，增加入口共享在途 Promise，首次响应持久化后释放映射，保证一次操作。

### 待继续核验

- `readSnapshot` 使用 `readLedger()` 的已有投影，运行中事件变化可能未反映进账本快照。
- artifact 目前只做词法目录边界校验，符号链接与写回异常的失败事件仍需审查。
- 全局 REST 幂等缓存仍需审查其他写入口的并发同键与跨路由复用；本轮仅为 agent 重载入口合并同键在途请求。
