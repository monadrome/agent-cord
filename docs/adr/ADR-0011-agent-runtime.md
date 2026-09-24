# ADR-0011 ｜ agent 运行时：每任务 subprocess 驱动 headless CLI

- 状态：accepted（设计定稿，代码未实现）
- 日期：2026-09-24
- 关联：ADR-0006（盲评隔离）、ADR-0009（语言与运行形态）、ADR-0013（投票执行器走 API 而非 CLI）、ADR-0016（agent schema 与权限声明）
- 来源：本方案技术选型调研（2026-09，内部调研纪要）——agent 运行时与现有 AI CLI 驱动方式

## 背景

已定型的设计把问题域收窄得很清楚：

- **不自研 agent 内核**：各角色 agent 通过驱动现成 coding CLI 执行任务（claude code / codex / kimi / gemini / aider 等）。
- **盲评隔离是硬约束**：k=2~3 个异构模型 agent 独立盲评，禁止互见中间推理——运行时必须能提供进程级 + 文件系统级 + 会话级的三重隔离。
- **非对称模型分配 + 异构供应商**：同一平台要同时驱动多家 CLI，驱动层必须是「CLI 无关的通用执行原语」，不能对某家 SDK 形成深度绑定。
- **token 成本是噪声级、人工介入时间是真成本**：运行时选型不应为省进程开销而牺牲隔离性——省下的毫秒换不来一次正确的盲评。
- **协调 agent（coordinator）不持有长会话**：每次路由都是「取快照 → 派任务」，与常驻会话池的「连续性」假设天然不契合。
- **任务形态两分**：门禁/投票大量是短任务（评审、锚点校验、生成选项集），执行类任务长且可能需要 resume。

收窄后真正要决策的是：**每任务一个 subprocess（无状态、用完即弃）** vs **常驻 agent 池（长驻进程复用会话）**，以及驱动协议用裸 CLI 还是官方 SDK。

### 业界现状（2025–2026 调研结论）

- **headless / 程序化调用已是标配**：主流 CLI 都提供稳定的非交互入口与结构化输出（例如 `claude -p --output-format stream-json` 的行分隔 JSON 事件流，含工具调用、用量、成本、session id；`codex exec --json` 的 NDJSON + 退出码；Gemini CLI / OpenCode / Kimi CLI 等的 print 模式 + JSON 输出）。业界横评的结论是「每个 CLI 都有那个非交互表面：你传 prompt、agent 跑完 loop、打印结果、退出」。
- **会话恢复/分叉已可脚本化**：`--resume <id> --fork-session` 类能力在 headless 下可用；session id 可从首次运行的结构化输出中取出。
- **权限/工具白名单已细到可作安全边界**：工具集限定、命令模式级允许列表、权限模式、`--max-turns`、`--max-budget-usd`（硬预算熔断）、跳过项目级配置自动发现（行为确定化）、独立 settings 注入、禁用会话持久化等参数均已存在；部分 CLI 还提供把审批请求转发给外部工具的钩子（编排程序可以用代码回答「能不能执行这个命令」）。
- **用现成 CLI 做多 agent 编排已被多个开源项目验证可行**：以独立 git worktree + 终端复用器管理多个 CLI 实例、通过 MCP 并行分发任务、官方文档直接编排多实例等。
- **反面信号**：多 agent 并行会撞供应商速率限制，即使在最高付费档也是真实痛点——**并发控制必须建在驱动层之上，不能假设供应商帮你扛**。
- **一个关键架构事实**：某家的 Agent SDK 本身就是在 CLI 二进制外面包了一层（内部仍 spawn CLI 子进程）；已有工程团队明确用「持久 subprocess 直讲 stream-json、不用 SDK」实现产品级集成。即「用 SDK」并不等于「摆脱 subprocess」，只等于「换一套控制协议」。

## 备选方案

### 备选 A：每任务 subprocess（开新进程跑 headless CLI，用完即弃）

- **是什么**：平台执行器是一个通用的 `spawn(cli, args, cwd, env)` 原语。每个任务（一次评审票、一次实现、一次锚点校验）= 一个新进程：独立 cwd（临时 worktree 或临时目录）、独立 env（各自凭证、隔离的 settings）、读结构化事件流 → 结果写回 SSOT → 进程退出。需要延续时显式 resume。
- **优点**：
  - **隔离免费且彻底**：盲评的每个投票 agent 天然是独立进程 + 独立文件系统视图 + 独立会话上下文，「禁止互见中间推理」由 OS 进程边界保证，不依赖自觉；
  - **失败域小**：一个 CLI 崩溃/卡死/被限流只死一个任务，调度器重试或换模型即可；无状态设计没有「池子被污染」的系统性风险；
  - **供应商无关**：所有 CLI 都暴露近同构的非交互接口，驱动层可用同一套 schema 抽象多家；
  - **权限收紧简单**：每任务按需拼装工具白名单、权限模式、turn/budget 上限；评审票甚至可以只给只读工具，与权限分级精确对齐；
  - **成本可控**：turn/budget 熔断内建；进程启动开销相对任务时长与 token 成本可忽略。
