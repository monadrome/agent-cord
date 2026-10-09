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

持续优化允许小步提交（用户于 2026-10-08 明确）：每个独立且通过验证的改动可单独提交并推送，推送失败时保留本地提交、记录具体原因并继续可独立开展的工作。

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

## 阶段 12：Agent 配置身份与控制台工作台（已实现并验证）

- [x] 复核阶段 11 的本地进展与现状：配置参数不在 checkpoint 中，console 缺 Agent 页面
- [x] ADR-0031：有效启动配置 hash，排除 env/凭据，纳入任务与审批语义输入
- [x] 内置 driver 固定配置身份，run 固定 resolver 与身份，重启配置变化使旧任务/审批失效
- [x] Console Agent 清单、搜索/来源/协议筛选、诊断、刷新/显式重载与失败保留状态
- [x] 离线契约/恢复测试、全量验证、desktop/mobile 浏览器验收
- [x] 本地功能提交 `6662ec0`；远端同步在后续实现结束时一并核验

### 验证记录（阶段 12）

- 首轮 45/47 通过，2 个旧 server 断言失败：新增清单 configuration_hash、重启参数改变后旧审批应 409。更新断言并增加配置未变的复用对照。
- 安装 console lucide-react，lockfile 仅新增该包与其 peer 标记；复用已有 Playwright 缓存准备浏览器验收。
- 首轮完整 436 测试 / 38 文件与 typecheck/build 通过；实际 HTTP 配置身份变化导致旧审批 409、重跑成功，live reload 保持在途配置。
- 首轮浏览器精准标签定位超时，发现 select 包裹标签含选项文本；改为独立 label/for 与显式 id 后重新验收。
- 第二轮浏览器通过：1440/390/320 无横向溢出与单元重叠，筛选、loading/empty/error retry、重载成功/失败保持清单均通过，无 pageerror；截图后微调手机页头与长名称断行。
- 最后一轮 5 个独立测试超时且构建耗时 86 秒；pmset 日志证明 22:17:27 Clamshell Sleep 持续 86 秒。测试已终止、机器已唤醒，保持原超时并重新全量验证。
- 唤醒后重跑全量 436 测试 / 38 文件通过，typecheck/build:all/diff 通过；异常确认与实现无关。

### 视觉方向

沿用现有控制台的浅灰白背景、蓝色操作、绿色可用与红色诊断，系统字体和等宽名称；使用紧凑列表与细分隔线。配置版本与生效记录在页头，按来源和协议扫读；页面不引入营销区块或嵌套卡片。

## 阶段 13：Context Session Agent（已实现并验证）

持续目标：把协调 agent 从仅附着于 `node.run` 的隐式执行体，提升为可独立调用、按最新需求快照重建、带结构化提议和 provenance 的 session-level 协调入口。

- [x] 盘点现有 coordinator、driver、workflow executor 与 server run 生命周期，确认缺口是独立 session 协调 API，而非新增 worker driver
- [x] ADR-0032 与 session agent 契约：快照输入、结构化协调提议、事件 provenance、fail-closed 解析
- [x] 实现 `ContextSessionAgent`：每轮重建快照、调用 resolver 固定的协调 driver、解析/校验提议、记录可审计结果
- [x] 将 session agent 接入 server 的显式协调/preview 入口，并保证在途 run 仍固定 agent resolver
- [x] 覆盖成功、结构化输出错误、快照变化、取消/超时、驱动失败和恢复路径
- [x] 全量 test/typecheck/build/diff 审查，更新协议与当前架构文档

### 阶段 13 关键发现

- 当前 NodeRunner 已具备最新快照、上下文包、输入 hash 和任务事件，但只返回 `NodeRunStatus`；没有外部协调提议的类型、解析边界或 session-level 调用点。
- 新入口必须复用 `readSnapshot` / `buildContextPack` 和既有 `AgentDriver`，不能把事件流正文注入 prompt，也不能让模型直接改变 workflow 或事实文件。

### 阶段 13 验证记录

- 首轮既有 27/28 个快照/checkpoint/doctor 测试通过；旧快照等值断言需要纳入新的 waiting 投影。
- 首轮新增 26/27 测试通过；doctor 按设计发现未重建的 ledger 投影，测试重建后全绿。
- 审查补充 driver 事件 schema 校验、用量字段过滤、输出上限前置、成功提议 invariant 与跨路由幂等键 409。
- 定向 47 测试 / 3 文件通过：24 个库用例、9 个真实 headless/ACP REST 用例、14 个既有 ACP 用例。ACP 两轮均 session/new，未调用 session/load。
- 一次多文件补丁因 ADR 索引长行匹配失败，未发生部分修改；拆分为精确补丁后完成。
- 首轮全量 469 测试 / 40 文件、typecheck/build:all/diff 通过；实际 HTTP 成功/stale/取消/超时与 health/doctor 通过，无 workflow.node 事件。
- 最后审查补充无 workflow 过滤快照的跨流程取消边界，只清除被取消流程的等待；新增真实事件回归，准备最终验证。
- 最终 470 测试 / 40 文件、typecheck/build:all/diff 通过；预览 `http://127.0.0.1:7296`，工作区 `/tmp/cord-stage13-preview`，实际 HTTP 结果存于 smoke-result.json。
- GitHub 远端查询低于 1 bytes/sec 持续 10 秒后失败；准备本地提交与有界推送，网络结果不影响已验证实现。
- 本地功能提交 `12f0643`；推送在 45 秒上限停止，GitHub 报低于 1 bytes/sec 持续 15 秒。提交保留，远端更新未确认；未因网络故障阻断后续本地功能工作。

### 持续目标的后续工作

- [x] 独立协调轮次的 console 操作与结构化提议展示（阶段 14）
- [x] 人工采用 Draft advance 提议后经既有 workflow 受控执行，消费前再次验证输入版本，保持关键 gate 人工（阶段 14）
- [ ] 继续补 SDLC 版本进度隔离、共享 REST 幂等并发边界和真实需求 dogfooding；不以当前离线原型声称持续目标已全部完成

