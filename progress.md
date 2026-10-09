# 工作进度

## 2026-10-08（阶段 36）

- 上一轮有已验证的实现与两个本地提交，当前 HEAD=2317f8e，工作树干净、领先本地 origin 引用 2 次提交；上轮 GitHub 网络失败不阻断本地优化。
- agent-optimizer 审查发现 ADR-0032/prompt 禁止工具，但独立协调循环忽略 tool_use，自定义 ACP/headless 仍可返回成功提议。先记录 ADR-0050 与独立调研，准备工具违规、进程收束、历史身份及恢复反例。
- Firecrawl 读取 Anthropic 预定义 workflow/工具边界资料；ACP `/protocol/session-updates` 返回 404，不作为协议证据，改读 `/protocol/tool-calls`。
- 7 个核心新增反例全部失败，确认工具事件被忽略、driver 未中止、旧身份仍有效；ACP Tool Calls 正文已核验，权限请求为 MAY，宿主检测不声明预执行隔离。server 补测首轮 PID 断言含非法 await，修正为先读取再同步断言后继续反例验证。
- 4 个 REST 新反例（Claude/Codex/ACP 违规与旧策略迁移）也全部失败，证实真实驱动仍返回 adoptable=true。新增 fixture 无工具模式只用于合规协调；普通 worker/driver 测试仍报告工具。实现消费端即时 abort、固定 failed/driver、保留首个失败与 v7/v5 策略输入身份，开始进程与恢复回归。
- 首轮定向 155/157 通过、build:all 通过；ACP 工具后立即关闭迭代器时取消通知未送达，新增 driver 反例并补有界取消序列的单次启动与清理等待。另一个失败为旧 Codex 辅助通知用例仍报告命令工具，改为显式无工具 fixture，不放宽消费策略。
- ACP driver 新反例先复现取消通知缺失，修复后 158 项定向与 build:all/typecheck 通过。首轮全量 806/807，剩余为发布版本隔离测试中的协调 fixture 仍调用工具，已将该协调别名标为无工具，worker 保持原样；继续最终全量与隔离实际 HTTP 验收。
- 最终全量 807 测试 / 62 文件通过。隔离实际 HTTP 的违规 headless/ACP 均 failed/driver、不可采用并回收进程，真实 Claude 命名角色一次调用在最新 B 快照下返回 ok/current wait 且工具数为 0。首次重启立即断言 current=true 失败；随后只读打开原工作区核验，current=true、input_hash 与原完成完全相同，审批 ID 不变且没有新 workflow 事实。修正验收为等待同一轮次恢复稳定，不重复付费调用，继续审计原数据。
- 原数据审计首次 doctor=false 仅为 ledger 投影漂移，事实/session/链/唯一性均通过；经已有 readLedger 重建后 doctor=true。原工作区审计通过，只有三次协调完成（违规两次、真实 Claude 一次），模型未重放、PRD/审批 ID 不变，人工决定/节点退出/worker/采用/用户取消为 0。
- 最新源码 detached 预览 `http://127.0.0.1:7313/#/requirements/REQ-ROLE-BOUNDARY/coordination`（PID 14129），最新 wait current=true、两次违规 failed。Playwright/Chrome 1440/390/320 验证固定失败正文与边界、无提议/采用按钮、文档来源跳转，无溢出/pageerror，截图已查看无重叠。运行结果和截图仅在临时目录；README/协议/架构/ADR 索引与公开验收记录同步。
- 最终差异审查与 git diff --check 通过，原真实 Draft 7306 实时健康、审批 1、人工决定 0、done 未退出；阶段 36 进入独立本地提交与有界远端同步，持续目标保持 active。

## 2026-10-08（阶段 35）

