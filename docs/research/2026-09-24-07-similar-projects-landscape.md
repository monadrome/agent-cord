---
title: 类似需求的整体开源实现与竞品
date: 2026-09-24
type: research-archive
status: 调研结论均为 2026-09-24 当日实测，时效性敏感（star 数、版本、license 可能变化）
---

我已完成调研。以下是完整报告。

---

# agent-cord 可复用开源实现调研报告

**调研时间**：2026-09-24 ｜ **方法**：GitHub REST API 实测（star/license/最后推送）、npm registry 实测、官方网站与技术文章交叉验证；并对两条核心设计假设做了本地实测（见第 6 节）。

**一句话结论**：agent-cord 的**外层组件几乎全部有成熟现成实现**（IM 适配、agent 驱动协议、CEL 校验、结构化输出、FTS5 检索、git 事件流），但**「带证据锚点的共识账本 + 门禁放行」这个内核没有任何项目实现过**——连它想解决的问题（spec 与实现脱节、agent 无视规格）都被独立研究明确标记为全行业空白。

---

## 1. 规格驱动开发（SDD）阵营 —— 对标 `cord/<req-id>/` 文档与状态机

这一阵营与 agent-cord 的 SSOT 目录形态最接近，但**都只做文档工作流，没有账本、没有投票、没有放行门禁**。

### OpenSpec（Fission-AI/OpenSpec）—— 目录形态最接近，值得深度对照
- 仓库：https://github.com/Fission-AI/OpenSpec ｜ TypeScript ｜ MIT
- 活跃度：★70,182 ｜ fork 4,801 ｜ 最后推送 2026-09-23 ｜ v1.11.0（活跃）
- 提供什么：每个变更一个目录 `openspec/changes/<change-id>/`，内含 `proposal.md`（WHY/WHAT）、`specs/`（需求 + WHEN/THEN 场景）、`design.md`（技术方案）、`tasks.md`（实施清单），完成后归档到 `changes/archive/<date>-<id>/`。规格用 **SHALL + WHEN/THEN** 场景格式，并支持 **delta 格式（ADDED / MODIFIED / REMOVED）**——这是针对「改需求」而非「新建需求」设计的。
- 匹配度：**适配后复用（借鉴目录与 delta 语义，不直接依赖）**
- 结论：`openspec/changes/<id>/` ≈ `cord/<req-id>/`，OpenSpec 已经把「一个需求一个文件夹 + 快照文档 + 归档」这套形态跑通并且是 TS 实现，agent-cord 应该直接对齐它的目录约定和 delta 词汇，避免自创一套没人认识的格式。但 OpenSpec **完全没有 `ledger.yaml` 等价物**——它的状态隐含在「文件存在与否 + 归档位置」里，这是 agent-cord 要补的第一块。

### GitHub Spec Kit（github/spec-kit）
- 仓库：https://github.com/github/spec-kit ｜ Python ｜ MIT
- 活跃度：★138,721 ｜ fork 12,428 ｜ 最后推送 2026-09-24 ｜ v1.0.1（2026-08-21 发 1.0）
- 提供什么：三入口（SDD / Bug fixing / Idea assessment），`specify init` 生成项目骨架，流程以 agent skill 形式挂在编码 agent 里（`/speckit.*`），带 constitution（项目宪法）与多 agent 集成（Copilot/Claude/Codex/…）。
- 匹配度：**只能借鉴思路**。它是 Python + 模板分发，不是库；且它对「小改动」需要 `/speckit.clarify` 绕路，迭代场景弱于 OpenSpec。
- 价值：它是这个品类的**事实标准与命名权威**，agent-cord 的文档命名/流程词汇应对齐它的术语（specify / plan / tasks / clarify / analyze），以降低用户认知成本。

### BMAD-METHOD（bmad-code-org/BMAD-METHOD）
- 仓库：https://github.com/bmad-code-org/BMAD-METHOD ｜ Python ｜ **MIT**（GitHub API 误标为 NOASSERTION，已核验 LICENSE 原文为 MIT）
- 活跃度：★53,418 ｜ 最后推送 2026-09-24 ｜ v6.11.0
- 提供什么：21 个专职 agent 的「企业级敏捷 AI 开发方法」，PM/架构师/开发/QA 角色分工 + 文档模板链。
- 匹配度：**只能借鉴思路**。它的「角色 × 阶段」矩阵和 agent-cord 的「gate = 角色×时机」概念同构，其 21 个角色的职责边界表可以直接抄来做 gate 角色设计参考。但它没有可编程的 gate 执行器。

### Conductor（gemini-cli-extensions/conductor）—— 注意与 conductor.build 区分
- 仓库：https://github.com/gemini-cli-extensions/conductor ｜ Python ｜ Apache-2.0
- 活跃度：★3,745 ｜ fork 295 ｜ 最后推送 2026-09-01 ｜ 创建于 2025-12-17
- 提供什么：给编码 agent（Antigravity / Claude Code）用的 SDD 插件：specify → plan → implement。
- 匹配度：**只能借鉴思路**。
- ⚠️ **重名警告**：另有一个 **conductor.build（Melty Labs，YC S24）**，是闭源 macOS 应用，跑 worktree 隔离的并行 Claude Code / Codex / Cursor agent，无远程能力、仅 macOS。两者完全无关，agent-cord 若提「Conductor」必须消歧。