- **缺点**：进程冷启动每次重新加载 CLI 与配置（可用「跳过配置自动发现」缓解）；resume 依赖各家 session 文件格式与路径约定，跨家抽象要自己抹平；高频短任务下进程开销占比上升（但仍小）。
- **契合度**：极高。盲评隔离、供应商无关、门禁零代码（gate 配置 → 拼 CLI 参数）、快照协调（无长会话假设）全部命中。

### 备选 B：常驻 agent 池（长驻进程复用会话）

- **是什么**：预先拉起 N 个长驻 CLI 进程（终端复用器会话或 PTY 保活），任务到来时把 prompt 灌进空闲进程，复用其会话上下文与已加载的工具配置。
- **优点**：省冷启动；会话上下文跨任务延续（对长周期探索 agent 有真实价值）；人能 attach 进去看现场。
- **缺点**：
  - **隔离要额外花钱且不可靠**：复用进程 = 共享上下文历史；盲评 agent 若从池里取，必须强制「每个投票任务开全新会话」，那与会话复用的初衷直接矛盾；做到彻底隔离等于退回「每任务新会话」，池子退化成纯进程保活；
  - **状态污染与泄漏**：长驻进程挂掉、上下文膨胀、某任务留下的偏好污染后续任务，都是多 agent 失败模式在运行时的变体；
  - **运维复杂度**：池健康检查、回收、配额管理、崩溃恢复全要自研——这正是「固定建设成本」的大头。
- **契合度**：低。coordinator 不持有长会话，短评审任务占大头；常驻池解决的是本项目没有的痛点，还破坏盲评隔离。

### 备选 C：SDK 内嵌 / 直接用模型 API 自研 agent loop

- **是什么**：不用 CLI 进程，平台直接用各家 Agent SDK 或直接调模型 API 自研工具循环。
- **优点**：进程内控制最细（逐事件、逐工具调用可编程干预）；延迟最低；不受 CLI 版本变动影响。
- **缺点**：违背已定型的核心设计（不自研 agent 内核）——自研 loop 等于重新发明各家 CLI 已在做的工具编排、上下文压缩、权限系统，维护面爆炸；SDK 是各家私有接口，「同时驱动多家异构 CLI」在 SDK 层要维护 N 套适配，与供应商无关目标冲突；幻觉防护被削弱（CLI 的系统提示词、工具描述、权限模式是各厂商持续调优的安全资产，自研 loop 拿不到这些沉淀）；且「SDK 免 subprocess」是伪命题（内部仍 spawn CLI）。
- **契合度**：否决项级的不契合。

### 备选 D（作为 A 的增强而非独立备选）：流式持久 subprocess

- **是什么**：一个任务一个进程，但进程不跑完就退出，而是保持 stdin/stdout 长连接，平台持续喂消息、读事件（`--input-format stream-json` 类接口）。
- **优点**：保留了 A 的进程级隔离（一个投票任务一个进程），又拿到 B 的免冷启动。
- **对本项目的建议**：作为 A 的**二阶段优化**保留——第一版统一用「每任务一次性 subprocess」（最简单、最易审计）；若实测启动开销或 resume 摩擦成为瓶颈，再对**执行类长任务**升级到持久流式进程；**投票类短任务始终走一次性进程**。

## 决策

**采用备选 A「每任务 subprocess」作为基座运行时；备选 D 作为后续针对长任务的性能升级路径；驱动协议采用裸 CLI headless 接口 + 统一事件抽象（`AgentDriver` 接口），不依赖任何一家的 SDK。**

配套决定：

