# 工作进度

## 2026-10-10（阶段 58）

- 起点 `34832cb` 工作树干净、ahead 3；上一轮源码变更交付为已验证进展。协调者只看 source_hash，尚未消费宿主已核验的变更范围。
- ADR-0072 先行：先核验完整 ready，再生成计数/最多 16 路径/省略数/完整 evidence hash；不注入完整清单和正文，历史摘要不冒称当前有效。

## 2026-10-09（阶段 57）

- 起点 `78322ec` 工作树干净且同步，上一轮为已验证进展。Goal 指南的宿主测试/验收证据完整，但源码变更定位仍依赖模型文字。
- ADR-0071 先行：复用安全源码扫描、首次 source_manifest 基线、完整 delta 重算、宿主 review 变更章节；`review_changes` 在推荐模板默认开启，旧发布/库模式兼容。
- 同次安全扫描按需返回 manifest，常规 verification-context REST 隐藏清单且 source/input 摘要域不因附加清单变化。首次 started 保存基线，ready/full delta/指南与实际验证身份绑定；路径/kind/mode/content_hash 无正文，序列化预算 1,000,000 字符/10,000 项，不生成部分证据。
- 库自动修复/模拟中断保留 initial 基线；hook 缺失/错摘要、基线 fsync 失败均不派发。共享证据拒绝缺失/漏项/伪造/错引用；服务冷人审缺基线 failed/409、协调 invalid，无重复 worker/人工决定/节点退出。
- ACP/headless 真子进程覆盖新增/删除/内容/权限变更、两次自主修复、指南可读、当前 ready、冷恢复同审批和伪造清单人审拒绝。首轮全量 1153、后续 1154 项通过，typecheck/build:all/diff 通过，最后新增两项缺基线恢复回归定向 41 项通过，待最终全量。
- 浏览器脚本首次错用 role=tab 定位超时，按实际文档按钮修正；1440/390/320 无溢出/pageerror，三行四列变更表与基线来源通过，截图已查看。完整文件 hash 在手机上过长，表内缩为前 12 位，事件保留完整值重算；最新证据 `/tmp/cord-stage57-browser-result.json`、预览 `53563`/PID `18808`、worker 2/审批 1/人工决定 0/节点退出 0/doctor=true，无付费模型调用，原真实 Draft 未操作。
- 最终候选全量 1155/1156 通过，旧审批 changed=true 用例观察超时；单独复跑通过。测试在 gate.waiting 可见但 ask 尚未登记时手工追加选择，旧 executor 有机会提前消费，未固定“落盘未消费”前提。测试先收束旧 runner 再追加选择，确定性保留待重启窗口，11 项审批回归通过；生产审批语义未改。
- 2026-10-10 收尾：最终全量 1156 项 / 80 文件通过，typecheck/build:all/diff、180 本地文档链接通过；隔离预览 HTTP 健康且保持审批 1，没有新人工决定或合入。准备独立测试稳定化提交与阶段功能提交，完整持续目标保持 active。
- 已创建 `0874746`（测试窗口稳定化）与 `0aefbcc`（`feat: attach host source changes to goal reviews`）；HTTP/2 push 与 ls-remote 均报 GitHub 443 连接约 75 秒超时，HTTP/1.1 push 达到 30 秒总时长上限（exit=124）。远端同步未确认，本地提交与全部证据保留，不回滚，工作区干净。

## 2026-10-09（阶段 56）

- 起点 `0387d4f` 工作树干净，上一轮 workspace lease 为已验证进展；当前内存 Map 无法约束同 root 的另一个实例。
- SQLite 本地探针证明独立文件 `BEGIN IMMEDIATE` 互斥，busy 为 `ERR_SQLITE_ERROR/errcode=5`，rollback 后可重新获取。已替换基础 lease，59 项相关回归和 15 项 lease 用例通过。
- 审查发现基础版把损坏/IO 都映射 busy、跨进程释放没有本地通知、SQLite 崩溃释放不证明 detached worker 消亡；正在补严格错误分类、恢复检查与明确的运行边界。
- 真实子进程强杀后 detached 子进程仍活着的反例已复现；最终增加 fsync owner 标记，只有正常收束删除，异常/更改时 fail-closed 不自动抢占。标记是执行资源，不改变 workflow 授权事实。
- 27 项执行锁/lease 回归通过，含真实双 server 进程 HTTP、root 别名、正常释放/强杀、损坏与链接、错误 owner、标记变更、跨实例原 run 自动恢复；ADR-0070/研究与 human review 指南已同步，进入全量验证。
- 最终全量 1133 项 / 79 文件、typecheck/build:all/diff 通过；真实双进程 HTTP 409/无启动事实、释放后一次 worker/人工 gate 未决/人工决定及节点退出 0。强杀/detached 回归均收束测试进程，无付费模型调用，没有操作原真实 Draft。准备独立提交与有界远端同步。
- 功能提交 `bf484ac`（`fix: guard workspace execution across server processes`）HTTP/2 push 成功；独立 ls-remote 核验远端 `bf484ac898161932097b8b95a4d307cef3d9121e`，阶段 54/55 积压一并同步。完整持续目标保持 active，worktree/OS/同需求多 daemon 写入和更完整自主协调仍需后续。

## 2026-10-09（阶段 53）

- d7a4103 工作树起点干净，ahead 4；上一轮严格未知 usage 修复为实际进展。HTTP/2 远端查询本轮 20 秒超时。
- 接资源投影时发现原累计不核验任务来源/配对，部分指标存在即可绕过费用限制，冷恢复没有 completed 的 started 不计量；ready 测试只改 candidate 不改 events，不能证明抗伪造汇总。
- ADR-0067 先行，修复共享计量/逐指标完整性/派发前检查/ready 重算，并把当前 run 的资源状态投影给协调模型及工作台；状态仍来自 server。沿用 planning-with-files 和既有控制台设计。
- 共享计量 18 项、runner/ready 65 项与 8 项真实 ACP/headless server 通过关键用例；首次资源测试错误假设需求尚未选择流程时已有预算，改为无绑定返回空。误把 server 观察测试写入库测试造成 helper 缺失，已改成库 prompt/提议契约测试，server 资源行为留在 server 测试。
- 逐指标缺失/零/超限、来源与配对错误、中断恢复/伪造 ready、当前 run 隔离均已覆盖；blocked 的验收清单不因缺 ready 验收证据禁止 supervisor。运行中未知计量文案改为等待当前任务结果，终态未知仍明确停止。
- 最终全量 1097 项 / 76 文件、typecheck/build:all/diff 通过；补充 `docs/research/2026-10-09-goal-usage-observation.md`，阶段 53 实现与验证完成，准备独立小步提交。
- 已提交 `ab7d2a1`（`feat: project observable goal usage resources`）；HTTP/2 push 成功，`git ls-remote` 核验 `exp/impl` 为 `ab7d2a1ca54ebb4543aec1207d6db51b11d721f1`。

## 2026-10-09（阶段 54）