## 阶段 14：协调工作台与受控采用（已实现并验证）

- [x] 核验上一轮本地提交 `12f0643` / `a02a99c`、干净工作树与既有 REST 实现；上一轮为已验证实现进展
- [x] ADR-0033：提议采用事实、完成态与当前新鲜度分离、原 agent 别名与绑定 SDLC 版本、执行器下一节点约束
- [x] server 采用前重新验证快照/配置/进度，预留 run 槽位并保留人工 gate，重复采用返回原 run
- [x] typed client 和需求详情“协调”视图：配置选择、创建、取消、历史、结构化提议、来源定位、输入变化/失败/恢复、显式采用
- [x] 离线 REST/客户端闭环与成功、过期、配置变更、并发、存储故障、重启用例
- [x] 全量 test/typecheck/build/diff 与 desktop/mobile Playwright 验收，更新文档
- [x] 本地功能提交 `2f9823e`，推送成功（远端 exp/impl：`2559083` → `2f9823e`），阶段 11–13 的积压提交一并同步

### 阶段 14 设计方向

- 沿用控制台白/灰/蓝/绿/红/黄 token、系统文字和等宽数据，紧凑工具栏 + 左侧轮次历史 + 右侧提议明细，手机上下排列；版本与新鲜度是扫描重点。
- 采用命令表示进入绑定版本的整个 SDLC runner，模型不挑选任意跳转目标；advance 只允许执行器拓扑顺序中第一个未退出节点。
- 前端不计算新鲜度或放行状态，server 返回 current/adoptable 与原因；历史 ok 和当前依据变化可同时成立。

### 阶段 14 验证记录

- 原有 33 个协调用例与 build/typecheck 通过；新增采用测试首轮 45/46，通过路径和 slot/事件失败边界均生效，但发现错误 workflow 的 adopted 事件被接受。
- 加入 adopted 事实与提议 workflow/node/input/run 的一致性校验，避免错误引用或合并冲突伪装为已采用。
- 53 个定向测试 / 4 文件、build:all/typecheck 通过；typed client 真实 HTTP 已完成协调 → 采用 → 人工 gate → 完成闭环。
- UI 审查修正绑定 SDLC 在采用后变化导致 effect 重置、command 保持忙碌的风险；默认值使用 ref，挂载生命周期只随需求变化。
- 首轮全量 485/486 通过；发现 completed 可读而后台 finally 未释放槽位的竞态。终态查询等待后台清理完成后返回，保留首 await 前的在途预留，并补连续轮次回归。
- 修复后全量 487 测试 / 41 文件通过。首轮浏览器已通过创建/取消/超时/坏输出/人工选择题/来源跳转/过期输入，恢复文档时保存按钮超时；定位到文档切换读取未完成时可编辑，迟到读取覆盖输入。切换同步设置 loading、加载时禁用保存、保存时禁用文档切换，使用新临时工作区重跑。
- 第二轮浏览器完整通过：1440/390/320 无溢出/重叠，创建/取消/超时/坏输出/选择题/来源/输入变化/失败保留历史/采用/人工 gate/重复采用/空态/加载均通过，无 pageerror；截图保存于 `/tmp/cord-stage14-preview-r2`。
- 最后恢复审查补充运行登记 coordination_round_id；登记后、adopted 落盘前中断必须在重启时 fail-closed，合法采用事实则恢复既有 runner。补正反恢复回归和 SQLite 旧表兼容。
- 最终 491 测试 / 42 文件、typecheck/build:all/diff 全通过；最新代码的第三轮浏览器验收再次完整通过，证据 `/tmp/cord-stage14-preview-r3/browser-result.json` 与 desktop/mobile/stale/adopted 截图。
- 保留未被验收消耗的预览需求：`http://127.0.0.1:7300/#/requirements/REQ-COORDINATION/coordination`，工作区 `/tmp/cord-stage14-preview-final`。1440/390/320 无溢出，当前提议可采用，health/doctor 为 true，pageerror=0；该预览使用离线 fake driver。
- 实际第三轮验收 run 的 SQLite 状态为 completed，coordination_round_id 与 adopted 事实一致；本地功能提交 `2f9823e` 已成功推送至 exp/impl，远端此前积压的阶段 11/12/13 已包含在本次同步中。

### 下一阶段

- 优先核验同 workflow ID 不同 SDLC 发布版本的进度/审批/协调快照隔离，防止新版本继承旧节点退出事实。
- 继续完善 REST 幂等并发与输入绑定、文件 checker 物理路径边界，并安排真实需求 dogfooding；持续目标保持完整，不以本轮功能代替全部目标。

## 阶段 15：SDLC 执行版本隔离（已实现并验证）

- [x] 核验 `2f9823e` / `c5a32e7` 与干净工作树；上一轮为已验证进展
- [x] 定位 workflow_id 单独过滤导致的进度、审批、取消和协调快照跨发布版本混用
- [x] 真实同 ID / 同定义版本、不同发布名称、旧审批、跨版本取消与协调提议回归复现
- [x] ADR-0034 与 workflow_revision 契约、纯执行版本指纹和统一匹配规则
- [x] 贯穿 executor、NodeRunner、gate/checker、snapshot、run/审批/协调投影与恢复；保留无版本库模式的兼容边界
- [x] workflow.run.started 保存发布绑定，索引丢失可从事实重建当前版本；缺失版本身份/定义改变时 fail-closed
- [x] 全量 test/typecheck/build/diff、实际 HTTP 验证与文档
- [x] 本地提交 `7f2234d`，推送成功（exp/impl：`c5a32e7` → `7f2234d`）

### 阶段 15 设计边界

- workflow_id 保持公开 DSL 标识；workflow_revision 从完整规范化定义与发布绑定 `{id, version}` 派生，不使用时间戳或 run_id。
- 同一发布版本断点恢复继续复用自己的进度；即使定义相同，不同发布版本/名称也不得继承进度。
- 库的无版本调用保留独立兼容模式；server 总是传入显式版本，旧无版本事实不为新版本提供自动复用/审批证据。
- 当前选择由最新 run 绑定决定，恢复只推进该需求最新 run；历史版本事实保留，不伪造取消或删除历史。

