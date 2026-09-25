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