- 公开调研确认 Claude Agent SDK 的 `PreToolUse` 和 OpenAI Agents SDK guardrails 都把工具/结果策略放在宿主控制面；ACP/headless 没有共同的执行前 hook，当前只读 worker 仅依赖 CLI 参数会留下自定义 wrapper 缺口。
- 新增 `readonly-tool-policy`：明确读工具与受限无副作用命令通过，写工具、`file_change`、未知工具、危险 git 参数、shell 控制语法或缺少命令输入 fail-closed；coordinator 记录 driver failure、`retryable=false`，不保存工具参数，当前迭代立即收束。
- 真实 headless 与 ACP fixture 回归覆盖 `Read`、ACP `read file`、Codex `command_execution` 安全命令及越权路径；该审计明确不替代 ACP permission、CLI/OS sandbox 或副作用回滚。
- 最终全量 1104 项 / 77 文件、typecheck/build:all/diff 通过；功能提交 `ec18ad5`（`fix: audit readonly worker tools`）HTTP/2 push 报成功；收尾文档提交 `a4e8988` 的 HTTP/2 与 HTTP/1.1 push、独立 `ls-remote` 均因 GitHub 低速（低于 1 bytes/sec 持续 15/20 秒）失败，两个本地提交保留，工作区干净。

## 2026-10-09（阶段 55）

- 发现 RunService 只限制同一需求 active run，同一 server workspace 的不同需求仍能同时启动 worker，共享源码/测试临时目录；先用进程内 workspace lease 建立 fail-fast 保护。
- lease 覆盖 start、冷恢复、人工授权 Goal 恢复；新请求冲突 409 不落额外事实。首次定向发现授权前错误导致 lease 未释放，最终修正启动 catch 无条件释放；safeFinish 不再提前释放，活动 executor 等 finally 收束。无 agent 流程兼容，冷恢复冲突保留原 run/预算并在释放后自动重检续跑。
- 新增真实 server 回归：同 workspace 冲突/取消释放、不同 workspace 并发、worker 启动失败释放；ADR-0069、研究/架构/协议/核心 feature/README 已同步，下一步全量验证。
- 两个新反例先复现登记前失败泄漏和冷恢复冲突伪造 failed；修复后 13 项 lease 回归及 2 项 Goal 占用回归通过，覆盖真实 ACP/headless 在途 PID 回收、并发单启动、冷/索引删除恢复、延后取消、无 agent 兼容、授权/恢复零额外事实。
- 增加启动校验期间关闭回归，14 项 lease 全绿。首轮全量 1118/1119 通过，唯一失败为旧 registry 测试同目录并行两需求的预期；改为旧 run 完成后启动新 run，仍验证热重载固定旧配置与新配置生效。
- 最终全量 1120 项 / 78 文件、typecheck/build:all/diff 通过。隔离实际 HTTP ACP/headless：冲突 409/被拒绝启动事实 0、取消后原 PID 回收、下一 worker 1 次/审批 1/人工决定 0/节点退出 0/doctor=true；无付费调用，服务已关闭，证据 `/tmp/cord-stage55-http-result.json`。
- ADR-0069 和研究 human review 指南已明确单实例 lease、热/冷人审差异、自动原授权恢复与后续 worktree/OS/跨 daemon 隔离限制；原真实开发 Draft 未操作。
- 功能提交 `9d8b755`（`fix: serialize shared workspace agent execution`）已创建；HTTP/2（15 秒）与 HTTP/1.1（10 秒）有界推送均因 GitHub 低速失败，远端 hash 未核验，本地提交保留，工作区干净。

## 2026-10-09（阶段 52）

- 当前 8c330ac 已同步远端且工作树干净；阶段 51 为已验证进展。审查发现 ACP/headless 已有规范化 usage，但 Goal 只保存 task usage，不累计也不限制目标资源。
- ADR-0066 先行：opt-in usage_budget（input/output token、cost），按合法 task.completed 累计，超限后 blocked/budget，不进入下一次 worker；unknown usage 不当零，未声明保持旧行为。
- 已实现 GoalUsageBudget/GoalUsageTotals、跨 task 累计和超限 blocker；ready 共用解析拒绝缺失/篡改/超限 usage 证据。新增 usage 边界/unknown/ready 反例，定向 61 项通过。
- 最终全量 1064 项 / 74 文件、typecheck/build:all/diff 通过；usage 是 opt-in，声明预算但 usage 未知时 fail-closed，未声明 Goal 行为不变。阶段 52 进入提交与有界同步，完整费用结算、动态扩额、workspace 总额及权限治理仍待后续。
- 功能提交 `7c732f6`（feat: enforce observable goal usage budgets）已用 HTTP/2 推送；独立 `ls-remote` 核验远端 `7c732f6937efb5e9d238bfec9409555907f80974` 一致。阶段 52 实现同步完成，完整持续目标 active。
- 追加提交 `55bdf3e` 修复 unknown usage 的 fail-closed 语义；定向 usage 3 项与全量 1064 项通过。HTTP/2/HTTP1.1 推送及 ls-remote 本轮均因 GitHub 低速失败，远端仍保持 `005876a` 未确认；本地提交保留，工作区干净。
- 后续文档索引提交 `c823256` 修正 ADR 计数；本轮 HTTP/2 推送再次因 GitHub 低速失败，远端仍未确认，usage 三提交留在本地，工作区保持干净。

## 2026-10-09（阶段 51）

- 当前 HEAD 89adad4、工作树起点干净且 tracking ahead 4；上一轮 e57118d 验收覆盖已完成，GitHub 同步仍受低速网络影响。
- 发现 supervisor 输出失败/stale 后没有绑定 blocker 的重试入口，普通协调要求重新选择 agent，重复请求也容易失去自动升级来源。
- ADR-0065 先行：新增受限 retry-coordination，复用同一 blocker/版本/配置核验，只重跑协调 agent，不启动 worker、不增加 Goal 预算、不消费旧回答。
- 初版定向 24/26 通过，stale 分支遗漏与同测试重复创建需求的 fixture 已修正；后续审查扩大为 token/父请求/持久重放，原始无 token 临时实现不作为最终协议。
- ADR-0065 更新：修复 supervisor 配置后可明确读取当前 token，记录三字段完整来源与 human actor；固定 resolver、同需求在途去重、latest 父轮次、派发前重检，Goal 授权/投影共享来源。
- 57 项初轮相关测试通过；新增完整用例后 32/33 自动升级通过，坏来源冷恢复应隔离需求却阻断服务启动，补 ApiError 来源诊断隔离后继续验证。类型检查与根 build 通过。
- 138 项协调/授权/console 相关测试通过；新增 expected_input_hash 在模型快照捕获时再次校验原重试输入，记录后/捕获前漂移不调用模型。5 项最新定向通过。文档同步最终 token、human actor、固定配置与父子来源契约，准备全量与隔离 browser 操作验收。
- 最新全量 1060 项 / 74 文件、typecheck/build:all/diff 通过；隔离 ACP/HTTP 配置修复后旧 token 409、retry round 父子来源、冷恢复和 1440/390/320 重试按钮路径通过。worker 首次 1、supervisor 重试 2、最终 worker 2、Goal 授权 1、gate 决策 0、done 退出 0、doctor=true；证据 `/tmp/cord-stage51-real-result.json` 与 `/tmp/cord-stage51-browser-result.json`，预览 PID 72974。
- 失败重试新增 expected_input_hash 捕获前检查、request 后输入变化 interrupted、坏来源需求隔离；完整持续目标 active，进入提交与有界同步。
- 功能提交 `1327314`（feat: retry failed goal coordination rounds）已用 HTTP/2 推送；独立 `ls-remote` 核验远端 `1327314af61dcaa11bfc795658446f652af865f9` 与本地一致。阶段 49/50/51 的积压提交一并同步，工作区保持干净，持续目标 active。