### 阶段 15 验证记录

- 首轮 7 个真实回归全部失败，复现同定义版本/发布名称复用、旧审批复用、跨版本取消、协调误判、索引丢失绑定和改动后的定义仍恢复。
- ADR-0034 先行，执行版本已贯穿核心端口、任务/门禁/快照与 server；新增 started 绑定事实和可空索引字段。当前绑定改按 started 的因果顺序确定，避免依赖墙钟排序。
- 首轮实现定向 36 测试 / 3 文件通过；类型检查定位统一匹配函数需要类型谓词，已修正。扩大到纯指纹/匹配、事件 checker、旧数据、部分索引恢复与同版本中断。
- 首轮全量 505/507 通过；两个旧采用中断 fixture 未带新执行版本和 started 绑定，被正确 fail-closed。更新 fixture 为完整的新协议窗口，并继续保留缺少 adopted 的反向回归。
- 45 个定向测试 / 4 文件及 build/typecheck/diff 通过；含 15 个真实 server 版本用例、4 个核心作用域用例、24 个协调与 2 个索引迁移用例。
- 全量 510 测试 / 44 文件、typecheck/build:all/diff 通过。实际 HTTP 首轮等待旧 run ID 超时；SQLite/事件核验新恢复尝试已 completed，旧 run 保留 waiting_human。验收改按当前 run/版本与实际需求完成态验证，未重启存活任务，使用新临时工作区复跑。
- 第二轮实际 HTTP 全部通过：同定义 v1/v2 分别执行、旧审批 409、旧版本取消保留当前审批、索引删除恢复绑定/审批 ID、同版本复用进度、doctor=true。证据 `/tmp/cord-stage15-preview-r2/smoke-result.json`。
- Playwright 1440/390/320 无溢出、pageerror=0；v2 协调 → 采用 → 同版本人工审批 → completed 全通过。证据 browser-result.json 与 version-1440.png / version-390.png，预览 `http://127.0.0.1:7302/#/requirements/REQ-VERSION-DEMO/coordination` 保留可采用的离线提议。
- 一次临时脚本工具输入引号错误及两次文档补丁精确匹配失败均未写入；修正为独立精确补丁后完成。
- 功能提交 `7f2234d`，已成功推送当前 exp/impl；工作树干净，预览仍正常。

### 后续方向

- 继续核验 REST 全局幂等输入/并发绑定与 checker 的文件物理边界；目前新增版本作用域不能替代这些独立约束。
- 自定义 agent/协调/控制台/人工采用已形成离线闭环，仍需真实需求与真实模型 dogfooding 和可复用示例；持续目标保持进行中。

## 阶段 16：统一 REST 幂等执行边界（已实现并验证）

- [x] 核验 `49982d3` 与干净工作树，上一轮为已验证实现进展
- [x] 定位响应后缓存、同路由未绑定输入、局部并发映射缺少全局保护的缺口
- [x] 成功/失败/并发/不同输入/重启/持久化故障回归复现
- [x] ADR-0035：结构化输入指纹、统一并发占位、业务执行前持久化 pending、未知结果 fail-closed
- [x] 实现共享幂等入口与 SQLite 兼容迁移，移除路由重复映射
- [x] 全量 test/typecheck/build/diff、实际 HTTP 验收、文档
- [x] 功能提交 `1056ed1`，推送成功（exp/impl：`49982d3` → `1056ed1`）

### 阶段 16 设计边界

- key 绑定 method、精确路径及规范化 JSON 输入 hash，不保存输入正文；字段顺序变化不构成不同输入。
- 同键同输入在途请求共享首次最终响应，不重复进入 handler；不同命令/输入立即 409。
- 业务前持久化 pending，成功响应持久化后才发布给等待者。4xx 已知拒绝允许修复重试；5xx/响应持久化失败或重启残留 pending 属未知结果，同键不得盲目重新执行。
- legacy 缓存没有输入指纹，不猜测匹配；保留记录并明确拒绝同键重放。进程内并发保护不声称提供跨进程任务 lease。

### 阶段 16 验证记录

- 首轮 7 个真实 API 回归全部复现：输入变化静默重放、创建/发布重复、并发 run 409、重启身份未绑定、legacy 猜测。
- 共享实现后 48 个相关用例 / 4 文件通过；Fastify 配置的类型断言需缩窄为具体可选字段，已修正。
- 故障/断连扩展首轮 18/19 通过；4xx 并发测试的 duplicate 尚未进入 hook 就释放 barrier，改用事件循环 barrier 确认测试时序，不修改业务生命周期。
- 输入指纹使用标准 JSON 的排序 replacer 保留 __proto__ 自有字段；历史 core/hash 协议保持不变，避免修改旧事件 hash。
- 单次事件循环屏障不足以证明请求抵达，4xx 并发用例改用独立 Fastify 入口 hook 屏障；25 个幂等/索引用例、typecheck 通过。补充文档/草稿/删除/归档/审批/取消的真实入口，以及双索引占位冲突。
- 全量 536 测试 / 45 文件、build:all/typecheck/diff 通过；既有 worker/审批/版本/协调用例无需修改。
- 实际 HTTP 五并发创建/发布/启动/审批/重载/协调/采用/取消各执行一次且响应一致；输入变化 409、重启重放一致、响应缓存故障和残留 pending 不重执行、4xx 修复重试、doctor=true。证据 `/tmp/cord-stage16-preview/smoke-result.json`，离线预览 `http://127.0.0.1:7303/#/requirements/REQ-IDEMPOTENCY-DEMO/coordination`。
- 最后审查把响应快照转换移入故障处理；不支持的流式写响应必须明确未确认并唤醒等待者，不能因序列化抛错留悬挂 Promise。补独立 Fastify 回归，准备最终验证。
- 最终 537 测试 / 45 文件、build:all/typecheck/diff 全通过；23 个共享入口用例与 6 个索引用例覆盖输入、并发、失败/恢复、断连、流式响应及旧表兼容。
- 最新代码的第二轮实际 HTTP 五并发全通过，证据 `/tmp/cord-stage16-preview-final/smoke-result.json`；Playwright 1440/390/320 无溢出、pageerror=0，可采用提议保持。预览 `http://127.0.0.1:7304/#/requirements/REQ-IDEMPOTENCY-DEMO/coordination`，browser-result.json 与 preview-1440.png / preview-390.png 保留证据。
- 功能提交 `1056ed1` 已成功推送当前 exp/impl；代码和验收文档同步，预览 health 正常。