- 上一轮为已验证进展，当前 HEAD=cd9e75a，工作区干净并与远端同步。
- 现有 runner 可跨 run 复用有效任务，但当前 run 没有完成事实，执行观察会变为 missing。ADR-0049 先行，增加显式复用 provenance，不伪造新执行或放宽 checkpoint/gate。
- 3 个跨 run/追加失败/server missing 反例已复现，输入变化重跑对照通过；开始显式 reused 事实、原完成引用与恢复去重，绑定执行观察升级 v6。
- 首轮实现后 45 项相关测试与 build:all 通过，新 run 投影为 reused，冷恢复不重复 worker/复用事实。补充原完成引用、坏最新去重与改需求后重跑的边界回归。
- 扩展 49 项定向通过；进一步补齐 reused prompt/原完成 ID 拒绝和旧 hook 输入兼容，准备全量及隔离实际协调验收。
- 首轮全量 789 测试 / 62 文件与 build:all 通过。新增展开复用事件到原完成的导航，保持前端只展示 server 事实，继续真实协调与浏览器两步来源验收。
- 来源导航后的 789 全量与 build/typecheck 通过，真实两个 run 的 worker 总调用 1 次，Claude 正确区分 ok/reused 并引用当前复用事件及原完成 ID；报告不变，doctor=true，无人工决定/节点退出/采用。最后审查补齐原完成与调用上下文的流程/节点一致性拒绝及回归。
- 最终 790 测试 / 62 文件和 build:all 通过。浏览器 1440/390/320 两步来源导航全通过，无 pageerror/溢出，tooltip 与容器边界正常；截图已查看无重叠。
- 原真实 Draft 实时 health=true、审批 1、人工决定 0、done 未退出。预览 `http://127.0.0.1:7312/#/requirements/REQ-REUSED-REPORT/coordination` 保留真实 reused wait Draft，运行数据不入库；协议/架构/ADR 索引与公开验收记录同步。
- 最终 typecheck/git diff --check 通过，预览确认无在途协调后重启到最终源码。差异审查完成，进入本地提交与 HTTP/2 有界推送，持续目标保持 active。
- 交接续接核对全部差异和临时实际验收证据；补查发现原完成 attempt 超过 max_attempts 时，直接观察为 invalid，但 checkpoint/复用引用未拒绝。新增原引用、worker 重跑后恢复和 server invalid→reused 三项反例，先验证再修复。
- 三项新反例全部失败，确认缺口；补齐 checkpoint 与原完成引用的重试上限校验，未改 schema/ports。原引用和原生 worker 的失败→重跑→有效复用、server invalid→reused 将一并回归。
- 补齐后 46 项定向、完整 793 测试 / 62 文件、build:all/typecheck/git diff --check 通过。7312 预览无在途协调，重启到最新代码（PID 76112）后 started/completed/reused 仍各 1 条，最新 wait current=true、审批 1、人工决定/节点退出 0；7306 原真实 Draft 健康、人工待审、done 未退出。
- 功能提交 `a802351`（23 文件），HTTP/2 有界推送退出码 128：低于 1 bytes/sec 持续 15 秒；远端 ls-remote 在 20 秒上限后终止，GitHub 443 独立连接检查 5 秒超时。本地提交保留，远端实际状态未确认；不重启原真实 Draft、不改全局 Git 配置。
- 用户明确本项目可以小步提交，已记入计划的当前状态；后续按独立、已验证的增量提交，持续优化目标保持 active。

## 2026-10-08（阶段 34）

- 上一轮为已验证进展，当前 HEAD=e426eb9，工作区干净且与远端同步。
- 独立协调没有 run/worker 执行观察，started→failed/timeout 不改变其输入；历史 started 不能证明进程当前活着。ADR-0048 先行，增加受限观察、run provenance 与活动运行行动约束。
- 9 个核心反例先全部复现，开始实现契约、worker run_id、宿主执行投影与 v5 协调身份，来源沿用事件定位展开交互。
- 首轮核心 9 与构建/typecheck 通过；扩展 73 项定向中 71 通过，活动用例 fixture 的 fail 模式忽略 sleep，已改为真实静默 worker。旧采用写失败恢复用例因新增 run 事实使输入过期，更新为先拒绝旧提议、重新协调后再采用，不绕过新鲜度。
- 校准后定向 67 项通过；全量 765 测试 / 61 文件、build:all/typecheck/git diff --check 通过。
- 隔离工作区真实 worker 退出码 3 失败→修复后产计划 Draft 停人工 gate，真实 Claude 两轮正确引用 failed/ok 最新任务与 active=false/true，输入/执行观察摘要不同、旧轮次失效，无工具/人工决定/退出/采用，doctor=true。继续冷观察与浏览器来源验收。
- 第三次真实 Claude 冷启动协调引用同一 ok 任务且 active=false，旧活动轮次过期；无 worker 重放、新工作流事实或人工决定，doctor=true。
- 浏览器首轮未启动：原 Playwright npm 缓存路径已清理且未找到其他缓存，临时目录单独安装工具恢复验收，不改应用依赖。预览 7311 与原真实 Draft 实时健康，原 gate 仍未决。
- 临时 Playwright 1.58.2 与本机 Chrome 验收通过：1440/390/320 任务来源均定位并展开正确 event/run/status，无溢出/pageerror。重置滚动位置后桌面/手机截图已查看，无内容重叠。
- 当前预览 `http://127.0.0.1:7311/#/requirements/REQ-TASK-OBSERVATION/coordination` 展示真实冷启动 wait Draft，current=true；事件/模型正文/截图仅留在临时目录。差异审查完成，进入提交与有界推送，持续目标保持 active。
- 功能提交 `65270f9`，HTTP/2 推送成功（origin/exp/impl：e426eb9→65270f9），远端 ls-remote 确认同一 hash，工作区干净。预览实时三轮 ok、最新 current=true、旧两轮 false，审批 1、人工决定/节点退出 0；持续目标保持 active。