## 2026-10-09（阶段 50）

- 当前 f59b0d7 工作树干净，ahead 2；阶段 49 为已验证进展。HTTP/2 ls-remote 达到 20 秒上限，报告 GitHub 443 连接失败，未将网络问题当整体功能阻塞。
- 当前 Goal 仅检查命令与指南章节，缺发布验收条件到真实检查事件的映射。ADR-0064 先行：可选 acceptance、发布时全量映射校验、宿主生成矩阵/覆盖证据、ready/协调/恢复共享校验，明确不能证明业务测试充分性。
- 两个新增验收反例先因 acceptance 不受支持失败；实现契约、宿主覆盖矩阵/证据及共用 readiness 后定向 65 项通过，包含真实 ACP/headless 自主修复、冷恢复、过期与缺覆盖拒绝。
- 协调 hook/current ready 再校验覆盖契约，示例与推荐模板默认声明工程基线；补 Markdown 转义竖线/长证据单元格适配，防止验收文本或事件 ID 破坏移动端表格。
- 首轮全量 1040 项 / 74 文件与 typecheck/build:all/diff 通过，真实 ACP/HTTP、1440/390/320 矩阵和冷恢复通过。首轮浏览器文档选择器定位错误，改为真实 tab 后通过，无产品行为变更。
- 最终消费审查发现人审可仅凭 verification-passed 放行缺覆盖 ready；新反例先返回 200，补 post 人审/冷等待共享 ready 来源检查，继续最终回归。
- 人审拒绝缺覆盖反例修复后通过；冷缺覆盖 failed 无重复 worker。首个恢复测试误假设普通 failed run 会因修复历史自动再执行，改为独立当前有效覆盖的冷人审成功对照；保留原普通 failed 恢复边界，不扩展授权。
- 最终 1043 项 / 74 文件、typecheck/build:all/diff 通过；新 post 人审/冷等待拒绝与合法当前覆盖最终人审通过对照全绿。隔离最新 HTTP 缺覆盖人审 409、worker 2/observer 1/人工决定 0/退出 0，doctor=true，同一审批保持；预览 62939/PID 61215。
- 最新浏览器 1440/390/320 矩阵两行/四列、长事件 ID/转义文本、无溢出/pageerror 通过，桌面/320 viewport 与全页截图均已查看。8 份文档 135 本地链接及 diff 通过；原真实 7306 审批 1/gate 决策 0/done 退出 0。进入小步功能提交与有界同步；完整业务覆盖、权限与资源治理仍待继续，持续目标 active。
- 功能提交 `e57118d`（feat: bind goal acceptance criteria to host evidence）。HTTP/1.1 与 HTTP/2 有界推送均报低于 1 bytes/sec 持续 10 秒；独立 ls-remote 达到 20 秒上限。远端同步未确认，本地 tracking ahead 3（含阶段 49 两提交）；实现/验收保留，无需因网络失败重跑模型或测试。最新预览审批 1/worker 2/gate 决策 0/节点退出 0，完整持续目标 active。

## 2026-10-09（阶段 49）

- HEAD 94179bf 干净且与 origin 同步；上一轮身份修复为实际进展。配置还原后仅内部 recover 可调用，公开操作只能新 start 或重放 retry-goal，缺少原 run 恢复。
- ADR-0063 先行：恢复 current token/持久请求/服务端剩余预算与依据投影，原 run 恢复，不自动放行。请求后中断可按有效未消费意图恢复，blocked/耗尽不进入循环。
- 已实现 core 恢复事件与来源解析、GET/POST 恢复入口、请求落盘后冷恢复、同 run/预算与服务端投影、typed client/控制台恢复按钮。首个公开反例在入口缺失时先失败，补齐导出后通过；类型检查修正 unknown payload 访问后通过。
- 定向 26 项续跑/恢复通过：冷漂移还原同审批、写失败、并发/幂等、请求落盘后中断、输入变更、归档原版本恢复、取消/未授权/旧 token 和耗尽预算。尚未完成全量与浏览器验收。
- 全量 1026 项 / 74 文件、typecheck/build:all/diff 通过；隔离 HTTP/ACP 与 Playwright 1440/390/320 通过恢复按钮、旧 token 409、同 run/同审批、2 次 worker/1 次恢复请求/0 gate 决策/0 done 退出/无 pageerror。截图与证据 `/tmp/cord-stage49-*`，预览 PID 45217。
- 浏览器查看发现恢复后的派生 run error 仍显示授权中断旧文案；修正 `setRunStatus(running/waiting_human)` 清除派生 finished/error，历史事件仍保留，准备重新跑定向/构建后提交。
- 修正后定向恢复/已有尝试回归通过；全量 1026 项 / 74 文件、typecheck/build:all/diff 再次通过。隔离 ACP/HTTP 预览 `/tmp/cord-stage49-real-result.json` 与 Playwright `/tmp/cord-stage49-browser-result.json` 重新生成，桌面/390/320 无溢出/pageerror，旧失败文案清除，原 run/审批/预算保持。
- 阶段 49 功能与验收完成，进入小步提交与远端同步；持续目标仍 active，完整验收覆盖、跨 driver 权限和资源治理继续后续阶段。
- 最后独立冷启动保持原审批/worker 2、doctor=true；最新预览 62439/PID 65661，证据已更新。原真实 7306 审批 1/gate 决策 0/done 退出 0。同步 README 顶部旧能力描述与 API/协议目录，进入提交。
- 功能提交 `1565439`（feat: recover authorized goals without renewing budgets）。HTTP/1.1 推送报低于 1 bytes/sec 持续 15 秒；独立 ls-remote 达到 20 秒上限；HTTP/2 推送报低于 1 bytes/sec 持续 10 秒。远端同步未确认，本地 tracking ahead 1；保留提交并记录原因，不因网络故障回滚或阻断下一阶段独立功能。完整持续目标 active。

## 2026-10-09（阶段 48）