### 待继续

- 文件 checker 与 REST 文档访问尚未统一使用 coordinator 的物理文件边界，下一轮核验链接/事实文件/IO 故障。
- 真实模型与真实需求验证、可复用自定义 agent 示例仍待完成，不能以本轮共享入口修复声称持续目标已全部完成。

## 阶段 17：统一文档访问与接入验证（已实现并验证）

- [x] 核验 `1056ed1` / `0231ab2` 与干净工作树，上一轮为已验证实现进展
- [x] 定位 checker/REST 跟随链接、REST 读故障伪装 404、直接写入非原子的差异
- [x] ADR-0036、共享 core 文档 helper，保留 coordinator 内部导入兼容入口
- [x] checker 普通文件证据、REST 读写/可用性投影复用边界，链接/保留文件/缺失/IO 明确区分
- [x] 覆盖文件证据成功/阻断/恢复、REST 外部文件不变、写入故障与门禁闭环
- [x] 添加可复用 ACP/Claude 角色/Codex agent 配置和 SDLC 示例，结构化解析验证
- [x] 临时工作区的真实 CLI 协调调用，核验最新快照/严格提议与来源；失败如实记录
- [x] 全量 test/typecheck/build/diff、HTTP 验收、文档
- [x] 功能提交 `325f8c4`，推送成功（exp/impl：`0231ab2` → `325f8c4`）

### 阶段 17 边界

- 文件证据与快照文档只接受 session 内独立普通文件，拒绝链接、管理/事实文件和非规范路径。
- file-exists 校验普通文件元信息，不为存在性检查加载整个内容；内容检查和 REST 读取使用 no-follow 描述符。
- 缺失文档 404，物理边界错误 409，其他 IO 错误 500；普通读取失败不能引导控制台当作新文档覆盖。
- 共享 helper 不等价于 OS 沙箱，Node 便携 API 不能承诺跨进程父目录替换的强事务；真实 CLI 在隔离临时工作区只产 Draft。

### 阶段 17 验证记录

- 首轮 12 个新增回归有 11 个失败，复现 checker 链接/事实文件放行、REST 链接/目录读取与直接写入；门禁测试调整独立 evidence.md，避免 PRD 的快照阻断先触发。
- 共享 helper 实现后 43 个相关用例 / 4 文件、build/typecheck 通过；文件 helper 搬迁 + 同路径 re-export 不可在单 patch 重复操作，拆成顺序补丁后完成。
- 补元信息不读正文/描述符清理/IO 500/根链接末尾斜杠，18 个新定向用例 / 4 文件与 typecheck 通过；ACP/Claude/Codex 示例用真实 parser 校验。
- 本机 codex exec 帮助核验通过，准备隔离临时 git 工作区的两个新协调会话（90 秒预算/轮次），不采用或批准真实提议。
- 全量 555 测试 / 49 文件、build/typecheck/diff 通过；真实 Codex 0.160.0 首轮 failed/output（完整 JSON 解析失败）而 token 用量已返回，doctor=true。准备规范化内容事件诊断，不能以调用成功冒充提议成功。
- 第二次诊断证明模型已返回合法单 JSON，非终态 item.error（配置警告）被拼入正文；thread.started ID 未保留到结果。新增 ADR-0037、结构化通知/回执回归，官方 OpenAI 文档确认当前配置名为 approval_policy，准备修复真实 driver。
- 4 个协议回归复现后修复，62 个 driver/配置/协调用例 / 3 文件与 build/typecheck/diff 通过；已知通知 metadata、终态错误不降级、thread 回执流级保留，Codex 审批配置更新。一次同文件重复 patch 操作拒绝且未写入，合并精确补丁后完成。
- 真实 Codex 0.160.0 原始 production resolver 两轮 VERSION_A/B 均 ok/current，提议反映最新范围；输入/snapshot/session ID 不同、旧轮次 current=false、PRD 未被修改、doctor=true。证据 `/tmp/cord-stage17-real-result.json` 与临时工作区 real-result.json。
- 修复后全量 558 测试 / 49 文件、typecheck/diff 通过；准备最新代码的 HTTP 与真实提议控制台预览。
- HTTP 首轮所有文件边界/门禁恢复通过，workspace doctor 仅报临时 git 缺 merge driver 注册；session doctor 仍正常。宿主已明确退出，无存活 worker，按既有初始化步骤在临时仓库注册后重跑，保留真实协调事实。
- 最终 558 测试 / 49 文件、build:all/typecheck/diff 通过，最新 HTTP 和浏览器验收通过；558 测试保持离线，真实 LLM 验收独立进行。
- 第二轮 HTTP 证明符号/硬链接 409、缺失 404、外部原文不变、门禁 blocked → 修复 → completed，workspace doctor=true。浏览器 1440/390/320 无溢出/pageerror，读错误禁用编辑/保存、缺失可创建、修复可读。
- 保留真实提议预览 `http://127.0.0.1:7305/#/requirements/REQ-REAL-CONTEXT/coordination`；证据 `/tmp/cord-stage17-real-result.json`、`/tmp/cord-stage17-http-result.json`、`/tmp/cord-stage17-browser-result.json` 与临时真实工作区截图。公开总结写入 docs/research/2026-10-07-real-context-agent.md。
- 功能提交 `325f8c4` 已成功推送当前 exp/impl，运行数据/凭据未提交，预览 health 正常。

### 持续目标后续

