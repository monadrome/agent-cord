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