- d787af0 工作树干净、与本地 origin 同步；上一轮完成 Goal ready 共用核验，属于实际进展。
- 发现续跑 check 多次读取 live resolver，launch 使用另一次 frozen 捕获，重载可能校验 A 却执行 B；原授权无可独立核验 agent hash，冷恢复可换角色。
- ADR-0062 先行：同 resolver 校验/派发、新授权保存身份与节点输入，冷恢复/审批验证身份，旧授权有真实任务来源才归因；配置还原可显式恢复原 run，不重授预算。
- 接续核验工作树仅有阶段 48 设计记录。确定性 A/B/A 回归先失败，证明 token 校验 A 而 worker.started 实际配置 B。
- 已实现固定 resolver 校验/派发、授权完整三 hash、共用 worker 身份归因、恢复/审批拒绝漂移与显式原 run 恢复；开始定向验证，尚未完成全量验收。
- 首轮 15/17 通过；修正验收 API 缺 /decide，以及启动事实 driver 是实际协议名、completion 是别名的现有契约。第二轮 17 项全通过。新增冷旧授权与过期审批预算回归后 19/20 通过；过期机器 gate 按事件保留等待，改为直接核验原 run/尝试预算未增加，避免错误终态假设。
- 一次多文件补丁的 findings 标题匹配失败，补丁未应用；拆分精确上下文后完成。
- 20 项续跑与 Goal 交付/自动升级合计 43 项通过；全量 1016 项 / 74 文件通过，typecheck/build:all/diff 通过。公开协议/架构/核心 feature 同步实际状态。
- 隔离真实 ACP/HTTP 验证旧 token 409、授权 hash=任务 hash、冷漂移 failed/人审 409、还原同 run/同审批、幂等重放；worker 2/supervisor 1/授权 1/gate 决策 0/done 退出 0/doctor=true。证据 /tmp/cord-stage48-real-result.json，预览 61445/PID 51341；原真实 Draft 未操作。
- Playwright/Chrome 1440/390/320 审批与已执行协调状态、重复按钮移除、无溢出/pageerror 通过，桌面/320 截图已查看。两次脚本文本精确定位超时，按实际组件文案/元素修正后成功；没有重启 worker 或修改产品行为。
- 最终 typecheck、6 份文档 86 本地链接与 diff 检查通过；原真实 7306 Draft 审批仍 1，未操作。功能与验收已完成，进入小步提交/有界推送；完整验收覆盖与跨 driver 资源治理仍待继续，持续目标 active。
- 修复提交 `3a5789d`，HTTP/1.1 有界推送成功 d787af0 → 3a5789d；ls-remote 核验远端 `3a5789d33c9e0aadd3e7e6521bac93b31525eb54` 与本地一致。原真实 Draft 实时审批 1/gate 决策 0/done 退出 0。阶段 48 已完成，完整持续目标 active。

## 2026-10-09（阶段 47）

- ca4b93a 工作树干净、与本地 origin 同步，上一轮为已验证实现。核对 Goal 完成审计与协调投影，后者只复制 ready payload，没有来源与当前代码/指南重检。
- ADR-0061 先行，共享 Goal 结构证据解析；历史 status 与当前有效性分离，过期/不可读不能作当前 ready 来源，blocked 仍保留原阻塞事实。
- 两个原实现反例先失败：runner 复用先于 worker 的测试，协调 ready 没有当前身份字段。实现 resolveGoalReadiness 与 current/freshness_reason 后，首批 60 项相关测试通过；原人工构造、无 worker/test 来源的 ready 用例改为明确 invalid。
- 共用解析检查最新任务/验证、真实零退出、命令与输入身份、宿主来源和 run 取消；server 使用相同结构证据后重检当前代码/指南，IO 失败保留 unknown。只允许当前有效的 ready 作为 Goal 来源，旧 hook 默认不声称有效。
- 全量 1003 测试 / 74 文件、typecheck/build:all/diff 通过。共享证据 32 项、runner/server/协调回归证明过期/不可读/取消、非法来源、错误验证、在途新鲜度变化与恢复，报告补证据前后 hash 不被误判。
- 首次 HTTP 冷恢复验收错误假设 code-after-ready 不会触发原恢复重检，随后修正为恢复相同输入后核验；另一个假设把旧 warm 活动槽位的提议当作冷输入，实际身份正确失效。验收明确区分 Goal 当前有效与旧轮次 current，再显式建立冷新轮次；不修改运行行为、不重复付费调用。
- 隔离真实 HTTP/子进程通过：ready/source 有效→代码变化旧轮失效且引用拒绝→指南变化失效→链接不可读为 unknown→恢复相同输入有效→冷恢复同审批无重复 worker。最终 worker 2、显式 observer 5、gate 决定/退出 0、doctor=true，临时证据 /tmp/cord-stage47-real-result.json，预览 60302/PID 27692。
- 共享解析收尾补齐同编号尝试启动先于 worker 与唯一事件 ID，34 项结构证据、最终全量 1005 测试 / 74 文件通过，typecheck/build:all/diff 通过。Playwright/Chrome 1440/390/320 当前轮次与 Goal 来源导航无溢出/pageerror，桌面与 320 截图已查看无覆盖。
- 提交前 10 份文档的 157 个本地链接与 ADR-0061 七节/54 行通过。最新预览 PID 53890 核验 current=true、worker 2、显式 observer 5、gate 决定 0，无重复调用；原真实 Draft 7306 审批 1、决定 0、done 未退出。临时运行数据/截图不提交，进入小步功能提交和有界同步。
- 最终差异审查发现预算终态把未开始的下一次尝试写为 max+1，新反例先失败；终态改为已消费编号，并补 ready 过期后自动升级的完整回归，保留不新增 worker/预算原则。继续最终验证后提交。
- 最终 1007 测试 / 74 文件与 build:all/diff 通过；预算恢复反例与自动升级完整用例通过。类型/链接和最终差异检查后提交，持续目标保持 active。
- 最后 typecheck、157 链接、ADR 七节/55 行与 diff 通过；最新预览 PID 74557 current=true、worker 2/observer 5/gate 决定 0，无额外调用。无需再次执行已通过测试，进入小步提交同步。
- 修复提交 `9511839`，HTTP/1.1 有界推送成功 ca4b93a → 9511839，ls-remote 核验远端 `95118392529dec8bfa4549bc55e24ac6aa26e710`。阶段 47 完成共享证据与当前新鲜度及预算边界修复，完整验收覆盖/跨 driver 权限与资源治理仍待继续，不标记整个目标完成。

## 2026-10-09（阶段 46）