- 将可公开的真实开发需求接入示例 SDLC，完成计划 worker/独立评审/人工 gate 全链路验证；当前两轮真实协调不能证明整条开发流程完成。
- Claude Code 角色封装和 ACP 仍需真实调用验证，CLI/version/model 的变化需兼容回归；不自动批准关键 gate 或合入。

## 阶段 18：只读报告与真实开发 Draft（已实现并验证至人工 gate）

- [x] 核验 `325f8c4` / `234508e` 与干净工作树，上一轮为有代码和真实 CLI 验收的进展
- [x] 定位 readonly worker 文本报告不落 artifact，无法进入后置文件/人工 gate 的功能缺口
- [x] ADR-0038 与 run.output=text 契约：保持 worker 只读、宿主唯一产物写回、旧行为兼容
- [x] 文本模式的 prompt/写回/输入 hash/恢复校验，空内容/元信息/冲突/取消必须失败可见
- [x] 离线 coordinator/恢复/server 回归与真实开发 SDLC 示例
- [x] 隔离检出的真实 worker 开发 Draft 与新会话只读评审，宿主独立执行测试，停在真实人工 gate
- [x] 全量 test/typecheck/build/diff、实际验收、文档
- [x] 全量 572 测试 / 51 文件、build:all/typecheck/diff、浏览器验收
- [x] 提交推送

### 阶段 18 边界

- output 缺省 auto，旧 readonly 节点仍不写文档；显式 text 只允许有声明 artifact 的节点。
- text 产物由 coordinator 从完整结果文本代写，派发前后观察到产物变化则保留现状并失败，不能把 agent 自写当作文本通道成功。
- 恢复把 report artifact 当输出，以后态 hash 校验；读取 PRD/上游资料和配置变化仍使旧 checkpoint 失效。
- 真实开发工作保留在隔离 worktree 作为 Draft，不合入当前分支，不自动采用或批准关键 gate；同模型不同会话的评审不能声称异构盲评。

### 阶段 18 验证记录

- 首轮 9 个核心回归中 6 个失败，复现 readonly 报告不写回、空结果假成功、文件变化未阻断与无 artifact 定义未拒绝。
- 首轮实现验证发现新增 prompt 的嵌套反引号转义丢失，造成构建错误；改用纯路径文本后重跑，协议语义不变。
- 85 个 coordinator/checkpoint/loader 用例 / 4 文件、build/typecheck 通过。新增真实 server 文本报告/审批/重启/失败修复回归和五节点开发 Draft 示例。
- 真实任务选择请求输入身份的属性回归：在独立本地 clone 新增至少 40 组确定性 JSON 输入测试，只改指定新测试，不改生产源码/已有测试。完整计划/实现/只读评审使用新 CLI 会话，宿主另跑目标测试，保留未提交 Draft 与未决人工 gate。
- 全量 570 测试 / 51 文件、build:all/typecheck/diff 通过，真实运行已协调成功并进入 plan 节点；已确认进程/事件仍在途，不因观察间隔重启。
- 真实 plan ok，implement 在 240 秒预算内未完成收束，落 timeout 而非 ok；已有测试 Draft 共 48 组基准/57 测试，宿主目标测试全部通过。原命令在 sandbox 共享依赖缓存写入失败，替代 configLoader=runner 可跑目标；全库 sandbox HTTP 监听限制与宿主验证须分开记录。
- 实际 file_change 事件被拼入正文，新增 ADR-0039 与结构化工具映射回归；不以部分文件证明任务 completion，保留超时事实后按最新恢复附记重跑未退出节点。
- 宿主完整 clone 验证 615 测试 / 50 文件、typecheck/diff 全通过，已跟踪文件无改动。准备在最新 PRD 加恢复附记，明确缓存/监听限制与已验证事实，只补目标验证及报告，不伪造任务终态。
- 原运行 terminal 且 worker 已收束后关闭旧 server；新 PRD 加恢复附记，同版本重新 start 只派发 implement，未重复 plan。40 个协议/报告/server 回归与 build/typecheck 通过，恢复仍在途。
- 恢复结果：plan/implement/verify 各有真实 ok，初次 implement timeout 保留；plan 只派发一次，verify 的 readonly+text 报告 written_by=coordinator，宿主目标57再次通过。人工 gate 等待，0 human.decision，done未退出，独立clone HEAD仍为原234508e、已跟踪生产/测试无改动。
- 实际 reviewer 静态检查无阻断发现，但自身测试因 readonly SSR临时目录权限失败未完成；报告如实区分宿主615通过与模型自己的运行。任务ok表示报告生成成功，不证明独立测试通过，不自动放行。
- 主工作树全量 572 测试 / 51 文件、build:all/typecheck/diff 通过；准备 pending gate 和报告的浏览器验收。
- 浏览器验收通过：1440/390/320 无横向溢出/pageerror，真实human gate待决、报告可读/环境限制可见、plan未重跑、done仍pending，未点击放行。预览 `http://127.0.0.1:7306/#/requirements/REQ-INPUT-PROPERTIES/approvals`。
- 证据 `/tmp/cord-stage18-recovery-result.json`、`/tmp/cord-stage18-browser-result.json`，隔离clone及 host-verification/目标输出保留未提交 Draft；公开总结 docs/research/2026-10-07-development-draft-workflow.md，不提交会话数据/凭据。
- 隔离 clone 最终 recovery-result.json：timeout → implement恢复ok → verify text报告ok → human gate pending；plan未重跑、tracked_diff为空、done未退出、0 human.decision、session doctor=true。

### 持续目标后续

- 当前真实开发处于可审查的人工 gate，未批准/合入；不能以报告生成成功替代独立运行验证。
- 继续接入明确的机器验证事实/证据渠道，解决只读 reviewer 测试临时目录限制；异构评审仍需验证。

## 阶段 19：真实 Claude/ACP 驱动冒烟与 ACP 会话回执（已完成）

- [x] 真实验证 Claude headless 与命名角色封装
- [x] 真实验证 Kimi ACP 流程和终态
- [x] 统一 ACP 事件的顶层 session 回执并补离线回归
- [x] 同步 ADR、协议、进度和研究记录
- [x] 完成测试、类型检查、构建与空白检查