## 2026-10-08（阶段 33）

- 上一轮为已验证实现进展；当前 HEAD=8aeb08f，工作树干净，领先 5 个本地提交。
- 快照普通读取跳过坏行且未验证 session；无机器验证声明时独立协调缺少严格读取保护。ADR-0047 先行，准备可选严格端口与共享读侧，保留诊断浏览和冷恢复原子尾行语义。
- 新增 10 个快照/派发/在途/查询采用/冷恢复反例全部复现；实现原生 readOrderedStrict、共享 readSessionEvents 与协调恢复按需求隔离。
- 197 项相关测试与 build:all 通过；补齐坏未完成轮次保留原事实、健康需求继续协调、旧端口兼容和明确取消时真实子进程收束，不伪造取消请求或成功响应。
- 最终全量 735 测试 / 59 文件、build:all 通过；实际 HTTP 拒绝损坏材料、同键修复、冷恢复隔离、健康需求协调与取消 PID 回收全通过，doctor=true，没有人工决定/节点退出/worker/采用。
- 原真实 Draft 实时核验 health=true、审批 1、人工决定 0、done 未退出。协议、架构、ADR 索引和公开验收记录同步，继续最终类型与差异审查。
- 最终 typecheck/git diff --check 通过，差异审查完成。临时预览恢复为无延迟离线 fixture，启动最新代码后进入本地提交与有界推送。
- 功能提交 `33e0548`；本轮改用 HTTP/2 后推送成功（origin/exp/impl：f5ab910→33e0548），ls-remote 确认远端 hash 相同。阶段 30–33 的本地积压提交已同步，不改全局 Git 设置；持续目标保持 active。
- 最新源码预览 `http://127.0.0.1:7310/#/requirements/REQ-EVENT-INTEGRITY/coordination` health=true，展示真实取消/中断恢复事实；临时工作区与运行数据不入库。

## 2026-10-08（阶段 32）

- 上一轮属于已验证的实现进展；当前工作区干净，HEAD=e310f98，本地领先 3 个提交，GitHub 低速问题不阻断本地优化。
- 用 agent-optimizer 检查实际模型输入，发现前缀截断丢失长需求尾部、顺序预算挤掉后续报告。Firecrawl 已读取 Anthropic 上下文工程资料，研究文档与 ADR-0046 先行。
- 4 个新增/增强反例全部复现：长 PRD 尾部、受限预算跨文档、在途尾部恢复与真实 ACP fixture 跨重启均缺少尾部。开始实现共享首尾采集、均衡预算和 v4 输入身份。
- 首轮实现后 91 项核心/server 定向测试通过，补齐短文档额度回流、UTF-16 范围、非法预算与旧策略提议迁移回归。
- 最终定向 100、全量 713 测试 / 57 文件通过，build:all/typecheck 通过。真实 Claude 第一轮引用三个最新尾部标记且 prompt=59950，第二轮验证重启和更新中。
- 真实 Claude 第二轮同样 ok/current，引用三个 B 尾部标记；重启不变有效、尾部更新使旧轮次失效，新会话 ID 不同。无工具/worker/人工决定/节点退出，审批 ID 不变，原文保持不变，doctor=true。实际证据仅在隔离临时目录，公开研究记录同步。
- 原真实 Draft 实时核验仍 health=true、审批 1、人工决定 0、done 未退出。阶段 32 进入差异审查、提交与有界推送。
- 已启动只读查看预览 `http://127.0.0.1:7309/#/requirements/REQ-CONTEXT-COVERAGE/coordination`；实时 HTTP 核验最新 B 轮 current=true、旧 A 轮 false、人工待审数 1、人工决定 0。
- 功能提交 `e5b11da`；有界 HTTP/1.1 推送返回 curl 28（低于 1 bytes/sec 持续 15 秒）、sideband 断连及退出码 1，伴随 Everything up-to-date 不视为成功。远端核验因 10 秒低速失败，保留本地提交待后续同步；持续目标保持 active。