1. **统一驱动抽象层**：定义 `AgentDriver`（`run(task) → 事件流 | 结果` 与 `resume(session_id, fork?)`），对各家 CLI 各写一个适配器；只依赖各家稳定子集（print 模式、结构化输出、resume、工具/权限参数、turn/budget 上限），适配器内不使用 SDK 专有特性。
2. **盲评隔离的落地形态**：每票 = 独立临时 worktree 或临时目录 + 一次性进程 + 独立 env（各自凭证、独立 settings、跳过项目级配置注入）；投票 agent 的中间推理不落任何共享存储；transcript 按 agent 分目录落到该需求的 `votes/` 下、随 `VoteRecord` 引用。
3. **超时与预算三层防线**：CLI 内建熔断（turn / budget 上限）→ 平台调度器 wall-clock 超时（读事件流心跳，无事件 N 分钟即杀）→ 全局配额（每需求 token 预算）。
4. **并发控制在驱动层**：按供应商的令牌桶 + 队列调度；异构投票恰好可以错峰调度（不同 CLI 天然分担配额）；并发 worktree 实践上限保守取 8–10 个。

## 理由（第一性原理推导）

1. **从痛点出发**：本项目的首要风险不是性能，而是**共识可信度**（盲评独立性、防幻觉、防相关错误）。运行时的第一职责是让独立性保证可机验、可审计——进程边界是最便宜也最硬的隔离原语。
2. **从约束出发**：供应商无关（多家异构 CLI）→ 只能选各家共有的最小公分母接口，即 headless 模式 + 结构化输出 + resume；SDK 是各家私有接口，选了它就选了绑定。门禁零代码 → gate 配置必须能纯声明式地翻译成 CLI 参数（工具白名单 / 权限模式 / turn 与 budget 上限的拼装，恰好就是「角色 × 校验 × 放行条件」的运行时投影）。
3. **从成本结构出发**：token 是噪声级成本，人的介入时间是真成本。因此运行时应优先优化**可观测性、失败可重试、结果可机验**（结构化事件流天然提供），而不是优化进程开销。省两秒启动换不来一次错误的「2/2 一致」假确认。
4. **从失败模式出发**：无状态、单任务单进程把「状态污染、错位、不终止」三类失败在运行时层直接归零；长驻池把这三类风险请回了家。
5. **从「可审计」出发**：结构化事件流全量落盘，本身就是回放实验（一致但错率统计）与锚点重合检查的原始数据源；session id 与 transcript 路径写入投票记录，使「谁、用什么 CLI 版本、基于什么上下文」可回溯。任何削弱这一点的形态（池化复用会话）都会被否决。

## 被否方案的否决理由（逐一）

- **备选 B（常驻 agent 池）**：否决于与盲评隔离硬冲突（复用会话 = 共享上下文）；解决的是本项目没有的冷启动痛点；引入池污染与健康运维等失败面；coordinator 的快照路由模型不需要会话延续。其「进程保活 / attach 可视化」思想降级为 A 的调试辅助手段。
- **备选 C（SDK 内嵌 / 自研 loop）**：彻底否决。直接违反「不自研 agent 内核」的定型设计；供应商绑定；且「SDK 免 subprocess」不成立（Agent SDK 内部仍 spawn CLI）。
- **备选 C 的极端形态（纯裸模型 API 自研）**：否决。连 CLI 的权限系统、工具编排、系统提示词沉淀都放弃，幻觉防线自降一级，同时工作量最大。
- **「用常驻池但每任务开新会话」**：否决于既没有隔离收益（等同一次性进程）又保留了池的运维成本与故障面。
- **「以 CLI 作为投票执行器（复用同一驱动层）」**：本条属于 ADR-0013 的决策范围，但在此注明其运行时后果——投票执行器不走本 ADR 的 CLI 驱动路径（CLI 无法锁定采样参数与模型版本，净输入不可审计）。CLI 驱动层保留给生成侧角色 agent。
- **「不设 wall-clock 超时，只依赖 CLI 内建熔断」**：否决于各 CLI 的熔断覆盖面不一致，且卡死（无事件但进程活着）不会被预算熔断捕获。

## 关键实现注意点