### 阶段 19 边界

- 真实调用只使用临时只读目录和现有本机认证，不把凭据、原始事件、会话正文或会话 ID 提交到仓库。
- 冒烟成功只证明本机 CLI/ACP 组合可启动和收束，不等于模型质量、异构盲评或人工 gate 已验证。
- 阶段 18 的真实开发 Draft 仍停在人工审批，不自动批准、不合入。

## 阶段 20：结构化机器验证证据（已完成）

- [x] 固化 `verification.completed` 事件与摘要 hash 契约
- [x] 将当前 gate 输入指纹透传给 checker，增加 `verification-passed`
- [x] 提供 context/read 与幂等 record REST API，输入变化 fail-closed
- [x] 增加可复用机器验证 SDLC 示例和 REST/执行器回归
- [x] 完成 ADR、协议、类型检查和定向测试

### 阶段 20 边界

- 机器命令由宿主、CI 或外部插件执行；agent 输出和任意命令参数不作为验证事实写入事件。
- 事件只保存状态、输入/命令/输出摘要 hash、退出码、耗时和短摘要；长日志留在外部系统。
- verification 结果必须绑定当前 workflow scope、节点和 gate 输入 hash；需求或账本变化后旧结果返回 409 或被 checker 阻断。

## 阶段 21：真实 Claude/ACP Context Session Agent 协调验证（已完成）

- [x] 真实 Claude 命名角色封装协调调用
- [x] 真实 Kimi ACP 协调调用
- [x] 核验最新快照重建、严格提议和 session/configuration 回执
- [x] 核验无 workflow/task 副作用、PRD 不变、doctor 通过
- [x] 写入研究与当前架构记录

### 阶段 21 边界

- 真实调用只证明本机 CLI/认证组合与 Context Session Agent 协议可用，不证明代码生成质量或异构盲评结论。
- 协调轮次只产 Draft 提议；不自动采用、不启动 worker、不批准 gate、不合入代码。

## 阶段 22：机器验证 run 级隔离（已完成）

- [x] CheckerContext 与执行器注入当前 run_id
- [x] verification-passed 校验事件 run_id 与当前输入 hash
- [x] 覆盖旧 run 同输入验证事实不可复用
- [x] 更新协议文档并完成定向验证

## 阶段 23：控制台机器验证可观察性（已完成）

- [x] 需求概览展示 `verification.completed` 的最新状态
- [x] 显示当前/历史 run、节点、输入 hash 摘要和失败状态
- [x] 保持 server 投影为唯一状态来源，不在前端复制 gate 判定
- [x] 完成 console typecheck、定向测试、build:all 和 diff check

### 阶段 23 边界

- 页面展示验证事实，不替代 `verification-passed` checker，也不允许前端直接放行 gate。
- 本机未安装 Playwright 依赖，本轮以 console typecheck、Vitest 和生产构建验证；此前版本的浏览器验收证据仍保留。

## 阶段 24：外部机器验证等待与自动重检（已完成）

- [x] 将验证 gate 配置为外部事实等待点
- [x] 记录验证事实后唤醒同一 run 的挂起 gate
- [x] 重检仍经 `verification-passed` 与当前 run/input hash，不直接放行
- [x] 更新示例和 REST/server 回归

### 阶段 24 边界

- 当前进程内验证事实立即唤醒挂起 run；若事实先落盘后进程重启，run recovery 会按同一 run 恢复 executor 并重检。
- 验证事件不产生 `human.decision.recorded`，也不绕过人工 gate。

## 阶段 25：机器验证重启恢复（已完成）

- [x] recovery 识别同一 run 的已落盘验证事实
- [x] 重启后恢复 pending gate 并消费当前验证结果
- [x] 增加 server restart 回归，保留 run/input hash 隔离

## 阶段 26：验证唤醒与恢复时序（已实现并验证）

- [x] 复核阶段 25 的恢复链路，确认重启后才到达的 CI 结果缺少活跃 executor
- [x] 覆盖重启后提交、挂起前到达、无关验证与人工确认的真实 REST 回归
- [x] 将重检限定到引用结果的 gate，并串行恢复原 run
- [x] 用持久化证据检查关闭 lost wakeup 窗口，保留人工终审
- [x] 全量 586 测试、build/typecheck/diff 与实际宿主命令验收

### 阶段 26 边界

- 验证接口依赖本地受信宿主如实上报，不提供外部 CI 身份认证或代码树内容认证。
- 原真实开发 Draft 和本轮宿主验收都保持人工终审未决，持续目标仍需完善证据来源与代码输入身份。

## 阶段 27：验证源码输入身份（已实现并验证）

- [x] 确认当前验证/审批 hash 不覆盖代码，先记录 ADR-0041
- [x] 复现源码修改、增删和人工终审仍消费旧结果的 REST 反例
- [x] 实现声明输入范围、受限源码清单和内容 hash，共享验证/审批/恢复函数
- [x] 覆盖链接/越界/缺失/大小上限/恢复，更新可复用示例
- [x] 全量 619 测试、build:all、typecheck、diff 检查和宿主验证

### 阶段 27 边界

- inputs 范围由流程作者保证完整，指纹不覆盖未声明代码、工具链和外部依赖；不代替固定检出或 OS 隔离。
- 仅 source_hash/输入 hash 入事件，源码、真实会话与日志留在临时工作区；人工终审仍未决。

## 阶段 28：只读 worker 源码新鲜度（已实现并验证）

- [x] 审查确认机器 gate 与 worker checkpoint 的源码身份未贯通，记录 ADR-0042
- [x] 复现旧评审复用与在途源码变化仍代写报告的反例
- [x] 接入宿主源码摘要钩子、纯执行身份和任务 provenance
- [x] 绑定只读 worker 的恢复与写回前重检，保留可写 worker 的产出规则
- [x] server/核心成功失败恢复回归，全量 634 测试、构建、类型与 diff 检查

### 阶段 28 边界