## 2026-10-08（阶段 31）

- 承接验证证据一致性实现：共享 schema/读取/解析与取消检查已完成，ADR-0045 已先行；原真实 Draft gate 保持未决。
- 首轮全量 700/701 通过，build:all 已通过；真实宿主命令退出码 1→0 已验证 REST 拒绝矛盾 passed、同键修复、重启保留失败与恢复到人工终审。
- 剩余失败定位到 gate.waiting 后 ask 重检的源码读取错误使 run 永久 failed；新增确定性时序复现，继续修复并完成最终验证、文档和提交推送。
- 单测已确定性复现 run=failed；对已挂起的 VerificationInputError 保留等待，其他错误仍上抛，修复后验证可唤醒原 run。
- 96 项定向测试及全量 701 测试 / 56 文件通过，build:all 通过；协议、ADR 索引和公开验收记录同步，进入最终类型与差异检查。
- 原真实 Draft 经实时 HTTP 核验 health=true、审批数 1、人工决定 0、done 未退出。
- 最终 typecheck 与 git diff --check 通过，差异审查完成；阶段 31 实现和验收记录进入提交与有界推送，持续目标保持 active。
- 实现提交 `b501fa5`；HTTP/1.1 推送因低于 1 bytes/sec 持续 15 秒失败，远端 ls-remote 核验也因持续 10 秒低速失败。本地提交保留，阶段 30/31 的远端同步未确认，不因网络问题结束持续目标。

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
- 开始阶段 15：核验当前提交与工作树，定位 workflow_id 单独过滤的跨 SDLC 版本问题，准备同定义不同发布版本、审批/取消/快照与索引恢复的真实回归。
- ADR-0034 先行；workflow_revision 覆盖完整定义与发布绑定，贯穿 executor/worker/gate/checker/snapshot/协调/投影。新增 workflow.run.started 事实与可空索引列，当前版本按因果启动事实定位。
- 7 个新反例全部复现；实现后首轮全量 505/507，两个旧中断 fixture 缺新绑定被正确拒绝，已更新新协议窗口。45 个相关用例 / 4 文件及 build/typecheck/diff 通过，进入实际 HTTP 验收。
- 最终 510 测试 / 44 文件、`npm run typecheck`、`npm run build:all`、`git diff --check` 全通过；核心 hash/reducer 仍保持纯函数，版本身份由新的纯 scope helper 派生。
- 实际 HTTP 首轮等待旧 run ID 超时；事件与 SQLite 证明新恢复尝试已完成，改为核验当前绑定/完成态后第二轮完整通过。证据 `/tmp/cord-stage15-preview-r2/smoke-result.json`。
- Playwright 1440/390/320 无溢出、pageerror=0，选择 v2、协调采用、对应版本人工 gate、completed 闭环通过，doctor=true。browser-result.json 与 version-1440.png / version-390.png 保留证据。
- 可采用的离线预览 `http://127.0.0.1:7302/#/requirements/REQ-VERSION-DEMO/coordination`，工作区 `/tmp/cord-stage15-preview-r2`；旧无版本数据保留审计但不自动猜测归属，重新 start 指定版本重新核验。阶段 15 进入提交与推送。
- 功能提交 `7f2234d`，推送成功（origin/exp/impl：`c5a32e7` → `7f2234d`）；当前实现和验收文档已同步，持续目标下一步为幂等/文件边界与真实需求运行。
- 开始阶段 16：核验 `49982d3` 与干净工作树，检查到全局响应后幂等缓存没有输入绑定/业务前占位，准备统一共享入口和未确认结果的恢复边界。
- ADR-0035 先行，共享请求身份/并发响应/pending 占位/completed 缓存替代局部映射。7 个反例复现后通过，25 个幂等/迁移/故障/断连用例与 typecheck 通过，准备全量验证。
- 最终 536 测试 / 45 文件、`npm run build:all`、`npm run typecheck`、`git diff --check` 全通过，既有 SDLC/worker/协调/审批恢复仍通过。
- 实际 HTTP 五并发各入口各执行一次，输入变化 409、跨重启成功重放、缓存故障/残留 pending 阻止盲重做、4xx 修复重试与 doctor=true；证据 `/tmp/cord-stage16-preview/smoke-result.json`。
- 离线协调预览 `http://127.0.0.1:7303/#/requirements/REQ-IDEMPOTENCY-DEMO/coordination`，未调用外部模型。阶段 16 准备提交推送，持续目标后续为文件边界、真实模型/需求与可复用配置示例。
- 最后补齐流式写响应的失败收束，最终 537 测试 / 45 文件、build:all/typecheck/diff 全通过。最新代码的第二轮真实 HTTP 五并发闭环再次通过。
- 最终离线预览 `http://127.0.0.1:7304/#/requirements/REQ-IDEMPOTENCY-DEMO/coordination`，工作区 `/tmp/cord-stage16-preview-final`，smoke-result.json / browser-result.json 与 desktop/mobile 截图保存证据；1440/390/320 无溢出，pageerror=0，doctor=true，协调提议可采用。
- 功能提交 `1056ed1`，推送成功（origin/exp/impl：`49982d3` → `1056ed1`），预览 health 正常；持续目标下一轮继续文件 checker/REST 文档访问边界与真实模型运行。
- 开始阶段 17：核验 `0231ab2` 与干净工作树，定位文件 checker/REST 文档路径跟随链接与 IO 伪装缺失；准备共享 helper、回归、接入示例和临时工作区真实 CLI 验证。
- ADR-0036 先行，提升 core/session-files，共用 no-follow 普通文件元信息/读取与原子写回，checker/REST 使用同一边界；旧 coordinator 导入保留。43 个相关用例和 18 个扩展定向用例、typecheck 通过。
- 新增 examples/agents.yaml 与 agent-sdlc.yaml，包含 ACP、Claude 命名角色和 Codex；配置/角色 JSON/流程/checker 解析通过。准备两个最新 PRD 下的真实 Codex 协调轮次，隔离临时工作区、有界超时，不自动采用或批准。
- 全量 555 测试通过后真实 Codex 首轮 failed/output；诊断第二轮证明 item.error 配置通知污染了合法 JSON 且 thread 回执丢失。ADR-0037 与 4 个协议回归先行，修复 metadata/session ID/approval_policy，62 个相关用例通过。
- 修复后两轮真实 Codex 0.160.0 协调 VERSION_A/B 均 ok/current，不同输入/快照/会话 ID，旧轮次失效，PRD 未改、doctor=true。证据 `/tmp/cord-stage17-real-result.json` 与临时工作区 real-result.json；全量 558 测试 / 49 文件与 typecheck/diff 通过，准备真实提议预览与 HTTP 边界验收。
- 临时 git 仓库补本地 merge driver 注册后 HTTP 边界/门禁恢复与 workspace doctor 全通过；读错误控制台保持编辑/保存禁用，404 新文档仍可创建。Playwright 1440/390/320 无溢出/pageerror，真实 VERSION_B 提议正确呈现。
- 最终 558 离线测试 / 49 文件、build:all/typecheck/diff 全通过。真实提议预览 `http://127.0.0.1:7305/#/requirements/REQ-REAL-CONTEXT/coordination`；real/http/browser-result.json 与截图保留在临时工作区，公开研究记录不提交运行数据或凭据。
- 阶段 17 进入提交推送；后续真实开发需求全链路、Claude/ACP 实际调用仍待验证，持续目标不以两轮 Codex 协调测试代替全部需求。
- 功能提交 `325f8c4`，推送成功（origin/exp/impl：`0231ab2` → `325f8c4`）；当前代码、示例与公开验收记录同步，预览 health 正常。
- 开始阶段 18：核验干净工作树与提交，发现 readonly worker 完整报告不会进入 artifact，准备显式文本产物通道与真实开发/评审 Draft 验收。
- ADR-0038、run.output=text、宿主报告写回/prompt/checkpoint 实现；9 个核心回归先复现 6 个失败，修复后 85 个相关用例通过。server 报告/审批/重启/空结果恢复与开发示例解析通过，全量 570 测试 / 51 文件、build/typecheck/diff 通过。
- 独立本地 clone 的真实属性测试 Draft 运行已启动，协调成功、plan 在途；计划/实现/只读评审与宿主验证有界执行，最终人工 gate 保留，不合入当前分支。
- 真实plan成功，初次implement在240秒预算内timeout，保留Draft与失败事实。宿主目标57与完整615/50文件、typecheck/diff全通过；真实 file_change通知污染正文，ADR-0039与parser工具映射修复通过。
- 最新PRD恢复附记明确缓存/监听限制和host证据，同版本只恢复implement，计划未重跑；implement/readonly verify均生成真实成功产物，verify报告由coordinator代写，人工gate保持等待，无决策/合入。
- reviewer自身测试因readonly SSR临时目录权限未执行，报告明确区分host通过与自身静态核验，不能把任务ok当测试通过。主工作树572测试/51文件、build/typecheck/diff通过，进入pending gate浏览器验收。
- Playwright 1440/390/320 无溢出/pageerror，人工gate未决、报告可读且环境限制明确、plan只调用一次、done未推进；没有自动批准/合入。预览 `http://127.0.0.1:7306/#/requirements/REQ-INPUT-PROPERTIES/approvals`。
- 真实运行、超时、恢复与宿主验证证据仅在隔离clone及临时JSON/截图，公开总结已写 docs/research/2026-10-07-development-draft-workflow.md。阶段18功能与验收完成至人工gate，准备提交推送；机器验证事实通道与Claude/ACP实际调用仍待后续。
- 阶段 18 功能提交 `8b0ba10` 已成功推送（origin/exp/impl：`234508e` → `8b0ba10`）；真实 Draft gate 仍待人工，未自动批准。