- HEAD 9079288、工作树干净且本地 origin 同步；本轮 ls-remote 有界 20 秒超时，功能实现不受网络影响，上轮为已验证进展。
- ACP 原生可注入 PermissionDecider，但 YAML 没有范围策略；可写 worker 的普通请求也被默认取消。读取本地 SDK 证实 kind/absolute locations 可机验，选择 read/edit 显式范围与 allow_once，不解析自由标题或命令。
- ADR-0060 先行；readonly 与独立协调保留原权限行为，未知/越界/无法验证继续取消。配置身份绑定策略，清单仅显示范围数量。
- 实现 permission_policy.read/edit 归一化、严格 kind/absolute locations 与普通文件边界，allow_once/readonly 兼容、ACP config v3、公开数量与 Agent 页。回执 metadata 不污染产物，权限 error 不自动重试，后续普通错误也不重新授予重试。
- 首轮 62 项 driver 通过，追加真实 read/edit/readonly 后 87 项相关回归通过；5 项 server/真 ACP 验证成功、越界失败/修正、旧 resolver、人审策略变化、公开隐私和普通 retry 拒绝权限重试。
- 最终全量 963 测试 / 73 文件、build:all/typecheck/diff 通过。隔离真实 HTTP 首次因空正文携带 JSON content-type 被拒绝，已修正并清理旧进程；新工作区完整验证拒绝→显式策略重载→一次授权→host passed→人审未决，worker 2、决定/退出 0、冷恢复同审批不重复、doctor=true。
- Playwright/Chrome 1440/390/320 Agent 页只显示预授权读/写数量，私有标记不可见；搜索、最终审批、无溢出/pageerror 通过，桌面与 320 截图已查看。证据 /tmp/cord-stage46-real-result.json 与 browser-result，预览 59645/PID 27074；不调用付费模型、不操作真实未决 gate。
- 提交前 10 份公开文档的 154 个本地链接与 ADR-0060 七节/56 行通过，diff 检查通过。原真实 Draft 7306 实时审批 1、gate 决定 0、done 未退出；进入小步提交和有界同步，完整持续目标 active。
- 功能提交 `6d9279f`（feat: preauthorize scoped ACP file operations），HTTP/1.1 有界推送成功 9079288 → 6d9279f，ls-remote 核验远端 `6d9279f5e7f37fafff1a763af755690df8c6673d`。阶段 45 记录提交 9079288 的同步不确定性已解除；本阶段完成文件范围权限原型，跨 driver 命令/网络权限与完整资源治理仍待继续。

## 2026-10-09（阶段 45）

- HEAD 4795f6c、工作树干净且与 origin 同步，自动升级功能为已验证进展；继续实现答复后的显式 Goal 续跑。
- ADR-0059 先行：记录澄清不授权预算；单独命令绑定当前答复/输入/原 blocker，启动新 run 并记录发布预算与因果来源，保留最终 gate。
- 新增 goal.retry.authorized、started/索引 goal_retry_round_id 与因果校验；授权前使用当前输入 token 重检，派发采用固定 resolver。控制台在有效答复后展示发布预算与独立“重新执行 Goal”命令。
- 首轮测试误把 warm run 的派生 running 登记视为最终等待状态；改用需求/审批事件投影证明人审等待。索引删除反例发现旧 failed Goal 继承新 run 等待，已按自己的 blocked 事实恢复旧失败；26 项相关测试通过。
- 首次完整 930 测试 / 71 文件通过，build:all/typecheck/diff 通过。新 API、DTO、typed client、控制台预算与独立命令、授权来源/预算核验及旧失败恢复已同步文档。
- 真实 Codex worker 2 次/supervisor 1 次：隔离加法任务因外部事实未就绪阻塞，浏览器脚本模拟答复与事实更新，旧 token 409，没有派发；刷新后授权一次原预算，Codex 续跑与宿主四用例通过，最终 gate 未决。intake 退出 1、deliver/done 未退出、gate 决定 0。
- 1440/390/320 授权前预算、成功后的 run/按钮移除/最终审批无溢出/pageerror，桌面与 320 截图已查看；首次同 hash 页面未刷新导致旧 token 被正确拒绝，核验事实后继续原场景，未重启模型。冷恢复同审批、旧 failed run 保留、worker/supervisor 无重复、doctor=true。
- 证据 `/tmp/cord-stage45-real-result.json` 与 browser-result，最新预览 PID 6525/58537。所有临时数据不提交，原真实待审 Draft 不操作，完整持续目标 active。
- 提交前 git diff --check、10 份文档的 150 个本地链接、ADR-0059 七节/55 行通过；原真实 Draft 7306 实时审批 1、gate 决定 0、done 未退出。进入小步功能提交与有界推送。
- 功能提交 `a236faa`（feat: authorize goal retries after human clarification），HTTP/1.1 有界推送成功 4795f6c → a236faa，ls-remote 核验远端 `a236faa63b93c798268431d9cc6704e491f55290`。阶段 45 已完成受控续跑与实际验收；动态额度、费用/token 与统一权限仍待继续，目标不标记完成。

## 2026-10-09（阶段 44）

- 工作树干净、HEAD af7f259 同步；上一轮 Goal 状态感知已验证。本轮连接 blocked Goal 与 supervisor 自动升级，保持 Draft-only 与最终人工 gate。
- ADR-0058 先行，run.goal 增可选 supervisor_agent/timeout，生产 RunService 回调在失败事实与终态落盘后发起受限协调；请求由系统 actor 记录 Goal/run/node 来源。
- 补齐持久请求去重、在途协调等待重检与冷恢复缺请求补齐；已请求调用不重放，关闭信号中止等待避免服务关闭死锁。自动提议必须 ask_human/wait 并引用绑定 blocker，输入 hash 绑定该来源。
- 首次用例未声明 gate 被发布校验拒绝，补正确人工 gate；第二次先读到 running，改为等待已验证终态。13 项自动升级与 5 项 Goal 观察通过，继续并发协调/关闭边界验收。
- 新增 supervisor fixture 与 15 项自动升级测试，覆盖 headless/ACP、happy path、无 supervisor、坏输出、未知 agent、重复/并发/冷恢复、已有人工协调、输入变化 stale、取消、伪造来源和服务关闭。
- 真实隔离 Codex HTTP 验收：自动 Goal blocker 生成 `goal_blocked` ask_human，run failed、人工决定 0、节点退出 0、supervisor 调用 1；重启同一 round 不重复调用，doctor=true。结果 `/tmp/cord-stage44-real-result.json`，预览 `http://127.0.0.1:57145/#/requirements/REQ-AUTO-ESC/coordination`。
- 来源审查补齐：请求投影核验宿主 actor 与原 blocker，库直接重复触发也被拒绝；新增坏历史来源与 supervisor 超时回归。首次全量 917 项通过；最终继续核验新增用例。
- Playwright/Chrome 1440/390/320 问题可见、选项可用、无采用按钮、Goal 来源跳转与 pageerror=0 通过。已补按钮 aria-label；事件页检查等待真实渲染，截图从页顶拍摄；桌面/320 截图已查看无覆盖。生产真实待审 Draft 均未答复或批准。
- 最终全量 919 测试 / 70 文件、build:all/typecheck/git diff --check 通过；10 份公开文档的 147 个本地链接与 ADR-0058 七节/54 行通过。最新预览 PID 52961 核验来源有效、同一 round、supervisor 1 次、人工答复/决定 0。临时工具与截图不提交，原真实 Draft 保持未决，完整持续目标 active。
- 功能提交 `a61f775`（feat: automatically coordinate blocked goals），HTTP/1.1 有界推送成功 af7f259 → a61f775；ls-remote 核验远端 `a61f775840fb06ecbc0ebc8460793bdf3207f707` 与本地一致。阶段 44 已完成原型与验收，答复后的显式继续和预算授权仍待下一阶段，不标记整个持续目标完成。