- 只读 worker 的范围来自节点声明；未声明范围不证明代码新鲜度，已退出节点不自动回滚。
- 原真实 Draft 保持人工终审未决；本轮验证使用离线 driver/真实 fixture 子进程，不声称异构模型质量已验证。

## 阶段 29：协调提议源码新鲜度（已实现并验证）

- [x] 核对当前分支，确认独立协调输入尚未包含源码并记录 ADR-0043
- [x] 复现源码变更后旧提议可采用、在途变化仍返回提议的核心/REST 反例
- [x] 接入流程范围并集、宿主摘要钩子、轮次 provenance 和输入 v2 身份
- [x] 查询/采用/恢复按同一范围重检，覆盖失败、兼容和无工作流副作用
- [x] 全量 649 测试、构建、类型与 diff 检查，真实 Claude 源码绑定协调验收

### 阶段 29 边界

- 声明源码身份只保证相关材料的摘要绑定，不认证模型推断、测试状态或未声明依赖。
- 协调仅产 Draft；原真实开发需求仍保持人工终审未决，不自动采用或合入。

## 阶段 30：协调机器验证上下文（已实现并验证）

- [x] 确认独立协调缺少机器验证观察，先记录 ADR-0044
- [x] 增加受限验证观察契约与 verification 证据引用
- [x] 当前 run/流程的声明验证投影，共用输入身份与 fail-closed 新鲜度
- [x] prompt、输入 hash、完成/查询/采用重检贯通，测试日志不注入
- [x] 核心/REST 成功失败恢复回归、真实 Claude failed→passed 观察验收、Playwright 截图验证
- [x] 全量 674 测试 / 55 文件、build:all、typecheck、diff 检查

### 阶段 30 边界

- 受信宿主上报仍需如实执行，观察来源不认证外部 CI 身份，verification 引用不代表 gate 放行。
- 初次真实模型因 gate ID 冒充节点来源被严格拒绝，补充明确来源规则后重跑通过；未放宽验证、未自动批准真实 gate。

## 阶段 31：验证证据一致性（已实现并验证）

- [x] 确认 checker 与协调观察对坏结果的判定漂移，记录 ADR-0045
- [x] 反例覆盖 passed/非零退出码、坏最新结果、外部事件与损坏读取
- [x] 共用结果契约、严格读取与取消事实校验，REST 拒绝矛盾结果
- [x] 确定性复现等待挂起重检将 run 置为 failed，保留不可读时的修复入口
- [x] 核心/server/恢复一致性回归，全量 701 测试、构建、类型与差异审查通过
- [x] 真实宿主失败→通过与同键修复验收，原真实 Draft 实时核验保持人工待审

### 阶段 31 边界

- 未知退出码保持未知；严格结构检查不认证外部 CI，不替代 doctor 哈希链诊断。
- 临时源码不可读时不放行，修复后仍可重验；真实 Draft 未批准、未合入。
- 实现与验收记录已准备提交，远端同步以实际推送/查询结果为准；持续优化目标仍有效。
- 本地实现提交 `b501fa5`；推送与远端查询均报 GitHub 低速超时，保留提交待后续同步。

## 阶段 32：独立协调上下文覆盖（已实现并验证）

- [x] 核验当前工作树，记录长文档末尾丢失与后续产物饥饿，完成外部资料与 ADR-0046
- [x] 反例覆盖长需求尾部、跨文档预算和在途修改/恢复
- [x] 首尾采集、均衡分配、可核验片段索引和协调 v4 输入身份
- [x] 核心/server/ACP 恢复与迁移，全量 713 测试、build:all/typecheck/diff 检查
- [x] 真实 Claude 两轮首尾标记、重启/更新新鲜度和无工作流副作用，文档同步

### 阶段 32 边界

- 首尾片段不保证涵盖中间全部要求；字符预算不是 token 预算，不自动摘要或增加模型调用。
- 旧策略提议保留历史但需重新协调，原真实 Draft gate 保持人工未决。
- 本阶段已准备提交与有界推送，持续目标保持 active。
- 本地功能提交 `e5b11da`；推送报 curl 28 低速超时与 sideband 断连，远端查询也因 10 秒低速失败，尚未确认同步。

## 阶段 33：快照事件完整性（已实现并验证）

- [x] 核验阶段 32 的干净工作树与进展，发现普通读取跳过坏行/接受外部 session，先记录 ADR-0047
- [x] 反例覆盖快照、模型派发/在途、查询/采用及冷恢复
- [x] 可选严格事件端口与共享 helper，当前读取修复、协调恢复按需求隔离
- [x] 真实子进程取消收束，失败响应不伪造事实，健康需求不受损坏需求影响
- [x] 成功/失败/恢复回归，全量 735 测试 / 59 文件与构建通过，实际 HTTP 完整验收
- [x] ADR 索引、协议/架构与公开验收记录同步，原真实 Draft 实时核验保持人工待审

### 阶段 33 边界

- 严格 envelope/session/行读取不替代 doctor 哈希链诊断；旧端口须兑现返回全部事实的契约。
- 本轮保护快照/验证/协调决策，诊断浏览与其余 workflow 投影不在此次修改范围。
- 未完成坏需求保留事实，修复冷打开写锁须重新打开；取消失败仍报告错误，不伪造事实。
- 持续目标保持 active，完成类型与差异审查后提交并有界推送。
- 实现提交 `33e0548`；HTTP/2 推送成功（f5ab910→33e0548），远端 ls-remote 已核验，阶段 30–33 的积压提交一并同步。

## 阶段 34：协调执行观察（已实现并验证）

- [x] 核验阶段 33 已推送且工作区干净，确认 worker 失败不改变独立协调输入，记录 ADR-0048
- [x] 反例覆盖任务变化新鲜度、活动 run 行动约束、失败/恢复与旧任务归属
- [x] worker run_id provenance、严格执行观察、prompt/hash/来源校验与 server 重检
- [x] 全量 765 测试 / 61 文件、构建、类型与差异检查，真实 worker/Claude 两轮任务观察
- [x] 核心/REST/恢复、真实 Claude 三次协调与来源跳转浏览器验收，1440/390/320 无溢出/重叠或页面错误
- [x] 协议/架构/ADR 索引与公开验收记录同步，原真实 Draft 实时保持人工未决