## 阶段 19：真实 Claude/ACP 驱动冒烟与 ACP 会话回执（已实现并验证）

- [x] 在临时只读目录真实调用 Claude headless 与 Claude 命名角色封装
- [x] 在临时只读目录真实调用 Kimi ACP，并核验 initialize/session/new/session/prompt 终态
- [x] 修复 ACP 事件流顶层 `AgentEvent.session_id` 未统一回填的问题，保留 result/error data 兼容字段
- [x] 增加 ACP 全事件回执回归、ADR/协议说明和公开研究记录
- [x] 定向测试、真实 CLI 冒烟、typecheck/build/diff 验证

### 阶段 19 验证记录

- Claude Code 2.1.220：`headless:claude` 与 `headless:claude-architect` 均成功返回预期 smoke 终态；角色 argv 含 `--agents`、`--agent architect`、计划权限模式和只读工具白名单。
- Kimi Code 2.1.1：`acp:kimi-acp` 成功返回预期 smoke 终态；修复后所有输出事件与终态共享同一 session 回执。
- 未记录真实会话正文、凭据或运行目录；调用均未修改当前仓库。
- 真实证据记录于 `docs/research/2026-10-08-real-agent-driver-smoke.md`；完整开发 Draft 的人工 gate 仍保持未决。