### Superpowers（obra/superpowers）
- 仓库：https://github.com/obra/superpowers ｜ MIT
- 活跃度：★291,081（star 数异常高，已二次核验 API 返回一致）｜ 最后推送 2026-09-22 ｜ v6.3.0
- 提供什么：agent skill 框架 + 方法论：brainstorm → plan → subagent TDD，**每一步有 gate**，并自动化 git worktree。
- 匹配度：**只能借鉴思路**，但这是**最值得读的「gate 如何落到 skill 里」的参考实现**——它用 skill 前置条件而非运行时校验器来实现门禁，正好是 agent-cord 想用「YAML gate + 三级校验器」去形式化的东西。
- 对比参考：独立研究（spec-compare）指出它与 mattpocock/skills 的差别就是「**Superpowers gates each step；Pocock's skills leave the sequence to the user**」——即「有没有 gate」被认为是产品分野，支持 agent-cord 的核心假设。

### MoAI-ADK（modu-ai/moai-adk）—— gate 概念最接近的实现
- 仓库：https://github.com/modu-ai/moai-adk ｜ Go ｜ Apache-2.0
- 活跃度：★1,220 ｜ fork 226 ｜ 最后推送 2026-09-24
- 提供什么：包裹 Claude Code 的 SPEC-First `plan → run → sync` 生命周期，含 **TRUST 5 quality gates**、模型/effort 路由、Claude×GLM 多模型成本控制。
- 匹配度：**只能借鉴思路**。这是「质量门禁 + 多模型路由」最接近的现成实现，但它是 Go CLI + Claude Code 专用，不是可嵌入库。建议精读它的 gate 定义方式来校验 agent-cord 的 YAML 门禁 schema 设计。

### 其他同类（边缘，仅登记）
| 项目 | 仓库 | License | ★ | 备注 |
|---|---|---|---|---|
| spec-workflow-mcp | Pimzino/spec-workflow-mcp | GPL-3.0 | 4,293 | MCP server 形态 SDD；**GPL-3.0，Apache-2.0 项目不可直接引用代码** |
| Spec Kitty | Spec-Kitty 社区 fork | 开源 | — | 内置 git worktree 编排；v3.2.5 |
| shotgun | shotgun-sh/shotgun | MIT | 686 | codebase-aware spec 生成 |
| MUSUBI | nahisaho/MUSUBI | MIT | ~57 | EARS 格式需求 + 九条宪法 + **Phase -1 gates** + 全链路追溯；设计上最接近 agent-cord 的严肃性，但已停滞 |
| Memex（商业） | — | Fair-code | — | **规格 = 类型化决策数据库 + 每条验收标准 CI 可验证 + 知识图谱**；理念与 agent-cord 的「证据锚点可机验」几乎一致，但闭源且「最未经验证」 |
| GRACE | osovv/grace-marketplace | 开源 | — | 契约优先 + Graph-RAG + **drift detection（规格漂移检测）** |