### 阶段 34 边界

- active 是当前未终态宿主槽位，不认证 OS PID；started/任务 ok 均不冒称进程或测试/gate 通过。
- 旧无 run_id 任务不猜测当前归属，旧协调域需重新协调；既有 checkpoint 复用不变。
- 实现与验收已准备提交和有界推送，持续目标保持 active。
- 功能提交 `65270f9` 已通过 HTTP/2 推送（e426eb9→65270f9），远端 ls-remote 核验相同；持续优化目标保持 active。

## 阶段 35：跨 run 复用 provenance（已实现并验证）

- [x] 核验阶段 34 已验证并推送，确认新 run 复用旧 checkpoint 被协调投影为 missing，记录 ADR-0049
- [x] 反例覆盖跨 run 成功复用、同 run 恢复去重、变更重跑与追加失败
- [x] 显式 reused 事实、严格原完成引用、受限观察与 v6 协调身份
- [x] 核心/server/恢复、真实 Claude 两轮、worker 仅调用一次与浏览器两步来源验收
- [x] 最终全量 790 测试 / 62 文件与构建通过，桌面/手机无溢出/重叠，原真实 Draft 保持人工待审
- [x] 交接审查补齐原完成重试上限校验，三项反例复现后修复；最终 793 测试 / 62 文件、build:all/typecheck/diff 检查通过，预览重启后无新 worker 调用或人工决定
- [x] 阶段 35 功能本地提交 `a802351`（`feat: record worker checkpoint reuse provenance`）
- [ ] HTTP/2 推送与远端实际 hash 核验：本轮推送因低于 1 bytes/sec 持续 15 秒失败，远端查询 20 秒超时，GitHub 443 连接测试也超时；保留本地提交待网络恢复

### 阶段 35 边界

- reused 不是新执行或 gate 放行，原完成只表示记录时通过宿主复用校验。
- 旧无 run_id 必须有新的显式绑定才作当前来源；无当前身份的库模式仍只记录 notes。
- 旧 server 协调域须重新协调，纯 hash/reducer 不变。最终验证通过，进入提交推送，持续目标保持 active。
- 功能已本地提交，HTTP/2 推送与远端核验失败；远端实际状态未确认，不将阶段收尾视为整个持续目标完成。

## 阶段 36：独立协调工具事件边界（已实现并验证）

- [x] 核验上一轮为实际进展、当前工作树干净；agent-optimizer 审查发现协调消费循环忽略工具事件，先记录调研与 ADR-0050
- [x] 先复现工具事件、结果后工具、清理异常与旧输入身份：7 个核心和 4 个 REST 反例全部失败
- [x] 宿主 abort/failed、保持敏感负载不入事件、绑定 no-tools 策略身份
- [x] 真实 headless/ACP 子进程、REST 失败/恢复/重启和历史迁移回归，ACP 取消发送竞态先复现后修复
- [x] 全量 807 测试 / 62 文件与 build:all/typecheck 通过，隔离实际 HTTP/Claude 一次无工具调用、重启与 1440/390/320 浏览器验收，文档同步
- [ ] 小步提交、有界推送与远端实际 hash 核验；网络失败不阻断本地优化

### 阶段 36 边界

- 检测并终止报告工具事件的协调调用，不证明外部 CLI 绝无副作用、不替代 OS 沙箱。
- 不改变普通 worker 的工具使用、不生成用户取消、不自动采用提议；真实 Draft gate 保持人工未决，持续目标保持 active。
- 已完成实现与验证，最新源码预览 7313 保留两个违规失败与一次真实 Claude wait Draft；进入差异审查、提交和有界推送。

## 阶段 11：恢复输入校验与版本化人工审批（已实现并验证）

- [x] 核验当前分支与阶段 10；上一轮实现和远端同步属于已验证进展
- [x] ADR-0030：稳定 execution_input_hash、未退出节点的 completion 复用校验
- [x] gate 统一求值指纹、等待前后重新检查、依据变化时 invalidated/recheck
- [x] 审批 ID 绑定 workflow/node/gate/waiting 事件，旧请求与旧暂存决策不能用于新审批
- [x] 覆盖不变输入恢复、PRD/账本/产物更新、人工等待变化、重启与旧审批拒绝
- [x] 全量验证、实际服务验收与文档同步
- [x] 本地实现提交 `9b42fa0` 并尝试推送；GitHub 低速超时、45 秒重试未返回、远端核验超时，保留提交待网络恢复

### 验证记录（阶段 11）

- 首轮类型检查定位到 HumanGateAnswer 新响应的窄化与 evaluation_hash 参数放置，已修正。
- 审批 JSON 编码超过 Fastify 参数上限，改用等待事件 ULID；随后补齐遗漏的 ULID_RE import。
- 旧 checkpoint 用例没有真实上游进度，改成完整 executor 在 completed 与 exited 之间模拟中断。
- 首轮全量 422 测试 / 37 文件通过，build:all 通过；输入/产物变更、连续恢复、版本化审批与已落盘决策恢复有明确回归。
- 实际预览首轮因 fixture 的 file-nonempty 参数漏填被阻断，脚本超时退出并确认 pid 不存在；改用结构化 YAML 参数后重新运行。
- 最终 424 测试 / 37 文件通过，typecheck/build:all/diff 检查通过；额外覆盖同名跨 workflow 审批、迟到旧失效事件和等待同步取消。
- 实际 HTTP 验收：不变输入重启 worker 调用保持 1 次，PRD 更新后旧审批 409、worker 调用 2 次，共识推翻后机器 block，health/doctor 通过。
- 推送第一次报低于 1 bytes/sec 持续 15 秒，第二次 45 秒有界超时，HTTP/1.1 ls-remote 15 秒核验超时；不能确认远端已更新，本地实现提交已保留。

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