## 2026-10-09（阶段 43）

- 阶段 42 真实 Goal 原型已验证；阶段记录与实现已合并到当前 HEAD f935896，远端已同步核验，工作树干净。
- 现有 Context Session Agent 已观察 worker task 和 verification，却不理解 goal.attempt 的预算/无进展阻塞；本轮以 ADR-0057 定义受限 goals 投影与 blocked advance 拒绝。
- 新增 `CoordinationGoal(s)Schema` 与 server execution-context 投影，严格绑定当前 run/workflow；协调 prompt/hash 纳入 goals，Goal event 可作为 evidence，blocked/invalid/cancelled 清空 eligible_nodes。Goal 观察不携带 worker 正文、命令输出或日志。
- 新增 Goal 观察定向测试：状态/预算/事件 ID 投影、最新坏事实 invalid、不回退 ready、旧 hook 兼容、Context Session Agent 的 blocked ask_human 和 advance fail-closed；95 项定向协调测试通过。
- 最终全量 `npm test` 通过：902 测试 / 69 文件；`npm run typecheck`、`npm run build:all`、`git diff --check` 通过。新增 123 个文档链接和 ADR-0057 52 行格式检查通过。
- 阶段 43 功能提交 `f935896` 已用 HTTP/1.1 推送，ls-remote 核验远端 `f93589615d061365de52469e003c07d6bb590a68` 与本地一致；原真实 Draft 7306 审批仍 1、人工决定 0、done 未退出。

## 2026-10-09（阶段 42）

- 工作树干净，exp/impl 已同步；上一轮确立默认 Goal feature 与验收契约，属于已验证进展。
- 现有验证 API 只记录结果；worker 任务成功后返回，verify 位于已退出 implement 之后。选择在未退出的 Goal 节点内完成实现、宿主验证、修复和指南审计，避免回滚 DAG 退出事实。
- ADR-0056 先行：run.goal 源码/命令/预算契约，宿主执行结果，尝试事实与恢复，新 run 重新验证，最终人审保持独立。
- 新增 9 个 Goal 反例全部失败，复现测试失败仍成功、旧代码报告复用、缺指南、无进展和无目标超时。实现 run.goal 与 goal.attempt 事实、真实 argv 命令验证、完整流 hash/有界反馈和指南审计后，9 项定向通过。
- 宿主验证测试首次因构造了超长 argv 被契约拒绝，改为子进程内部生成长输出；server 用例首次因检查数组括号漏闭合无法转换，已修正。workspace 类型需先重建库声明，随后执行完整 build/typecheck。
- 27 项相关测试、首次全量 892 测试 / 67 文件和 build:all/typecheck 通过；ACP/headless 离线真实子进程均自主修复并到最终人审，源码变化旧审批 409、冷恢复不重跑。补充存储追加故障与结果替换后，Goal 12 项通过。
- 真实 Codex CLI 0.160.0 在隔离微型仓库完成加法修复，只有 src/add.js 变更，宿主三个 Node 测试全通过，指南附实际证据，调用 1 次、中途人工决定 0、done 未退出、重启同审批且无重复调用，session doctor=true。证据 /tmp/cord-stage42-real-result.json，detached 预览端口 65382/PID 45607。
- 首次浏览器发现 review.md 不在固定四份文档页中。补齐当前 SDLC 声明产物投影、只读读取接口与文档页入口，未声明/链接/管理文件继续拒绝；继续边界测试和桌面/移动验收，不把磁盘产出当作可用 human review 流程。
- 只读产物/边界/客户端 21 项通过；浏览器 1440/390/320 指南与审批可见、只读保存禁用、无横向溢出/pageerror，桌面与 320 截图已查看无覆盖。预览重启后 PID 27476，artifact 接口已健康，未重复付费调用。
- 最终全量 895 测试 / 67 文件通过，build:all/typecheck/diff 通过，README/协议/架构/feature/路线图/ADR 索引与公开验收同步。完整监督、结构化人工卡点续跑与费用预算仍未完成；原真实 Draft 保持未决，整个持续目标 active。
- 提交前 11 份公开文档的 174 个本地链接全部存在，ADR-0056 七节/57 行符合约定。最终预览实时核验审批 1、worker 1、人工决定 0、节点退出 0；进入功能小步提交和有界同步。文档补丁有数次整行上下文不匹配，工具原子拒绝未修改文件，已按实际整行修正后检查通过。
- 功能提交 `2f0f541`，36 文件、1065 插入/83 删除；HTTP/2 推送报低于 1 bytes/sec 持续 15 秒，随后 ls-remote 同类 10 秒失败。本地提交保留，远端更新未确认，准备 HTTP/1.1 有界替代尝试。
- HTTP/1.1 有界推送成功，ls-remote 实际核验远端 `2f0f541a8b0eebcb7293529615c63efdfb6f1473` 与本地一致；工作树仍只保留本次进度文档待收尾提交，原真实 Draft 7306 审批 1、人工决定 0、done 未退出。
- 阶段记录收尾提交 `191b2a8` 已再次 HTTP/1.1 推送，ls-remote 核验远端与本地 `191b2a814a7461b020806cbb79b23ef4631a3ee5` 一致；工作树干净。

## 2026-10-09（阶段 41）

- 接续阶段 35 交接与最新阶段 40 摘要；当前分支 exp/impl、HEAD aee9139、工作树干净，领先本地 origin/exp/impl 一个提交。
- 消费中断前远端核验终态：ls-remote 因低于 1 bytes/sec 持续 10 秒失败；curl HTTP/2 可达 GitHub，不能据此认定 Git 分支同步成功。
- 用户提出默认 Goal 执行认知并授权写入核心 feature；已读 agent-optimizer 与 planning-with-files，核对定位、轻量升级、节点协调和当前实现。
- 本轮限定为设计与文档：宿主目标闭环覆盖 ACP/headless，正常路径自主完成可审 Draft，最终 review 和关键权限保留人工；未更改 runtime 或操作真实 Draft。
- 新增 docs/core-features.md 与 ADR-0055；同步 README、当前架构、文档/ADR 索引和路线图。定义目标/权限/资源边界、代码+实际自测+review 指南交付包、宿主完成审计、自动修复、人工升级、恢复与零中途干预验收。
- 保留旧 ADR 历史，补充执行默认；明确 ACP 通信与 Goal 完成职责分层、单次任务成功不等于目标达成。下一实现阶段需先定义交付/事件契约，不回滚退出事实、不引入第二个 SDLC 状态机。
- 提交前完整 npm test 通过：873 测试 / 64 文件；7 份产品/架构/索引文档共 140 个本地链接均存在，ADR-0055 符合七节与 200 行上限（67 行）。git diff --check 通过；本轮纯文档，不重复 build/typecheck 或真实模型调用。
- 文档提交 `1c5f86d`（docs: define goal-driven autonomous draft delivery）；45 秒上限的 HTTP/2 推送成功 adc4ae2 → 1c5f86d，随后 ls-remote 与本地 HEAD 同为 1c5f86dc11ed6ef35f2df24b3afe2c8fe1a9c772，工作树干净。阶段 40 aee9139 已一并同步；完整 Goal runtime 尚待实现，持续优化目标保持 active。