## 阶段 20：结构化机器验证证据（已实现并验证）

- [x] 新增 `verification.completed` 事件与 payload 契约，摘要 hash 不携带长日志
- [x] 新增带当前 `input_hash` 的 `verification-passed` fail-closed checker
- [x] gate 求值向 checker 透传当前输入指纹，旧结果不能复用
- [x] 新增 verification context/read 与 idempotent record REST API
- [x] 新增机器验证 SDLC 示例，覆盖成功、幂等重放和输入变化 409
- [x] 同步 ADR、协议、示例和测试

### 阶段 20 验证记录

- 定向 28 个测试通过：checker scope/hash/状态边界，以及 REST 等待人工 gate → 提交机器结果 → 自动放行 verify 节点的闭环。
- 机器验证 REST 不写 stdout/stderr 正文；输入指纹在服务端重算，旧 hash 在事件写入前返回 409。
- 全量 577 测试 / 52 文件、typecheck、build:all、diff 检查通过；真实开发 Draft 人工 gate 仍保持未决。

## 阶段 21：真实 Claude/ACP Context Session Agent 协调验证（已实现并验证）

- [x] 在临时 git 工作区使用真实 Claude 命名角色封装完成最新快照协调
- [x] 在同一隔离场景使用真实 Kimi ACP 完成最新快照协调
- [x] 核验严格提议、marker 来源、新鲜度 hash、configuration hash、session 回执和无 workflow/task 副作用
- [x] 核验 PRD 不被协调 agent 修改，session doctor=true
- [x] 同步研究记录与当前架构边界

### 阶段 21 验证记录