1. **版本兼容是最大坑**：CLI 的 headless 参数在快速演进，部分能力是较新版本才出现且官方明确标注版本要求。必须钉版本（lockfile 记录 CLI 版本）、CI 里做冒烟测试（每个适配器跑一个最小 turn 的探针任务）、适配器对「flag 不存在」要优雅降级而非崩溃。
2. **盲评隔离的具体落地**：每票 = 独立临时 worktree（`git worktree add --detach <commit>` 或临时目录）+ 一次性进程 + 独立 env；用「跳过项目级配置自动发现」或独立 settings 切断项目级注入，防项目配置污染投票。三家 agent 的 prompt 只在最后提交结构化结论（选项 + 证据锚点 + 理由），中间推理不落任何共享存储；**禁止 coordinator 把 A 票的 transcript 喂给 B 票**（协议强制项）。
3. **工具白名单按角色裁剪**：评审票只给只读工具（读文件、`git diff` / `git log`），实现票才给写类工具。配合「权限请求不走交互式提示」保证无人值守不挂起；需要人审的权限请求转成平台事件（与「给选择题不给论述题」一致）。
4. **临时工作区必须视为不可信输入**：已有公开漏洞表明 CLI 自动加载项目内配置文件可能导致远程代码执行。因此跑投票/执行的临时工作区要用沙箱档位（系统级沙箱、受限文件根）+ 凭证最小化（禁用生产凭证、短时效 token、setup 期注入）。
5. **进程被杀不等于任务失败**：要求 agent 周期性把中间产物写工作区文件，重试可续；结果落盘策略与「至少一次投递」的幂等语义配合（ADR-0012）。
6. **prompt cache 复用**：多 agent 共享的上下文包（系统提示 + 需求快照）放在 prompt 前缀并尽量静态；必要时用 CLI 提供的「排除动态系统提示片段」类手段保持前缀稳定——缓存命中可显著降本，是驱动层白拿的优化。
7. **审计与回放**：事件流（`events.jsonl`）全量落盘进需求文件夹，投票与回放实验的产物落 `votes/` 子目录（`findings.md` 是快照文档、不是目录），作为回放实验与锚点重合检查的原始数据源；`session_id` 与 transcript 路径写入 `VoteRecord`，transcript 本身随 `VoteRecord` 的引用落在 `votes/` 下。
8. **coordinator 的运行时形态**：coordinator 本身是无长会话的短任务驱动者（取快照 → 派任务 → 收结果 → 写事件），因此它天然走 A 形态；不要把 coordinator 做成常驻会话 agent，否则「只看最新快照」的防幻觉设计会被长会话的历史累积侵蚀。
9. **与 ADR-0013 的分工必须写进入接文档**：生成侧角色 agent 走本 ADR 的 CLI 驱动；判定/投票走 ADR-0013 的 ProviderAdapter 直连 API。两个执行器并存是设计，不是不一致。

## 证据来源

1. 本方案技术选型调研（2026-09，内部调研纪要）：业界现状、备选 A–D 对比、推荐推导链、被否理由、8 条实现注意点。
2. 各 CLI 的 headless / 权限 / 预算 / resume 能力（一手 CLI 参考）：Claude Code CLI 参考 https://code.claude.com/docs/en/cli-reference ；官方多实例编排文档 https://code.claude.com/docs/en/agent-teams ；Codex CLI 文档 https://developers.openai.com/codex/cli/ ；Codex headless 实操（NDJSON 事件流）https://towardsdatascience.com/running-codex-as-a-headless-agent/ ；Aider 脚本化模式 https://aider.chat/docs/scripting.html
3. 跨 CLI headless 能力横评（各 CLI 命令对照）：https://www.agentscli.com/foundations/headless/ ；无头 CI 对比（Claude / Codex / Gemini / opencode）https://www.developersdigest.tech/blog/headless-ai-coding-agents-ci-comparison-2026
4. 多 CLI 编排的可行性与形态先例（终端复用器 + 独立 worktree；MCP 并行分发）：https://github.com/smtg-ai/claude-squad ；https://github.com/jfikrat/squad ；worktree 并行实践与并发上限 https://zylos.ai/research/2026-02-22-git-worktree-parallel-ai-development/
5. 「Agent SDK 内部仍 spawn CLI 子进程」与「持久 subprocess 直讲 stream-json 替代 SDK」的证据：https://www.augmentcode.com/guides/anthropic-agent-sdk-what-ships-vs-what-you-build ；https://github.com/donovan-yohan/relay-ide/issues/1168
6. 并行 agent 撞供应商速率限制（并发控制必须建在驱动层的直接证据）：https://github.com/anthropics/claude-code/issues/62426
7. 临时工作区内自动加载项目配置导致 RCE 的公开漏洞（临时工作区须视为不可信输入）：CVE-2025-61260 https://www.sentinelone.com/vulnerability-database/cve-2025-61260/
8. 非交互模式的安全加固实践（默认拒绝工具、显式 opt-in 才自动批准）：https://github.com/duanyytop/agents-radar/issues/1328
9. 多 agent 失败模式（状态污染、错位、不终止是长驻复用的风险来源）：MAST https://arxiv.org/abs/2503.13657
10. 项目内部：方案提案 §6.6（对抗执行与集成测试自动化）、§7.A（agent 定义最小 schema）；工作清单 W1.1（Agent 定义框架：注册式、新增 agent 零代码）；配套调研（2026-09）Q1、Q9（agent 权限分级表与凭证策略）。