## 2026-10-09（阶段 40）

- 上轮为已验证并推送的进展，HEAD=adc4ae2，工作树干净且同步。
- 审查发现全部 env/外部角色文件不影响 configuration_hash，用户缺少非敏感行为变更声明。ADR-0054 与调研先行，准备可选数字 context_revision，维持隐私边界和在途配置固定；此功能不自动检测外部变化。
- 11 个 driver/YAML 反例全部失败。实现可选正安全整数、各协议有声明时 v2/无声明 v1 身份、三种配置形态透传及公开数字清单/控制台行内展示，继续定向与恢复验证。
- 41 项 driver/YAML 定向与 build:all 通过；新增固定非敏感测试环境的真实子进程 fixture，覆盖旧 resolver 保持旧角色、重载后新角色/版本、冷恢复拒绝旧审批并重跑，以及协调提议失效/新轮次恢复，继续全量验证。
- 32 项 driver/server 定向通过；workspace typecheck 指出 AgentCatalogView 显式 DTO 未新增字段，已补齐可缺省数字版本，继续完整编译与类型验证。
- 最终 873 测试 / 64 文件、build:all/typecheck/git diff --check 通过。隔离真实 HTTP 同 argv + 环境角色 A→B/context_revision 1→2 使身份改变、旧报告重跑，worker 2 次；重启不重复调用、审批 ID 保持、PRD 不变、人工决定/节点退出 0、doctor=true。
- Playwright/Chrome 1440/390/320 清单显示上下文 v2，公开响应/页面无私有环境标记，无溢出/pageerror；截图已查看无重叠。仅临时 fixture，不调用付费模型；协议/README/架构/ADR 索引与公开验收同步。
- 最新 detached 预览 `http://127.0.0.1:7317/#/agents`（PID 8433）健康，worker 声明上下文 v2；最终差异审查/git diff --check 通过。7317 与原真实 Draft 7306 审批各 1、人工决定各 0、done 未退出；进入小步提交和有界同步，持续目标保持 active。
- 阶段 41 收尾核验：功能提交 aee9139 已随 1c5f86d 成功推送，远端 hash 已实际核验，旧同步未决已解决。

## 2026-10-09（阶段 39）

- 上轮为已验证进展，HEAD=f9119d1，工作树干净、本地领先已知 origin 2 次提交；远端网络失败不阻断本地优化。
- 当前答复不可修正，开始人工明确撤回与未确定状态。ADR-0053 先行：追加事实保留历史，不回退更早选择或恢复旧无澄清身份；旧轮次不重答，新轮次重新澄清，gate 仍独立。
- 7 项核心/REST 反例先失败，确认撤回被忽略、路由缺失。开始严格撤回引用与 choice=null/status=revoked 投影，保持历史答复和当前同题状态分离，模型/worker 明确不可沿用撤回选择。
- 首轮 7 项定向与 build:all 通过。接入预期答复 ID、当前同题有效性、共享操作槽位和 Undo2 UI；扩展模型撤回来源、worker checkpoint、未来/自引用、并发与输入过期仍可撤回，以及 typed client 回归。
- 最终全量 858 测试 / 64 文件、build:all/typecheck/git diff --check 通过；原状态、未确定来源、worker 失效、旧轮次不重答和新轮次修正均验证。
- 隔离 HTTP/Playwright 失败保留原答复、重试禁用、单次撤回、重放/旧轮次 409、重启/来源导航通过；当前快照不含旧选择，gate/退出/人工决定事实集合未增，worker 0、人工待审 1、PRD 不变、doctor=true。
- 真实 Claude 一次无工具调用读撤回状态，旧选择不在 prompt，明确未确定并引用撤回事件。1440/390/320 无溢出/pageerror，截图已查看无重叠；仅临时运行证据，协议/README/架构/ADR 索引与公开验收同步。
- 最新 detached 预览 `http://127.0.0.1:7316/#/requirements/REQ-REVOKE-ANSWER/coordination`（PID 78021）健康，真实 wait current=true，历史答复保留 revoked_at；进入最终差异审查与小步提交，持续目标保持 active。
- 最终差异审查/git diff --check 通过；7316 与原真实 Draft 7306 实时健康、审批各 1、人工决定各 0、done 未退出。新增核心契约已有先行 ADR-0053；实现与验收进入独立提交和 HTTP/2 有界同步，持续目标保持 active。
- 功能提交 `7d70b27`，HTTP/2 推送成功（origin/exp/impl：5e5d874→7d70b27）；ls-remote 实际 hash=7d70b27bb42ba3715fbd56962e43475e176227b9，与本地一致。阶段 38 两个积压提交一并同步，无全局 Git 设置修改，持续目标保持 active。

## 2026-10-09（阶段 38）

- 上轮为已验证并推送的进展，当前 HEAD=5e5d874，工作树干净且与 origin 同步。
- 确认 ask_human 只有问题/选项展示，没有 REST 答复或下一轮/worker 材料。读取 LangGraph interrupts 并先创建 ADR-0052；使用 frontend-design 沿用现有操作型控制台，不把澄清选项映射成 gate 决策。
- 准备事件引用、当前输入/版本、并发幂等、失败恢复与 UI 全链路反例；原真实 Draft 不批准/取消/采用，持续目标保持 active。
- 14 个核心/REST 反例全部复现：路由 404，快照无澄清，相关身份不变，坏答复不被拒绝。开始原完成/人工/选项严格投影、同题最新材料与有答复才升级的协调/worker/审批身份。
- 实现后首轮 14 项定向通过；build/typecheck 报新读侧对 unknown payload 直接索引，已改为对象校验与安全解析，并加强当前问题语义核验。接入 typed answer 客户端与 UI 单选、记录中/失败/过期/已答复及事件来源；继续编译和边界回归。
- 扩展 73 项定向与 build:all 通过：坏来源、相同问题更新、在途答复使模型 stale、冷恢复坏需求隔离、并发选择与写失败恢复。补充容量拒绝/不丢材料、typed 客户端和加载期间禁用控件，进入全量与真实 HTTP/UI 验收。
- 收尾审查补齐原问题 correlation/流程身份/矛盾失败信息的预写校验，并投影为不可答复；避免接收后才发现人工事实引用非法。增加损坏原问题不写答复回归，继续最终检查。
- 首轮全量 840 项通过，预写来源校验后 79 项定向与编译通过；扩展至 845 后仅新增门禁测试失败：将默认 run 原本已退出的上游节点计入答复影响。改为对比答复前后 gate/退出/人工决定事件，未改生产行为；继续最终全量与隔离实际验收。
- 修正后 845 全量与类型检查通过，实际 HTTP/Playwright 完成失败保留选择、保存禁用、一次答复重放、改选/过期拒绝、长问题/选项和来源导航；真实 Claude 一次无工具调用引用新澄清，人工等待保留、worker/人工决定为 0。
- 最终审查新增确定性替代完成反例失败：返回 409 但已记录无法验证的答复。补齐追加前的问题 kind/文本/选项与最新完成核验，再执行全量；不重复付费模型调用。
- 最终 846 测试 / 64 文件、build:all/typecheck/git diff --check 通过，替代完成在写前拒绝且不留答复事实。最新 detached 预览 `http://127.0.0.1:7315/#/requirements/REQ-ANSWER-LOOP/coordination`（PID 60540）已健康，真实 Claude wait current=true，旧问题保留选择且不可重复改选。
- 1440/390/320 的失败/保存禁用/一次答复/重启/长问题与选项/过期/来源导航已验收；截图查看无重叠。模拟答复没有新增 gate/节点退出/人工决定，原需求 PRD 不变、worker 0、人工待审 1、doctor=true。运行证据仅在临时目录，协议/架构/README/ADR 索引及公开记录同步。
- 最终差异审查与 git diff --check 通过；7315 最新预览与 7306 原真实 Draft 实时健康、审批各 1、人工决定各 0、done 未退出。核心契约修改已有先行 ADR-0052；进入独立提交与 HTTP/2 有界推送，持续目标保持 active。
- 功能提交 `c0e6f01`（28 文件），HTTP/2 推送退出码 128：低于 1 bytes/sec 持续 15 秒；ls-remote 在 20 秒上限后终止并报 10 秒低速，独立 GitHub 443 连接测试 5 秒超时。保留本地提交，实际远端状态未确认；记录待同步并作仅当前命令的 IPv4 有界重试，不改全局 Git 配置。
- 后续阶段 39 HTTP/2 推送 `7d70b27` 成功，已一并同步本阶段功能与进度提交，远端实际 hash 经 ls-remote 核验。