- `claude-coordinator` 与 `kimi-coordinator` 均 `ok/current=true`，提议 summary 命中各自 PRD marker，行动均为只读 `wait`。
- 两轮 `input_hash`、`snapshot_id`、`agent_session_id` 均不同；事件流没有 `workflow.node.*` 或 `agent.task.*`。
- 真实证据记录于 `docs/research/2026-10-08-real-claude-acp-coordination.md`；开发 Draft 的人工 gate、人工批准、合入和异构评审仍未完成。

## 阶段 23：控制台机器验证可观察性（已实现并验证）

- [x] 需求概览展示机器验证事实、状态、run、节点、输入 hash 摘要和时间
- [x] 历史 run 与当前 run 明确区分，失败/超时/取消不隐藏
- [x] 同步当前架构 API 说明
- [x] console typecheck、定向测试、build:all 和 diff check 通过

## 阶段 24：外部机器验证等待与自动重检（已实现并验证）

- [x] 允许验证 gate 使用 `on_fail: escalate` 等待外部验证事实
- [x] 验证事实落盘后只唤醒同一 run 的挂起 gate，触发 executor 重检
- [x] 更新机器验证示例为真实 CI/宿主等待流程
- [x] 覆盖验证事件、重检、完成和过期 hash 失败路径

## 阶段 25：机器验证重启恢复（已实现并验证）

- [x] recovery 识别已落盘的同一 run `verification.completed`
- [x] 重启后恢复 executor 并重新求值 pending verification gate
- [x] 覆盖验证事实先落盘、server 重启、同一 run 完成路径

## 阶段 26：验证唤醒与恢复时序（已实现并验证）

- 三个新 REST 反例复现：重启后提交无人唤醒、结果在 ask 建立前到达丢失、历史验证反复恢复人工终审。
- 已修复引用 ID 范围、恢复串行化、Promise 建立后重检；重启后的人工选择保留原 run 的机器证据。
- 验证/审批/执行版本定向 34 测试通过，typecheck 通过；新增失败后恢复与取消后的迟到拒绝。
- 实际宿主 HTTP 验收完成：clone 基线 6c5e345，真实 hash/scope 离线命令退出 0，server 重启后提交恢复原 run，停在人工 gate，再次重启审批 ID 保持，human.decision=0，doctor=true。运行数据和命令日志仅在临时目录。
- 最终全量 586 测试 / 52 文件、build:all、typecheck、diff 检查通过；真实 clone 命令独立为 13/13。公开验收记录为 docs/research/2026-10-08-host-verification-recovery.md。

## 阶段 27：验证源码输入身份（已实现并验证）

- 四个真实 REST 反例先复现：代码修改、增删后 input_hash 不变，重启后的旧人工审批仍返回 200。
- ADR-0041 先行；新增 verification-inputs 清单，显式文件/目录范围取并集，字节 hash/类型/权限/目录清单组合 source_hash，统一 REST/gate/人工审批/recovery 输入函数。
- 源码正文不进入事件；缺失/链接/硬链接/保留路径/IO/扫描变动/数量与字节上限 fail-closed，依赖和构建目录排除。默认未声明 inputs 保持文档范围兼容。
- 65 个源码边界/REST/checker 用例通过，根构建和 typecheck 通过。新增测试首次对 ESM fs namespace spy 被拒，改用仓库已有 vi.mock 注入后通过。
- 开发与机器验证示例声明源码/测试/依赖清单输入；最终人工 gate 重检机器结果，防止前置机器 gate 通过后代码变化。
- 真实宿主 clone（基线 8b673de）13/13 目标测试通过，新增源码后旧结果 409，恢复原清单后成功提交并停在人工 gate；原 run/审批保持、human.decision=0、doctor=true。
- 新增启动失败反例定位到声明源码缺失令 recovery 抛错；保留该 run 等待、健康服务可用且审批/提交 409，修复后重新验证恢复。
- 最终全量 619 测试 / 53 文件、build:all、typecheck 和 diff 检查通过；本轮没有修改控制台，不需要重跑 UI 截图。公开记录 docs/research/2026-10-08-verification-source-identity.md。

## 阶段 28：只读 worker 源码新鲜度（已实现并验证）