### 这一阵营的关键判断
独立研究 [spec-compare](https://github.com/cameronsjo/spec-compare)（MIT，★148，2026-09-23 更新，是目前最好的 SDD 选型情报源）在其 [critical-analysis.md](https://github.com/cameronsjo/spec-compare/blob/main/docs/critical-analysis.md) 中明确指出：

> **The Enforcement Gap** — "Agents ignore specs. Writing the spec is the easy half; **most tools have nothing that makes the implementation honor it.**"
> 实测问题包括：agent 忽略详细规格、误读指令、重复已有代码、为小 bug 生成 5 页用户故事。
> 结论：「Specifications alone don't guarantee compliance / **Tools need better validation and enforcement mechanisms**」

**这是对 agent-cord 最有价值的一条情报**：它同时证明了 (a) 需求缺口真实存在（差异化成立），(b) 目前**没有竞品在解决它**，(c) 最直接的挑战者是 Memex，而它闭源且未验证 → **agent-cord 的窗口是开的，但也说明「门禁」这件事没有经过验证的现成设计可抄**。

---

## 2. 多 agent 编排与并行 agent 阵营

### AgentTeams（agentscope-ai/AgentTeams）—— **概念最接近 agent-cord 的现成系统**
- 仓库：https://github.com/agentscope-ai/AgentTeams ｜ Go ｜ **Apache-2.0**
- 活跃度：★5,667 ｜ fork 700 ｜ 最后推送 2026-09-23 ｜ 创建 2026-02-21 ｜ v1.2.4（迭代极快，阿里巴巴背景）
- 提供什么：**Manager-Workers 架构的多 agent 协作运行时**。核心特征：多个 agent 在**一个受控、可审计的 Matrix 房间（IM room）里协作**，人全程可见可干预；多运行时 worker 共存（OpenClaw / QwenPaw / Hermes / 实验性 DeepSeek Harness）；MinIO 共享文件系统降低 token 消耗；Higress AI 网关统一凭证；Element（IM 客户端）+ Tuwunel（Matrix 服务端）**绕开飞书/钉钉的企业审批开销**；含审计日志与人机干预记录。
- 匹配度：**只能借鉴思路（但架构参照价值最高）**
- 为什么重要：它是**唯一把「IM 房间 = 协作会场」做成一等公民并落地到可审计运行时**的开源系统，正是 agent-cord「群=圆桌 + 单机器人路由」的产品假设的正面验证。差异在于：AgentTeams 是**中心化 Manager 指挥 Worker**（orchestrator-worker），而 agent-cord 是**异构模型盲评投票制衡**（无单一裁决者）；AgentTeams 也没有账本/门禁。**建议把它的房间权限模型、审计事件模型、以及「人如何在不打断流程的前提下介入」的机制作为主要参考。**

### Kiro Crew（kirodotdev/KiroCrew）—— AWS 开源，最接近的「常驻 daemon」形态
- 仓库：https://github.com/kirodotdev/KiroCrew ｜ Python ｜ **Apache-2.0**
- 活跃度：★4,123 ｜ fork 662 ｜ 最后推送 2026-09-24 ｜ 2026-07-16 创建，2026-08-04 开源
- 提供什么：**持久化 agent 工作区**。跨会话存活（session / memory / schedule / task checkpoint 抗 Gateway 重启）；`kirocrew gateway` 常驻 + CLI + 桌面 app + Web dashboard；**Slack / Discord 接入**；cron 定时任务与 heartbeat 监控；**ACP 后端**（默认走 `kiro-cli`）；沙箱与审批开关；Docker 分发（`ghcr.io/kirodotdev/kirocrew:stable`）。前身是 Amazon 内部项目 MeshClaw。
- 匹配度：**适配后复用（分发给终端的形态）+ 强烈借鉴架构**
- 结论：Kiro Crew ≈ agent-cord「常驻 daemon 核心 + 薄 CLI + IM 接入 + 调度」的**已完成参照实现**（Python 而非 TS）。它的「Gateway 常驻 + 多前端（CLI/桌面/web/IM）+ 持久化检查点」分层，几乎是 agent-cord 架构文档的镜像。**建议精读它的 daemon/gateway 分层与审批模型**。局限：绑定 Kiro CLI 作为默认 agent，且「编排开源、harness 闭源计量」（harness 本身闭源，orchestration 层 Apache-2.0）。

### ruflo / claude-flow（ruvnet/ruflo）
- 仓库：https://github.com/ruvnet/ruflo（原名 ruvnet/claude-flow）｜ TypeScript ｜ MIT
- 活跃度：★73,200 ｜ fork 8,687 ｜ 最后推送 2026-09-24（极活跃）
- 提供什么：大规模 agent 编排：hive-mind（queen + 8 类 worker）、8 种拓扑、**声明实现 Raft / Byzantine / Gossip / CRDT / Quorum 共识**、持久记忆、自学习、Claude Code / Codex 双 worker。
- 匹配度：**只能借鉴思路**
- ⚠️ 重要技术判断：它宣称的 **Byzantine Fault Tolerant 共识（2/3 多数）在 LLM 场景下是错误类比**。BFT 的前提是故障**独立**；而多个 LLM 的同源错误是**强相关**的（同一预训练数据、同一 RLHF 偏好），2/3 多数根本不提供 BFT 声称的保证。**agent-cord 的「锚点 Jaccard ≥ 0.5 判疑似同源错误」正好是在处理这个相关性问题上比 claude-flow 更诚实的设计**——这是一条值得写进设计文档的差异化论证，但要注意它目前只是启发式阈值，没有实证支撑。
- 这个仓库 star 极高但工程可信度有争议（fork/star 比偏高、issue 数 1,011），**不建议作为依赖，建议作为「反面教材 + 少数可抄的工程细节（记忆回写、拓扑配置）」。**

### HumanLayer（humanlayer/humanlayer）—— **审批门禁最成熟的现成实现**
- 仓库：https://github.com/humanlayer/humanlayer ｜ TypeScript ｜ **Apache-2.0**（API 误标 NOASSERTION，已核验 LICENSE）
- 活跃度：★11,606 ｜ fork 956 ｜ 最后推送 2026-06-19
- 提供什么：**Human-in-the-loop 基础设施**。在 tool-calling 层拦截高风险函数调用，`require_approval()` 阻塞直到人工批准，审批请求路由到 **Slack / Email / Discord**（多通道）；框架无关（LangChain / CrewAI / Vercel AI SDK / Mastra 皆可）；带完整审批审计记录。
- 匹配度：**适配后复用（强烈推荐）**——agent-cord 的 gate「升级人工」这一环（锚点同源疑似 → 升级人工）几乎就是它的核心用例。它是 TS、Apache-2.0、且把「审批请求走 IM」这件事做成了产品。**建议直接依赖或至少抄它的审批状态机与通道抽象。**

### Vibe Kanban（BloopAI/vibe-kanban）
- 仓库：https://github.com/BloopAI/vibe-kanban ｜ Rust ｜ Apache-2.0
- 活跃度：★28,182 ｜ 最后推送 2026-09-19 ｜ 注意：有评测称「公司已停止运营，开源版仍在」[来源](https://vibecoding.app/blog/vibe-kanban-review)
- 提供什么：Kanban 看板 + **git worktree 隔离**层，协调 Claude Code / Codex / Gemini CLI 等并行 agent，卡片状态 = 任务状态，带 diff 审查。
- 匹配度：**只能借鉴思路**。它是「人看 agent 工作状态的界面」，不是共识机制。但「卡片状态机 + worktree 隔离」与 agent-cord 的 req 状态机有映射关系。语言是 Rust，无法复用代码。

### 其余编排/框架（判定为不匹配，登记备查）
| 项目 | 仓库 | License | ★ | 判定 |
|---|---|---|---|---|
| OpenHands | OpenHands/OpenHands | MIT | 89,065 | 单 agent 平台 + 云端；不匹配（非共识） |
| MetaGPT | FoundationAgents/MetaGPT | MIT | 70,591 | SOP 流水线式多 agent（产品经理↔架构师↔工程师）；最后推送 2026-01-21，**明显放缓**；不匹配 |
| ChatDev | OpenBMB/ChatDev | Apache-2.0 | 34,381 | 2.0 版；「communicative dehallucination」（双角色 inception prompting）是**少数有论文支撑的共识机制**，但整体是论文实现而非可复用库；不匹配 |
| AutoGen | microsoft/autogen | CC-BY-4.0 | 61,141 | ⚠️ 已与 Semantic Kernel 合并为 Microsoft Agent Framework，AutoGen 处维护态；**CC-BY-4.0 是文档许可，代码许可另有约定，慎用** |
| CrewAI / LangGraph | crewAIInc/crewAI、langchain-ai/langgraph | MIT | 58,981 / 42,229 | 通用多 agent 框架，Python 优先；agent-cord 不需要 |
| OpenAI Agents SDK (JS) | openai/openai-agents-js | MIT | 3,857 | 轻量 TS 多 agent 框架，若需 handoff 可考虑 |
| Mastra | mastra-ai/mastra | NOASSERTION | 28,313 | TS agent 框架，**license 需人工核验** |
| Temporal / Inngest / Trigger.dev / conductror-oss | — | MIT/Apache | — | 持久化工作流引擎；**对「预定义有向图 + gate」过重**，agent-cord 的图是静态 YAML + 幂等节点，用不上 durable execution 的复杂度 |
| Plandex | — | — | — | 已停止云端服务，自托管模式；不推荐 |
| aider | Aider-AI/aider | Apache-2.0 | 49,154 | **最后提交 2026-05-22，已基本停滞**；作为 AgentDriver 目标仍可用，但不宜依赖其演进 |

### Beads（gastownhall/beads）+ Gas Town —— **账本/事件流设计的最强参照**
- 仓库：https://github.com/gastownhall/beads（原 steveyegge/beads）｜ Go ｜ **MIT**
- 活跃度：★27,397 ｜ fork 1,856 ｜ 最后推送 2026-09-24 ｜ v0.47.0
- 提供什么：**git-backed 图状 issue tracker，专为编码 agent 做持久记忆**。关键机制：
  - **哈希化 ID（`bd-a1b2`）防止多分支/多 agent 合并冲突** ← 与 agent-cord 的 `req-id` 设计直接相关
  - **Dolt 后端**（版本化 SQL 数据库，**cell 级合并 + 原生分支**），同时保留 **JSONL 以便 git 可移植**
  - **compaction（语义记忆衰减）**：定期把已关闭任务摘要化，防上下文膨胀 ← **agent-cord 的 ledger.yaml 长期演进必然会遇到这个问题，Beads 已给出答案**
  - `relates_to / duplicates / supersedes / replies_to` 图关系 ← 与「账本条目状态机」的迁移关系同构
  - `spec_id` 字段：把 issue 链接回规格文档 ← 与 agent-cord 的跨文档一致性校验直接对应
  - message issue type + threading（agent 间异步消息）
- 匹配度：**适配后复用（机制层面）+ 可直接依赖 Dolt（若选 SQL 路线）**
- Gas Town（gastownhall/gastown，MIT，★18,176）：构建在 Beads 之上的多 agent workspace manager，「Rule of Five（五轮收敛评审）」等范式。

### MCP Agent Mail（Dicklesworthstone/mcp_agent_mail）
- ★2,160 ｜ NOASSERTION（需核验）｜ 最后推送 2026-09-22
- 提供什么：agent 身份 + 收件箱/发件箱 + 可搜索线程 + **advisory file reservations（带 TTL 的文件租约，替代硬锁）**。**双持久化：git（人类可审计的 markdown 制品）+ SQLite FTS5（快速检索）** ← 与 agent-cord「文件 SSOT + SQLite 派生索引」完全同构，是这条路线可行性的现成证明。
- 匹配度：**适配后复用**。它的「advisory 租约而非硬锁」是解决多 agent 并发写同一 req 目录的现成答案。

---

## 3. 共识 / 投票机制阵营 —— 机制可行，但无现成实现

### llm-council（karpathy/llm-council）—— 盲评投票的原型
- 仓库：https://github.com/karpathy/llm-council ｜ Python
- 活跃度：★24,979 ｜ fork 4,367 ｜ 创建并最后推送 **2025-11-22**（已停更约 10 个月）
- ⚠️ **License: 无（NO-LICENSE）**。**法律上不可 fork、不可复制代码**，只能读思路。
- 提供什么：三阶段流程 —— ① 多个模型并行独立作答；② **匿名互评**（答案去掉模型身份后互相排名，Borda 计数）；③ chairman 模型综合出「共识答案 + 异议」。
- 匹配度：**只能借鉴思路**（且因无 license，连借鉴都要小心表述）
- **它证明的关键机制**：**「并行独立生成 → 匿名化 → 交叉排名」在工程上完全可行，并且是社区自发验证过的**（衍生出至少 8 个独立复刻）。这正是 agent-cord「盲评投票（不辩论）」的骨架。

### 可合法复用的 MIT 复刻
| 项目 | 仓库 | License | ★ | 差异点 |
|---|---|---|---|---|
| llm-council-plus | DmitryBMsk/llm-council-plus | MIT | 129 | 3 阶段 council；2026-09-08 活跃 |
| the-llm-council | sherifkozman/the-llm-council | MIT | 90 | Claude Code 框架版多模型规划 |
| WEIPING_COUNCIL | appleweiping/WEIPING_COUNCIL | MIT | 132 | **6 种协议：council / debate / red-team / consensus / specialist / tournament** ← 协议枚举设计值得抄 |
| gemini-llm-council | theerud/gemini-llm-council | MIT | 15 | Gemini CLI 扩展，多模型共识 |
| llm-council-app | PromtEngineer/llm-council-app | MIT | 10 | 匿名互评 + Borda + chairman 综合/异议 |
| PolyCouncil | TrentPierce/PolyCouncil | NOASSERTION | 43 | LM Studio 多模型裁决引擎 |

### 学术证据（回答「机制是否被证明可行」）
- **多模型一致性确实降低同步幻觉**：多 agent LLM 集成「要求多个独立 agent 对同一分类达成一致，从而大幅降低多个 LLM **同步出错**的概率」——[arXiv 2410.16543](https://arxiv.org/pdf/2410.16543v2)。**这正是 agent-cord `2/2 一致才 confirmed` 的学术依据。**
- **自一致性检测**：SelfCheckGPT — 同一模型多次采样，答案一致说明事实可靠，分歧则可能是幻觉 → agent-cord 的 `temperature=0 + 锁版本` 是对该思路的强化（去掉采样随机性，把「分歧」完全归因于模型间差异）。
- **共识机制在推理可靠性上的应用**：[A Hashgraph-Inspired Consensus Mechanism for Reliable Multi-Model Reasoning](https://arxiv.org/pdf/2505.03553)。
- ⚠️ **反向证据（重要）**：[Free-MAD: Consensus-Free Multi-Agent Debate](https://arxiv.org/html/2509.11035v1) 论证「不依赖多轮交互、**不需要达成共识**，而是对整个辩论轨迹评分，准确率更高」。**这对 agent-cord「必须 2/2 一致才 confirmed」是一个设计风险提示**：强制一致可能把「正确答案只在少数模型手里」的情况判为未决；建议账本条目状态机保留「少数派异议」为可追溯的一等状态（不要丢弃为「未共识」），而不是二值化。

### 缺口判定
**没有任何项目实现了 agent-cord 的核心：**
1. **决策点（decision point）粒度的账本条目状态机**（proposed → voted → confirmed/rejected，带证据锚点与迁移原因）
2. **证据锚点的机验**（锚点必须是可机器验证的定位，如 `file:line` / 测试 ID / 命令输出哈希）
3. **锚点 Jaccard ≥ 0.5 的同源错误检测与人工升级**（我在 GitHub 全站检索 `multi-agent consensus`、`LLM council`、`consensus multi-model judge` 等组合，命中的最接近项目是 `hjjtt/claude-skill-consensus-voting`（★5）与 `ElonAug7/multi-judge-consensus`（★1）——**均为个位数 star 的玩具级实现**）

---

## 4. 协议与运行时抽象 —— AgentDriver 有标准可依

### Agent Client Protocol（ACP，Zed 发起）—— **强烈推荐作为 AgentDriver 的实现基础**
- 仓库：https://github.com/agentclientprotocol/agent-client-protocol ｜ **Apache-2.0**
- 活跃度：★4,319 ｜ fork 403 ｜ 最后推送 2026-09-24（非常活跃）
- 定位：「**LSP for agents**」——用 JSON-RPC 替代 ANSI 转义码/屏幕抓取，标准化「编辑器 ↔ 编码 agent」的通信；支持结构化 tool call、流式输出、diff 呈现、权限请求（permission request）等。
- **生态成熟度（关键）**：官方与社区适配器已有：
  - npm `@agentclientprotocol/sdk` v1.5.0（Apache-2.0，2026-09-21 更新）
  - npm `@agentclientprotocol/claude-agent-acp` v0.81.2（Apache-2.0，**2026-09-24 更新，日更**）
  - npm `@zed-industries/claude-code-acp` v0.16.2、`@zed-industries/codex-acp` v0.16.0（均 Apache-2.0）
  - **17+ 个 agent 已支持 ACP**：Claude Code、Cursor、Codex CLI、Gemini CLI、Windsurf、Cline、goose、**Kimi CLI** 等（[来源](https://thamizhelango.medium.com/agent-client-protocol-acp-the-lsp-moment-for-ai-coding-agents-and-how-jetbrains-and-zed-nailed-e2a42f5defb0)）；JetBrains 已共同建设分发；Zed、VS Code 第三方扩展均有 ACP client。
  - **Vercel AI SDK 已有 ACP community provider**（[ai-sdk.dev](https://ai-sdk.dev/providers/community-providers/acp)），可把 ACP agent 当作语言模型使用。
- **匹配度：直接复用**。
- ⚠️ **命名冲突警告**：**「ACP」是重载缩写**，调研中至少撞到三个：
  1. **Agent Client Protocol**（Zed / agentclientprotocol org）—— 编辑器↔agent，**这是 agent-cord 要的**
  2. **Agent Communication Protocol**（IBM Research，BeeAI 底层）—— 扩展 MCP 的 agent 发现与执行
  3. 某些资料里 ACP 又被指为 IBM 的 Agent Communication Protocol
  agent-cord 文档里写「ACP」必须加全称限定，否则必然出歧义。
- **结论**：agent-cord 的 `AgentDriver` 接口**不应该从零设计**。正确做法是：**内部抽象 = 薄薄一层 `AgentDriver`，其下第一实现 = ACP client**，再对未支持 ACP 的 CLI 保留「subprocess + stdout 解析」的降级驱动。这样白送了 Claude Code / Codex / Gemini / Kimi / Cursor / Cline / goose 的兼容性。

### 各家官方 SDK（作为直连降级驱动）
| SDK | npm 版本 | License | 备注 |
|---|---|---|---|
| `@anthropic-ai/claude-agent-sdk` | 0.3.281（2026-09-24） | **"SEE LICENSE IN README.md"（非 OSS）** | ⚠️ 非开源许可，作为**可选适配器**可以，**不可进核心依赖树** |
| `@anthropic-ai/claude-code` | 2.1.281 | 同上（仓库 anthropics/claude-code **无 license**） | 同上 |
| `@openai/codex-sdk` | 0.156.1（2026-09-24） | Apache-2.0 ✅ | 可依赖 |
| google-gemini/gemini-cli | — | Apache-2.0 ✅ | 可依赖 |
| sst→anomalyco/opencode | ★209,830 | MIT ✅ | 75+ 模型提供商 |

**判断**：agent-cord「每任务 subprocess 驱动 headless CLI」的设计正确，但**必须把厂商 SDK 隔离在可选适配器内**，核心只依赖 ACP + 通用 subprocess——这同时满足了项目「不绑定特定厂商」的硬约束。

### 其他协议（登记，非核心）
- **MCP**：Anthropic 发起，2025-12 捐给 Linux Foundation；10,000+ server、97M+ 月 SDK 下载。agent-cord 若要让外部工具接入，MCP 是唯一选择。npm `@modelcontextprotocol/sdk` v1.30.1（MIT，2026-09-23）。
- **A2A（Agent2Agent）**：Google 发起，Linux Foundation；`a2aproject/A2A` ★25,922 Apache-2.0。agent-to-agent 通信。**agent-cord 内部是同进程/子进程，不需要 A2A；但作为未来对外互操作标准应留意。**
- **AGENTS.md**：非专有 markdown 约定，「28.64% median runtime reduction、16.58% token reduction」；agent-cord 生成的 agent 上下文应遵循它而非自创。
- **SKILL.md**：Anthropic 规范，跨平台可移植。

### 直连模型 API 做投票执行器
- **Vercel AI SDK（`ai` v7.0.113，Apache-2.0，2026-09-23）**：统一 provider 接口 + `generateObject`（zod schema 结构化输出）+ 支持 Anthropic / OpenAI / Google / 本地模型。**这是 agent-cord「投票执行器直连模型 API + 结构化输出」的最佳现成基座。**
- 备选：`openai` v7.23.0（Apache-2.0）、`@google/genai` v2.24.0（Apache-2.0）、`zod` v4.6.5（MIT）。
- 注意：**结构化输出 + temperature=0 + 锁模型版本**这套组合，各家 API 的参数名与保证不同（OpenAI 有 strict schema，Anthropic 走 tool use，Google 有 responseSchema）。AI SDK 抹平了接口但**没有抹平「确定性」的差异**——「temperature=0 不等于确定性」这一点要在设计里承认，并用「锚点机验」而非「投票一致」作为最终可信来源。

---

## 5. 组件级可复用库清单

| agent-cord 组件 | 推荐现成实现 | License | 判定 |
|---|---|---|---|
| **IM 适配 + NormalizedEvent** | **[Vercel Chat SDK](https://github.com/vercel/chat)**（npm `chat` v4.41.0，★2,384，2026-09-22 更新） | MIT | **直接复用**。架构正好是 Chat（路由）+ Adapters（平台差异）+ State（Redis/ioredis/memory/pg）。已有 adapter：slack / teams / gchat / discord / telegram / github / linear / notion / whatsapp / messenger / instagram / gmail / twilio / web / x |
| ↳ **缺口** | **无 Feishu/Lark、无企业微信、无钉钉 adapter** | — | **必须自研**（用 `@larksuiteoapi/node-sdk` v1.74.0，MIT，2026-09-14；按 Chat SDK 的 `adapter-*` 契约实现一个新 adapter） |
| **CEL 校验器（第二级）** | **`@marcbachmann/cel-js` v8.0.0**（MIT，2026-07-07，**周下载 286,382**） | MIT | **直接复用**。另有 `cel-js` v0.8.2（MIT，停滞于 2025-07）；规范 [cel-expr/cel-spec](https://github.com/cel-expr/cel-spec) ★3,986 Apache-2.0。CEL 在 JS 生态健康度可用 |
| **YAML 工作流 schema + apiVersion 校验** | `zod` v4.6.5 + AJV | MIT | 直接复用（spec-compare 自己就用 AJV 校验 `apiVersion` 化的工具 JSON 文件——**可直接抄它的 schema 版本化方案**） |
| **检索索引（FTS5 + trigram）** | `better-sqlite3` v13.0.3（MIT）；备选 `node-sqlite3-wasm` v0.8.60 | MIT | **直接复用，但见第 6 节实测的 2 字限制** |
| **中文分词** | `wangfenjin/simple`（★691，C++ FTS5 分词器，支持中文+拼音） | 开源 | **仅在 trigram 不够时引入**；引入即失去纯 JS 可移植性 |
| **append-only 事件流 + git 合并** | **git 内建 `merge=union`**（见第 6 节实测） | 内建 | **直接复用，无需自研** |
| **事件溯源（若 ledger 要用事件源）** | `@event-driven-io/emmett` v0.42.4（2026-09-24） | 需核验 | 备选；但 agent-cord 的账本更简单，**建议纯文件自研** |
| **版本化数据存储（账本的另一条路）** | **Dolt**（dolthub/dolt，Apache-2.0，★24,505，2026-09-24） | Apache-2.0 | **重要备选**。Beads v0.47 已用它做「cell 级合并 + 原生分支」；若 `ledger.yaml` 的 YAML 合并成为痛点，Dolt 是成熟替代方案 |
| **人工审批门 / 升级通道** | **HumanLayer**（TS，Apache-2.0） | Apache-2.0 | **适配后复用** |
| **文件租约 / 并发写保护** | MCP Agent Mail 的 advisory reservation 模式 | 需核验 | 借鉴设计，自研实现 |
| **结构化输出** | Vercel AI SDK `generateObject` + zod | Apache-2.0 / MIT | 直接复用 |
| **相似度（锚点 Jaccard）** | 自研（Jaccard 本身 5 行代码）；`fast-jaccard` 等包存在但无必要 | — | **自研** |
| **常驻 daemon + 本地 IPC** | Node 内建 HTTP/Unix socket + `json-rpc-2.0` v1.8.1（MIT）或 `vscode-jsonrpc` v9.0.2（MIT） | MIT | 直接复用（**与 ACP 一致选 JSON-RPC** 可减少一套协议） |
| **AgentDriver** | **ACP（`@agentclientprotocol/sdk`）+ 官方 CLI SDK 降级** | Apache-2.0 | **直接复用（架构级决定）** |

---

## 6. 我做的两条本地实测（校验核心设计假设）

### 测试 1：SQLite FTS5 trigram 对中文的实际支持边界
环境：macOS 自带 `sqlite3` 3.51.0。

```sql
create virtual table t using fts5(id UNINDEXED, body, tokenize='trigram');
insert into t values('1','多智能体共识协作基座的设计'),('2','共识账本与证据锚点');
select id from t where t match '共识';        -- 3 字符以下：返回空
select id from t where t match '共识账';      -- 3 字符：命中 id=2 ✅
select id from t where body like '%共识%';    -- 2 字符 LIKE：命中，但 QUERY PLAN = SCAN t VIRTUAL TABLE INDEX 0:L1（全表扫描）
```

**结论（对 agent-cord 知识库设计的直接影响）**：
- trigram **可用**、**中文子串匹配正确**，无需引入分词器 → 原设计成立。
- ⚠️ **但 `MATCH` 查询必须 ≥ 3 个字符**，而中文里 **2 字词极其常见**（"共识"、"账本"、"需求"、"接口"、"门禁"）。**用户输入 2 字查询会得到空结果，这是必然的体验 bug。**
- 2 字 `LIKE` 能查对但退化为全表扫描，文档规模上来后性能不可接受。
- **建议**：查询层做 **bigram 扩展/改写**（把 2 字查询拆成带引号短语或改写为 trigram 可匹配形式），或对短查询走独立索引；**不要把「trigram 就够了」当成不需要处理的结论写进设计文档**。这是本次调研发现的、原设计里一个会被实际使用打到的问题。

### 测试 2：git `merge=union` 对 `events.jsonl` 的实际行为
```bash
echo 'events.jsonl merge=union' > .gitattributes
# main: {"ts":1},{"ts":3}   feat: {"ts":1},{"ts":2}
git merge feat
# → Merge made by the 'ort' strategy. 无冲突
# → 结果：{"ts":1} / {"ts":3} / {"ts":2}  ← 两边的追加都保住了
```
**结论**：
- ✅ **agent-cord「git union merge driver 防合并丢事件」的设计成立，且无需自研 merge driver——`union` 是 git 内建策略**，一行 `.gitattributes` 即可。
- ⚠️ **三个必须写进设计文档的坑**：
  1. `union` **不去重、不排序**——合并后行序交错，消费端**必须按事件内的时间戳/序号自行排序**，不能依赖文件行序。
  2. 同一变更被重复应用（cherry-pick 后再 merge、或 merge 后再 rebase）**会重复插入行**，消费端需要幂等（按 event id 去重）。
  3. `union` **只适合行级 append-only 的文件**；对 `ledger.yaml` 这种结构化文件，两边同时修改同一 entry 时 union 会产出**语法上无效的 YAML** → **ledger.yaml 不能用 union，必须走人工/工具合并，或改用 Dolt**。这是「ledger.yaml（可合并语义）+ events.jsonl（union）」两者合并策略必须区分的硬理由。

---

## 7. 造轮子 vs 复用：明确建议

### 应该直接用现成库（不要自研）
1. **AgentDriver 的协议层** → ACP（`@agentclientprotocol/sdk`）+ 各厂商官方 SDK 作为可选适配器
2. **IM 适配与 NormalizedEvent** → Vercel Chat SDK；**仅飞书/企微/钉钉 adapter 需要自研**
3. **CEL 校验** → `@marcbachmann/cel-js`
4. **结构化输出** → Vercel AI SDK + zod
5. **事件流的 git 合并** → 内建 `merge=union` + `.gitattributes`
6. **检索索引** → `better-sqlite3` + FTS5（注意补 2 字查询改写）
7. **本地 IPC / daemon 通信** → JSON-RPC 2.0 库（与 ACP 保持同一协议族）
8. **人工审批门与 IM 审批通道** → HumanLayer（或至少抄其状态机）
9. **YAML apiVersion schema 校验** → zod/AJV

### 必须自研（无现成实现，且这是我的核心结论）
1. **共识账本 `ledger.yaml` 的条目状态机**（含证据锚点 schema、迁移原因、少数派异议留存）
2. **证据锚点的机验器**（锚点 → 可执行检查的映射；这是全行业空白，`spec-compare` 明确称其为 "The Enforcement Gap"）
3. **锚点 Jaccard 同源错误检测与人工升级策略**（阈值需自证）
4. **gate 的 YAML 化定义 + 角色×时机×校验×放行条件的运行时求值器**
5. **工作流有向图的节点/边语义与幂等执行**（Temporal 那类引擎过重，不需要）
6. **投票执行器的「盲评」呈现与聚合逻辑**（匿名化 + 一致判定 + 异议留存）
7. **契约层**：把「规格 Markdown ↔ 账本条目 ↔ 锚点」三者的一致性校验做成 CI 可跑的东西（Memex 做的是同一件事，但闭源）

### 明确不要碰
- Temporal / Inngest / Trigger.dev / conductor-oss：durable execution 的复杂度与静态 YAML 图不匹配
- Chrono 类通用多 agent 框架（LangGraph / CrewAI / AutoGen / Mastra）：它们是 Python 优先或 license 不清，且语义层（agent 会话）与 agent-cord（共识与放行）正交
- ruvnet/ruflo：star 极高但 BFT 类比在 LLM 场景不成立，工程可信度待考
- karpathy/llm-council：**无 license，代码不可复制**
- spec-workflow-mcp：GPL-3.0，与 Apache-2.0 不兼容

---

## 8. 复用优先级清单

| 优先级 | 复用对象 | 类型 | 对 agent-cord 的作用 | License |
|---|---|---|---|---|
| **P0** | **Agent Client Protocol（ACP）+ `@agentclientprotocol/sdk` + `@agentclientprotocol/claude-agent-acp`** | 协议/库 | **免自研 AgentDriver 协议层**，白送 17+ 编码 agent 兼容 | Apache-2.0 |
| **P0** | **Vercel Chat SDK（`chat`）** | 库 | **免自研 IM 适配层与 NormalizedEvent**；飞书 adapter 自研 | MIT |
| **P0** | **git 内建 `merge=union` + `.gitattributes`** | 内建 | events.jsonl 防丢事件方案成立且零成本 | 内建 |
| **P0** | **`better-sqlite3` + FTS5 trigram** | 库 | 知识库派生索引成立（**须补 2 字查询改写**） | MIT |
| **P1** | **Vercel AI SDK + zod** | 库 | 投票执行器（锁版本 / temperature=0 / 结构化输出） | Apache-2.0 / MIT |
| **P1** | **HumanLayer** | 库/设计 | gate 的「升级人工」通道与审批状态机 | Apache-2.0 |
| **P1** | **`@marcbachmann/cel-js`** | 库 | 第二级校验器（CEL） | MIT |
| **P1** | **Beads 的账本机制设计**（哈希化 ID、Dolt 后端、compaction、spec_id、图关系） | 设计参照 | 直接决定 `req-id` 与 ledger 长期演进不烂 | MIT（可参考） |
| **P1** | **Kiro Crew 的 daemon/gateway/多前端分层** | 架构参照 | 验证「常驻 daemon + 薄 CLI + IM + 桌面」分层 | Apache-2.0 |
| **P2** | **AgentTeams（Matrix 房间 = 圆桌）** | 架构参照 | IM 房间权限模型、审计事件、人机介入机制 | Apache-2.0 |
| **P2** | **OpenSpec 的目录约定 + delta 语义（ADDED/MODIFIED/REMOVED）** | 设计对齐 | 让 `cord/<req-id>/` 对用户不陌生，降低学习成本 | MIT |
| **P2** | **spec-compare 的 apiVersion + AJV schema 方案** | 设计模式 | 工作流 YAML 的版本化校验 | MIT |
| **P2** | **MCP Agent Mail 的 advisory file reservation** | 设计参照 | 多 agent 并发写同一 req 目录的冲突模型 | 需核验 |
| **P3** | 各 MIT 版 llm-council（WEIPING_COUNCIL 的 6 协议枚举、llm-council-app 的 Borda + 异议留存） | 设计参照 | 投票协议与聚合算法 | MIT |
| **P3** | **Dolt** | 库（备选） | 若 YAML 合并成为痛点，替换 ledger 存储层 | Apache-2.0 |
| **P3** | `@larksuiteoapi/node-sdk` | 库 | 飞书 IM adapter（Chat SDK 未覆盖） | MIT |
| **不可复用** | karpathy/llm-council | ⛔ 无 license | 只能读思路 | — |
| **不可复用** | spec-workflow-mcp | ⛔ GPL-3.0 | 与 Apache-2.0 不兼容 | — |
| **不可复用** | Conductor（conductor.build）、Kiro IDE、Tessl、Traycer、Memex、CodeRabbit/Greptile/Qodo | ⛔ 闭源 | 仅作竞品观察 | — |

---

## 9. 需要向上层提示的遗留项与风险

1. **本报告所有 star/license/推送时间均为 2026-09-24 的 GitHub API 实测值**，但三个数据点存疑，建议人工复核：
   - `obra/superpowers` ★291,081（二次核验 API 一致，但相对 spec-compare 8 月记录的 ~214K 增长过快）
   - `github/spec-kit` ★138,721 但 watchers 仅 708，比例异常
   - `ruvnet/ruflo` ★73,200 / fork 8,687 / open issues 1,011，fork 比偏高
2. **未完成的核验**：`mastra-ai/mastra`、`superset-sh/superset`、`Dicklesworthstone/mcp_agent_mail`、`@event-driven-io/emmett` 的 license 为 NOASSERTION 或未取到，若要引入需人工读 LICENSE 原文。
3. **两条设计假设我做了实测（第 6 节）并都发现需要修订**：trigram 的 2 字中文查询会失效；`ledger.yaml` 不能用 `union` 合并（只有 `events.jsonl` 可以）。这两点建议直接反馈到设计文档。
4. **本次调研未涉及**（超出「开源实现」范围但相关）：IM 平台（飞书/企微/钉钉）官方 SDK 的具体限额与合规要求；模型厂商 API 的确定性保证差异；Apache-2.0 项目依赖非 OSS 许可 SDK（Anthropic）的法务边界。这三项建议单独确认。

**主要情报源**：[spec-compare（20 个 SDD 工具 + 30+ 编排工具的独立对比研究）](https://github.com/cameronsjo/spec-compare)、[bswen 的 2026 AI 规格框架对比](https://docs.bswen.com/blog/2026-08-07-ai-spec-frameworks-compared/)、[Kiro Crew 报道（InfoQ）](https://www.infoq.com/news/2026/08/kiro-crew-coding-agents/)、[Zed ACP 分析](https://rywalker.com/research/zed-agent-client-protocol)。