## 2026-10-08（阶段 37）

- 上轮为已验证并推送的进展，当前 HEAD=7866fd4、工作树干净且同步。
- 审查 worker 实际输入发现默认快照仍前缀采集，hash 随长需求尾部更新但模型不可见；maxPackChars 未硬约束 PRD/账本/任务信息，源码与重试附记在预算后追加。复用阶段 32 已核验的上下文工程资料，ADR-0051 与调研先行，准备反例。
- 10 项新增反例全部复现，6000 预算得到 10726/20835 字符，非法预算仍派发且旧域身份未变。开始原生首尾采集、共享片段预算、源码/重试附记预留、预算错误不重试与 worker v4 输入策略。
- 首轮 80 项定向与 build:all 通过，原生首尾、预算失败不派发/不节点内重试、源码重试附记完整与非法预算修复恢复均验证。补充旧完整 checkpoint 重跑/恢复与公开预算错误类型，继续整体检查与真实 worker 验收。
- 最终全量 818 测试 / 63 文件、build:all/typecheck/git diff --check 通过。隔离真实 HTTP 首次 70000 字符任务被拒绝，模型调用 0、failed/snapshot 且不节点内重试；修复与文档更新 B 后真实 Claude reviewer 仅调用 1 次，prompt=59970、工具 0，三份长 PRD/计划/ADR 的最新尾部标记进入报告，各索引范围与原文匹配。
- 实际 server 重启不重放 worker、审批 ID 不变，输入/报告不变，人工决定 0、review 未退出、doctor=true。最新 detached 预览 `http://127.0.0.1:7314/#/requirements/REQ-WORKER-COVERAGE/docs`（PID 25240），findings.md 保留真实报告；运行数据只在临时目录。
- Playwright/Chrome 1440/390/320 展示最新三尾部标记、无编辑时保存禁用、人工 gate 可见，无溢出/pageerror；桌面/手机截图已查看无重叠。README/协议/架构/ADR 索引与公开验收记录同步，准备最终差异审查与小步提交。
- 2026-10-09 收尾：最终差异审查与 git diff --check 通过；7314 最新预览与 7306 原真实 Draft 实时健康、审批各 1、人工决定各 0、done 未退出。实现、测试与文档进入独立提交和 HTTP/2 有界同步，持续目标保持 active。
- 功能提交 `564ca3d`，HTTP/2 推送成功（origin/exp/impl：7866fd4→564ca3d）；远端 ls-remote hash=564ca3d65195a06fa0662aeeaab45b17e5a9be88，与本地相同。持续优化目标保持 active，未改全局 Git 配置。

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
- 功能提交 `787b387`，HTTP/2 有界推送成功（origin/exp/impl：cd9e75a→787b387）；ls-remote 实际 hash=787b387cb50df1fdf630a408f3fa7fd83eb342bb，与本地 HEAD 相同。阶段 35 的 `a802351`/`2317f8e` 一并同步，未改全局 Git 配置；持续目标保持 active。

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
- 后续阶段 36 推送 `787b387` 成功，已一并同步本阶段功能与记录提交，远端实际 hash 已由 ls-remote 核验。

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
# 阶段 58 收尾（2026-10-10）

- Goal change_summary 只从完整 ready 核验派生，最多 16 条路径样本，完整计数与证据身份进入协调输入。
- 新增大清单/样本外变化/错误计数和 ACP/headless 子进程、过期/不可读/取消与冷恢复断言。全量首先复现旧调用省略 goals 的兼容错误，修复 optional chaining 后 1158 项 / 80 文件通过；typecheck/build:all/diff 通过。
- 当前转入用户新提出的 agent 原子能力与启动控制；保留原默认 Goal 与人工终审边界。
# 阶段 59 验证（2026-10-10）

- ADR-0073 先于 ports 修改。新增严格 launch/capabilities、Claude bare/auto/角色/预算、ACP 精确 ID 选择与最终回执、boolean 协商、custom model/effort/resume 参数映射；显式不支持配置 fail-closed。
- server 能力清单/无 prompt inspect、typed client 和原授权恢复 node_id 约束完成。能力查询拒绝权限和工具，不使用 worker 预授权；静态声明与 session 协商结果明确分开。
- 定向 21 项 launch、实际 fixture 子进程、TCP HTTP 查询与幂等、固定节点/预算/人工 gate 通过。全量首先复现旧忽略旋钮/隐式 resume/清单精确结构断言，按新契约修正；最终 npm test 1181 项 / 81 文件通过，typecheck/build:all/diff、100 项本地文档链接通过。
- 核心 feature、README、架构、协议、示例、研究与 human review 指南同步。未调用付费模型，未操作 7306 上的真实 Draft。
- 隔离预览 PID 81269，http://127.0.0.1:56982；/api/v1/health、/agents、/agents/capability-demo/inspect 均 200，模型/effort 候选来自 fixture 协商，同键重放一致。定位 /tmp/cord-stage59-preview-result.json；终态测试 JSON 为 /tmp/cord-stage59-final-tests.json。
- 功能将小步提交，随后有界推送与远端独立核验；完整持续优化目标保持 active。