- ADR-0042 先行，6 个核心反例先复现旧评审复用、在途报告写回及不可读摘要未阻断。
- 已增加只读源码摘要钩子、绑定时 v3 执行身份和任务 source_hash，恢复重新核验摘要与 provenance，写回前重检；可写节点和无绑定节点保持原规则。
- 核心/server 定向 14 用例通过，包含真实子进程的同源码复用、源码变化重启、在途变化不写报告与恢复。typecheck 和根构建通过。
- 补充取消期间重检、任意异常 fail-closed、缺失 source provenance 拒绝和人工等待期间源码变更再评审回归。
- 首轮全量 631/632 通过，源码缺失重启用例暴露 app.close 未收束旧 runner 的竞态；独立关闭回归先复现活跃 map 保持 true。新增 RunService.close 与 onClose 桥接，等待执行体收束且不把关闭记为用户取消，相关 36 定向测试通过。
- 活跃 fixture worker 的 PID 回收测试通过。冷重启用例的代码变更改在 app.close 完成之后执行，避免混用关闭前的 live 输入变化与冷恢复时序；在途变化仍由独立失败/恢复用例覆盖。
- 最终全量 634 测试 / 54 文件、build:all、typecheck、diff 检查通过。10 个核心源码新鲜度回归与真实 fixture 子进程覆盖恢复、失败、取消和关闭；本轮没有调用新模型或处理真实人工审批。

## 阶段 29：协调提议源码新鲜度（已实现并验证）

- ADR-0043 先行；5 个核心和 6 个 REST 反例全部复现：源码变更后仍可采用、在途变化仍成功、guard 及不可读范围未阻断。
- 已接入流程声明范围并集和宿主摘要钩子，prompt/轮次记录 source_hash，源码绑定的输入用 v2 域，无绑定保留 v1。完成、查询与采用 guard 使用同一源码范围。
- 首轮 61 个定向测试通过，根构建/typecheck 通过；补充中断 provenance、缺失输入修复与取消/任意异常回归。
- 真实 Claude Code 2.1.220 命名角色两轮源码绑定协调均 ok/current=true；PRD 不变而源码版本改变后旧轮次 current=false，新 source_hash/input_hash/session ID 不同，workflow/task/human 决定事件为 0、doctor=true。
- 最终全量 649 测试 / 54 文件、build:all、typecheck、diff 检查通过。公开记录 docs/research/2026-10-08-source-bound-coordination.md；运行数据仅保留在临时工作区。
- 最新预览在临时验收目录启动，health=true，最新轮次 current=true/旧轮次 current=false：`http://127.0.0.1:7307/#/requirements/REQ-SOURCE-CONTEXT/coordination`。启动后首个立即 health 请求早于 listen，确认进程和监听日志后再次核验通过。

## 阶段 30：协调机器验证上下文（已实现并验证）

- ADR-0044 先行，受限验证观察只包含当前 run/声明检查的最新机器状态与摘要，不注入 summary/日志。
- 核心严格结构校验、verification 事件来源、input v3 身份、观察摘要 provenance 和完成/查询/采用重检已接入。
- 88 个核心/投影/REST 定向测试通过，另有采用 guard 仅验证事件变化阻断回归；历史 run/发布版本、失败恢复、缺失/非法/不可读和取消均 fail-closed。
- 控制台验证来源跳转到对应结果事件并展开；复用已有布局，准备缓存 Playwright/Chrome 截图验证。
- 首次真实 Claude 因 workflow/human-intake（gate ID）引用被 failed/output 拒绝；明确 node.id 来源规则和单验证来源的验收约束后重跑，两轮引用当前失败/通过事件均 ok/current=true，人工审批 ID 保持、human.decision=0、doctor=true。
- 首轮全量 672/673，通过前关闭源码删除与挂起验证重检竞争；将缺失输入的冷重启测试改为 app.close 完成后删除，再启动，独立 live 变更仍由既有测试覆盖。
- 新增取消事实优先于登记更新的观察失效回归。最终全量 674 测试 / 55 文件、build:all、typecheck、diff 检查通过。
- Playwright/Chrome 1440/390/320 无横向溢出/pageerror，验证来源跳转并展开对应 passed 事件；桌面/手机截图已查看。预览 `http://127.0.0.1:7308/#/requirements/REQ-VERIFICATION-CONTEXT/coordination`，截图和实际运行证据仅在临时目录，公开记录 docs/research/2026-10-08-verification-context-coordination.md。

## 阶段 22：机器验证 run 级隔离（已实现并验证）

- [x] 将 `run_id` 注入 workflow CheckerContext
- [x] `verification-passed` 强制匹配当前 run，拒绝同输入旧 run 事实
- [x] 补充核心 checker 与 server 事件回归
- [x] 同步 ADR-0040 和协议说明

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
