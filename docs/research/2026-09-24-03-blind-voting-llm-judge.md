---
title: LLM 盲评投票 / 多模型共识 / LLM-as-judge
date: 2026-09-24
type: research-archive
status: 调研结论均为 2026-09-24 当日实测，时效性敏感（star 数、版本、license 可能变化）
---

调研完成。以下是完整报告。

---

# agent-cord「多模型盲评投票执行器」可复用开源实现调研

**核查方式与时效**：所有 star 数 / license / 最近提交时间均为我在 **2026-09-24** 通过 GitHub API（`gh api`）+ npm registry 实测，非记忆。学术结论引用 arXiv/HF 原文页。

## 0. 结论速览

1. **没有现成实现可以直接复用为「投票执行器」。** agent-cord 要的是 *k 个异构模型独立盲评 → 结构化输出 → 锚点机验 → 确定性共识 → 同源检测*。开源生态里唯一大量存在的是 **council/debate 模式**（独立回答 → 互相看见 → 主席综合），而这正是 agent-cord 明确要避开的「辩论」。语义方向相反。
2. **但「半成品」比预想的多**：provider 抽象、结构化输出、usage/cost 采集、LLM-judge 提示模板、Bias 缓解手法这四类都有成熟库，应该直接用；共识状态机、锚点机验、同源（Jaccard）检测、盲评匿名化、gate 引擎则**大概率必须自研**。
3. **最值得精读的参考实现是 `builtbyden/ai-council`**（MIT，TypeScript，1⭐，2026-08 创建）。它的流水线与 agent-cord 的 ledger 设计高度同构：不可变快照 → 3 个盲评 reviewer → **evidence gate（finding 必须能匹配到真实文件/diff 才计数）** → 交叉审阅 → 争议单轮 rebuttal → **代码计算的确定性共识（不交给模型）** → 保留 dissent 的 verdict。它同时暴露了「私有 Core 不含 provider adapter」的坑，可作为反面教材。
4. **`karpathy/llm-council` 的 25k⭐ 是个陷阱**：**仓库没有 LICENSE**（默认保留所有权利，代码法律上不可复用），单次提交于 2025-11-22，作者在 README 里明确写「不打算维护」。只能借鉴思路。
5. **许可雷区**：Arize Phoenix 已改为 **Elastic License 2.0**（非 OSI 开源，与 Apache-2.0 约束冲突）；Mozilla 系之外的注意点是 microsoft/autogen 用 **CC-BY-4.0**（非软件许可）；`Liyan06/MiniCheck`、`composable-models/llm_multiagent_debate` 等**无 LICENSE**；Langfuse / LiteLLM 是「MIT core + `ee/`/`enterprise/` 商业目录」的双许可结构，用于库分发时要避开这些目录。

---

## 1. 技术栈对位：先确定「可复用」的判定基准

agent-cord 的技术选型（**TypeScript + 常驻 daemon + 同时导出为库 + npm 分发**）极大压缩了候选集：**Python 库基本只能"借鉴思路"**，除非接受一个 Python sidecar 进程（与「常驻 daemon + 库导出」形态和「本地开发工具链优先」有摩擦，且引入第二套运行时）。

因此后文匹配度分四档：**直接复用 / 适配后复用 / 只能借鉴思路 / 不匹配**。

---

## 2. LLM-as-a-Judge 评估框架（DeepEval / promptfoo / OpenAI Evals / Ragas / Inspect AI / autoevals）

| 项目 | 仓库 | ⭐ | License | 最近提交 | 语言 |
|---|---|---|---|---|---|
| Promptfoo | [promptfoo/promptfoo](https://github.com/promptfoo/promptfoo) | 25,418 | MIT | 2026-09-24 | TypeScript |
| OpenAI Evals | [openai/evals](https://github.com/openai/evals) | 19,501 | MIT（`LICENSE.md`，GitHub 误判为 NOASSERTION） | 2026-04-14 | Python |
| DeepEval | [confident-ai/deepeval](https://github.com/confident-ai/deepeval) | 18,429 | Apache-2.0 | 2026-09-24 | Python |
| Ragas | [vibrantlabsai/ragas](https://github.com/vibrantlabsai/ragas)（原 `explodinggradients/ragas`，仓库已归属改名） | 15,840 | Apache-2.0 | 2026-02-24 | Python |
| Inspect AI | [UKGovernmentBEIS/inspect_ai](https://github.com/UKGovernmentBEIS/inspect_ai) | 2,854 | MIT | 2026-09-24 | Python |
| evalite | [mattpocock/evalite](https://github.com/mattpocock/evalite) | 1,693 | MIT | 2026-04-28 | TypeScript |
| openevals | [langchain-ai/openevals](https://github.com/langchain-ai/openevals) | 1,206 | MIT | 2026-09-18 | Python |
| autoevals | [braintrustdata/autoevals](https://github.com/braintrustdata/autoevals) | 1,040 | MIT | 2026-09-23 | Python（另有 TS 包） |

**它们提供什么（共性）**：把一个「判据」表达为 rubric / criteria，调用一个 judge 模型打分，产出 score + reason；有 CI 集成、数据集管理、pass/fail 阈值。

**与 agent-cord 的差距（关键）**：
- **语义错位**：这些是 *evaluation*（离线跑测试集、衡量质量），agent-cord 需要的是 *decision consensus*（在线对某个决策点产出 confirmed/rejected 的状态并写入账本）。前者无「决策点」概念、无状态机、无 ledger、无 gate 放行条件。
- **无锚点机验**：judge 只会说「这段理由站得住吗」，不会校验 `file:line` / symbol 是否真实存在。
- **无同源检测**：没有任何一个框架做「多个 judge 的证据锚点重合度 ≥ 0.5 则判疑似同源错误」。
- **judge 数量模型**：DeepEval 的 `GEval` / promptfoo 的 `llm-rubric` 都是**单 judge**语义；DeepEval 有 [`Arena GEval`](https://deepeval.com/docs/metrics-arena-g-eval)（两两对比选优），promptfoo 有 `g-eval`、`similar`、`factuality` 断言 —— 但这些仍然是**评分器**，不是**投票聚合器**。它们不会为你做 2/2 一致判定、平票处理、dissent 保留。

**匹配度**
- **promptfoo → 适配后复用（仅 provider 层 + 计量层）**。它官方提供稳定 [Node API](https://www.promptfoo.dev/docs/usage/node-api-reference/)：`loadApiProviders([...])` 拿到 k 个 provider 实例，`provider.callApi()` 返回的 `ProviderResponse` 带 `tokenUsage` 和 `cost`，还有 `assertions.runAssertion` 可作锚点校验的挂载点。**这是 TS 生态里最接近「k 模型 fan-out + usage 采集」的现成积木**。但注意：`evaluate()` 主干是「prompt × tests × assertions」的 evals 形状，硬套进投票执行器会有阻抗失配；建议只用 provider/assertion 子模块，不要用 `evaluate()`。
- **DeepEval → 只能借鉴思路**。价值在(G-Eval 的 CoT rubric 拆解提示模板、DAG 指标、`faithfulness` 指标定义、[position bias 的处理文档](https://www.confident-ai.com/blog/why-llm-as-a-judge-is-the-best-llm-evaluation-method)）；Python，且是 eval 语义。
- **OpenAI Evals → 只能借鉴思路**。半停滞（4 个月无提交），价值在 *registry / 数据格式* 的组织方式。
- **Ragas → 只能借鉴思路**。`faithfulness` 作为「锚点支撑度」的指标设计可参考；近 7 个月无提交。
- **Inspect AI → 只能借鉴思路**。UK AISI 出品，`model_graded_qa` 的 scorer 设计很干净，是「多模型 + 打分器」组合范式的好参考，但 Python。
- **evalite / autoevals / openevals → 只能借鉴思路或轻量适配**。evalite 是 TS 但要 5 个月未更新；autoevals 的 TS 版提供 LLM-as-judge scorer（单 judge），可作为「judge 调用封装」的轻量参考，但没有 panel/consensus。
- **额外发现**：[Future AGI `ai-evaluation`](https://futureagi.com/blog/ai-evaluation-open-source-llm-evaluation-library/)（Apache-2.0，宣称同时提供 Python 与 TypeScript、含 `CustomLLMJudge` + 70+ rubric 模板 + judge 级联）值得留意，但项目较新、影响力未验证，且从第三方博客获知，我未从其官方仓库直接核实功能边界。

---

## 3. 多模型路由 / 集成层（LiteLLM / RouteLLM / Martian / TensorZero / Portkey / OpenRouter / Vercel AI SDK）

| 项目 | 仓库 | ⭐ | License | 最近提交 | 语言 |
|---|---|---|---|---|---|
| **Vercel AI SDK** | [vercel/ai](https://github.com/vercel/ai) | 26,928 | Apache-2.0（GitHub 标 NOASSERTION，LICENSE 正文为 Apache-2.0） | 2026-09-24 | TypeScript |
| LiteLLM | [BerriAI/litellm](https://github.com/BerriAI/litellm) | 59,555 | MIT（`enterprise/` 目录另许） | 2026-09-24 | Python |
| Portkey Gateway | [Portkey-AI/gateway](https://github.com/Portkey-AI/gateway) | 13,074 | MIT | 2026-05-25 | TypeScript |
| TensorZero | [tensorzero/tensorzero](https://github.com/tensorzero/tensorzero) | 11,717 | Apache-2.0 | 2026-06-11 | Rust |
| RouteLLM | [lm-sys/RouteLLM](https://github.com/lm-sys/RouteLLM) | 5,541 | Apache-2.0 | **2024-08-10（停滞 ~2 年）** | Python |
| Martian | 商业服务；[martianprotocol/martianrouter](https://github.com/martianprotocol/martianrouter) 仅 1⭐ 的 SDK stub | — | MIT | 2025-02-08 | Python |
| OpenRouter | 商业托管网关（非开源） | — | — | 活跃 | — |

**逐个判定**

- **Vercel AI SDK → 直接复用（首席推荐）**。理由：TS 原生、Apache-2.0、`@ai-sdk/*` 覆盖 OpenAI/Anthropic/Google/xAI 等；[`generateObject`](https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data) 用 `output` + Zod schema 做跨 provider 结构化输出（这正是投票执行器要的「结构化输出 + 锁 schema」）；返回结果带 `usage`（prompt/completion tokens）与 `finishReason`；有 telemetry/OTel 接口。AI SDK 6 还补上了 Agent 抽象和统一 structured outputs。**"k 个异构模型实例 → 并发 generateObject → 收集 {结构化票, usage}" 这一层，它基本是标准答案。**
- **LiteLLM → 适配后复用（作为可选 sidecar，不要硬依赖）**。价值：`Router` 的 model group / 权重 / fallback / 重试，以及[跨 100+ provider 统一的 `usage` 对象](https://docs.litellm.ai/docs/completion/usage)与花费追踪。但它是 Python；agent-cord 的「TS 核心 + 库导出」若硬嵌 LiteLLM 就等于引入第二运行时。**建议：定位为可选的本地网关（daemon 的 HTTP upstream 之一），不进入核心依赖图。**
- **Portkey Gateway → 适配后复用（可选 sidecar）**。TS 写的网关，MIT，形态更像「独立进程」而非库。作为可选 upstream 有吸引力（与核心同语言），但要注意 2026-05 后提交变少、且曾传出被收购。
- **TensorZero → 只能借鉴 / 可选 sidecar**。Rust，能力面很宽（gateway + observability + optimization + evaluation），但 2026-06 之后提交停滞，接入是独立的数据库+网关架构，对「库形态」不友好。
- **RouteLLM → 不匹配**。它解决的是**成本路由**（强/弱模型二选一），与「k 个模型同时投票」是正交问题；且已停滞近两年，只剩「cascade/级联」思路可参照。注意搜索结果里把它标为「MIT」的说法与官方仓库 Apache-2.0 不一致，仓库 LICENSE 为准。
- **Martian → 不匹配**。已是纯商业 API 服务，开源部分只剩空壳 SDK；作为「多模型路由」的**产品思路**参考即可。
- **OpenRouter → 适配后复用（作为可选 provider 通道）**。实用价值明确：**一个 key 访问几百个模型、响应回传 usage/cost、provider 级 failover**——对「k 个异构模型」的获取门槛最低。代价：把第三方放进请求链路（安全合规需评估），且它不提供任何投票/共识逻辑。**建议做成 provider 适配器之一，而非唯一通道。**

---

## 4. 「多模型投票 / 共识 / council」类项目（重点）

| 项目 | 仓库 | ⭐ | License | 最近提交 | 语言 |
|---|---|---|---|---|---|
| karpathy LLM Council | [karpathy/llm-council](https://github.com/karpathy/llm-council) | 24,979 | **无 LICENSE** | 2025-11-22（单次提交，作者声明不维护） | Python |
| OptiLLM | [algorithmicsuperintelligence/optillm](https://github.com/algorithmicsuperintelligence/optillm) | 4,303 | Apache-2.0 | 2026-09-17 | Python |
| MoA | [togethercomputer/MoA](https://github.com/togethercomputer/MoA) | 2,981 | Apache-2.0 | 2025-01-07 | Python |
| **builtbyden/ai-council** | [builtbyden/ai-council](https://github.com/builtbyden/ai-council) | 1 | **MIT** | 2026-08-16 | JavaScript/TS |
| Multi-Agents-Debate | [Skytliang/Multi-Agents-Debate](https://github.com/Skytliang/Multi-Agents-Debate) | 612 | GPL-3.0 | 2025-12-16 | Python |
| 多 agent 辩论（ICML'24） | [composable-models/llm_multiagent_debate](https://github.com/composable-models/llm_multiagent_debate) | 553 | **无 LICENSE** | 2025-04-24 | Python |
| LoopTroop | [looptroop-ai/LoopTroop](https://github.com/looptroop-ai/LoopTroop) | 154 | MIT | 2026-09-24 | TypeScript |
| @adlc/consensus-fix | [voodootikigod/adlc](https://github.com/voodootikigod/adlc) | 21 | MIT | 2026-09-24 | TypeScript |
| Claude Skill 系 council | `aiwithremy/claude-skills-llm-council` 2,214⭐ / `tenfoldmarc/llm-council-skill` 773⭐ / `gcpdev/llm-council-skill` 448⭐ | — | **全部无 LICENSE** | 活跃 | 多为 Markdown/Python |

**karpathy/llm-council ≥ 25k⭐ 却没有 LICENSE**，且 README 自述「99% 是 vibe coded 的周六 hack…我不打算以任何方式支持它，代码是按原样提供给人启发」。它的三阶段设计（独立回答 → **匿名化互评** → Chairman 综合）中，唯一值得搬的是**匿名化互评**这一动作的设计细节。**不要复制其代码**（无授权），也不要把它的"辩论"路径当默认。

**`builtbyden/ai-council` —— 本次调研最重要的发现（建议精读）**
它与 agent-cord 的同构度极高，且是 **TypeScript/JavaScript、MIT**：

- 流水线：`不可变快照 → 独立盲评 → Evidence Resolver/Gate → Cross Review → 争议选择 → 单轮定向 rebuttal → 确定性共识 → verdict → 人类决策`
- "每个 finding 在计数前都要对它引用的真实文件/diff 做校验；**无法被证明的断言直接排除出 verdict，而不是因为它被模型断言过就采信**"——这正是 agent-cord「证据锚点可机验」的直译
- "**共识在代码里计算，绝不交给模型**"、"保留真实分歧而不制造虚假一致"（其示例输出明确展示 `MAJORITY_CONFIRMED` + 附带的 Dissent 文本）——正是 agent-cord 的 `confirmed` 状态机 + 反对票保留
- 测试覆盖了 schemas / evidence gate / dispute / consensus / verdict / security

**它的三个坑要记下**：① 真正的 Codex/Claude/Gemini CLI adapter 在**私有 Core 包**里，公开仓库只有编排层（`COUNCIL_CORE_DIR` 运行期动态加载）——这恰好印证 agent-cord "统一 AgentDriver 接口 + 薄适配器" 的拆分是对的，但也说明公开参考实现无法直接跑通；② 项目仅 1⭐、创建于 2026-08-16，无社区验证；③ 它是本地单用户工具，无 ledger / 无 git SSOT / 无 gate 工作流图（这些仍是 agent-cord 要自研的部分）。

**OptiLLM —— 算法清单最全，只能借鉴思路**
Apache-2.0、4.3k⭐、活跃（2026-09-17）。它是一个 OpenAI 兼容的推理代理，把 **self-consistency、Mixture-of-Agents、majority voting、parallel CoT decoding、entropy-based sampling** 等实现为可插拔 plugin。Python，无法复用代码，但**"测试时计算 + 投票类算法"的实现清单和参数选择可以直接对着抄思路**（尤其 self-consistency 的采样温度/样本数/tie-breaking 处理）。注意它是代理形态，与 agent-cord "投票执行器直连模型 API" 的方向不同——agent-cord 不应该经由代理，因为要锁模型版本与 temperature=0。

**TS/npm 侧的 council 生态（都 MIT，但都是"辩论+主席"，不是盲评投票）**
我实测了 npm 上的 TS 实现：`amicus` 4.13.0（多模型 council + 结构化评审，MIT）、`looptroop` 0.5.9（154⭐，TS，活跃）、[`lco-spec` / isakli05/llm_council_orchestrator](https://github.com/isakli05/llm_council_orchestrator)（MIT，TS，**"用 LLM council 产出 schema-validated / lintable / freezable 的应用规格"**——这个概念与 agent-cord 的 YAML 化 spec + 校验最接近，值得一看）、`@nicknisi/pi-llm-council`、`panel-mcp-server`、`agentk8`、`vibecodereview`、`pi-llm-council`。逐个看下来，**没有一个是"盲评 + 门禁 + 锚点机验"**，全部是"多模型各答 → 互评/辩论 → 主席综合"。其中 `vibecodereview`（LLM-council PR review，多视角 + 自愈 GitHub check）和 `looptroop`（LLM-council planning + 人工门禁 PR 交付）在**工程化形态**上可参考。

**`@adlc/consensus-fix`（MIT，npm v1.11.1）——思路有意思**：自述 "N-version programming for failing tests — fan N LLM completions, group by agreement, recommend the smallest consensus fix"。**"fan out N → 按一致度聚类 → 取最小共识"**这个聚合形状与 agent-cord 的「k 模型一致才 confirmed」是同族的，但它是针对"修测试"的补丁生成，不是通用投票执行器。可参 1 眼其聚类/去噪实现。

**多 agent 辩论系 → 借鉴（agent-cord 设计上已正确排除）**：ICML 2024 *Improving Factuality and Reasoning in Language Models through Multiagent Debate*（arXiv:2305.14325，引用 2,800+）证明辩论有效，但其参考实现 `composable-models/llm_multiagent_debate` **无 LICENSE**，`Skytliang/Multi-Agents-Debate` 是 **GPL-3.0**（会传染，不能进 Apache-2.0 项目）。MoA（togethercomputer/MoA，Apache-2.0，2025-01 后停滞）提供 layered aggregator 思路。

**通用多 agent 框架 → 不匹配**：microsoft/autogen（61,141⭐，**LICENSE 为 CC-BY-4.0**，这**不是软件许可**，法务风险）、crewAI（58,981⭐，MIT）、langgraph（42,229⭐，MIT）——它们是"编排 agent"的框架，不提供投票/共识/锚点语义，且都会把 agent 运行时和编排逻辑绑在一起，与 agent-cord "自研工作流图 + gate" 冲突。

---

## 5. 锚点机验 / 证据 grounding（Jaccard 之外的配套件）

agent-cord 的锚点校验有两条路：① **确定性机验**（锚点是否真实指向存在的文件/symbol/行）；② **语义支撑**（该断言是否真的被该处证据支撑）。

- **(1) 确定性部分：无现成库，必须自研。** 最接近的公开实现就是 `builtbyden/ai-council/deliberate/evidenceGate.mjs` + `gate.mjs`（MIT，可读）。这属于"20 行代码 + 领域规则"级别，没有库化的必要。
- **(2) 语义部分（可选增强，不替代机验）**：
  - [FActScore](https://github.com/shmsw25/FActScore)（456⭐，**MIT**，2025-04）——原子事实分解 + 逐条验证。**思路可借鉴**（把一段断言拆成原子 claim 再逐条找证据），Python。
  - [MiniCheck](https://github.com/Liyan06/MiniCheck)（228⭐，2026-09-23 仍活跃，**无 LICENSE**）——小模型做「claim vs grounding document」的 entailment 判定，比 GPT-4 便宜数百倍。**代码不可复用（无许可）**，但**HF 上的模型权重可作为可选的本地 grounding 校验器**（模型自身许可需单独核实，我未能通过 HF API 验证其 license 字段）。EMNLP 2024 论文见 arXiv:2404.10774。
  - Ragas `faithfulness` / DeepEval `Faithfulness` —— 指标定义可参照，Python。
- **(3) Jaccard 集合相似度：无「锚点同源检测」现成库，必须自研，但底层相似度可复用**。npm 上有 `wink-distance`（MIT，含 `jaccard()`，但 2023 年后未更新）、`compute-cosine-similarity`、`string-comparison` 等。**建议直接自写**（~20 行，按「文件路径 + symbol」归一化后求集合 Jaccard），不要为此引依赖。

**学术支撑（说明 agent-cord 这个设计不是拍脑袋）**：`Correlated Errors in Large Language Models`（[arXiv:2506.07962](https://arxiv.org/html/2506.07962v1)，2025-06）实测「两个模型都犯错时，它们在 60% 的情况下会同意」；Apple 的 [Correlated Errors Undermine LLM Evaluation Panels](https://machinelearning.apple.com/research/correlated-llm-evaluation-panels)（2026-06）直接给出「**评审面板约 3/4 的名义独立性因模型在同一批样本上犯同样的错而丢失**」；`Don't Always Pick the Highest-Performing Model`（[arXiv:2602.08003](https://arxiv.org/html/2602.08003v1)，2026-02）用 Gaussian-copula 建模模型间相关性。**这直接支持 agent-cord「2/2 一致仍要查锚点 Jaccard 同源」的升级人工策略**——否则 k=2 的一致性会给出虚假信心。另外多 judge 面板的通行做法（vendor-diverse panel + 3-of-5 多数 + Fleiss' κ 可靠性统计 + bootstrap CI，见 arXiv:2605.20351）也建议纳入观测面。

---

## 6. 观测 / usage 采集 / Bias 缓解

- **Langfuse**（[langfuse/langfuse](https://github.com/langfuse/langfuse)，35,010⭐，2026-09-24，**MIT core + `ee/`、`web/src/ee/`、`worker/src/ee/` 商业目录**，TS）→ **适配后可选用**。有 TS SDK、LLM-as-judge evaluator、token/cost 追踪。**注意许可结构**：作为可选观测后端可以，别把 `ee/` 代码带进来。
- **Helicone**（[Helicone/helicone](https://github.com/Helicone/helicone)，6,175⭐，Apache-2.0，TS）→ 可选观测/代理。
- **Arize Phoenix**（11,600⭐）→ **不匹配，许可冲突**：LICENSE 实测为 **Elastic License 2.0**，非 OSI 开源，与 agent-cord 的 Apache-2.0 开源定位不相容。
- **Bias 缓解手法（无现成库，自研）**：位置偏置（position bias）的缓解在学界已成套路——**配对评审时交换顺序两次取平均**。参考 [A Survey on LLM-as-a-Judge (arXiv:2411.15594)](https://arxiv.org/pdf/2411.15594) 与 [From Generation to Judgment (arXiv:2411.16594)](https://arxiv.org/pdf/2411.16594) 的 "Swapping Operation" 小节。**agent-cord 的盲评本身已消除模型身份偏置，但若评审对象有顺序（如多个候选项），仍需随机化顺序**：这是纯自研的 ~15 行逻辑。
- **结构化输出小件**：[Zod](https://www.npmjs.com/package/zod) 4.6.5（MIT，2026-09-13）直接复用；`@instructor-ai/instructor`（TS 版 instructor，MIT）**最后一次发布是 2025-01-27，已停滞，不建议**——用 AI SDK 的 `generateObject` + Zod 即可覆盖。

---

## 7. 顺手发现的、主题未列但相关的项目

- **`builtbyden/ai-council`**（已在 §4 详述）——本次调研与 agent-cord 最同构的公开实现，强烈建议纳入参考。
- **`isakli05/llm_council_orchestrator` / npm `lco-spec`**（MIT，TS）——"council 产出 schema-validated / lintable / freezable 规格"，形态与 agent-cord 的 YAML 工作流 + 三级校验器最接近。
- **OptiLLM 的 plugin 算法清单**（self-consistency / MoA / majority voting 的参数化实现）——投票算法实现细节的最佳"抄写对象"。
- **MoA（Mixture-of-Agents）**——layered aggregator 的收敛设计（多层聚合而非单层多数）值得评估是否作为 confirmed 之外的第二档策略。
- **CEL 在 JS 的现成实现**（属于 gate 校验器第二级，非本次主题但同属架构）：[`@marcbachmann/cel-js`](https://www.npmjs.com/package/@marcbachmann/cel-js) v8.0.0（MIT，2026-07-07，零依赖）与 `cel-js` v0.8.2（MIT，2025-07-11）。**建议用前者**：`@marcbachmann/cel-js` 维护更新、版本更高；`cel-js` 已一年未更新。这意味着「三级校验器」中的 CEL 级**不需要自研**。
- **多 judge 面板的统计可靠性**（Fleiss' κ + bootstrap CI，arXiv:2605.20351）——建议进入 agent-cord 的观测面，用来向用户暴露"本次共识的可信度"。

---

## 8. 造轮子 vs 复用：逐组件决策

**应该直接用现成库（不要自研）**

| 组件 | 选择 | 理由 |
|---|---|---|
| 多 provider 统一调用 + 结构化输出 + usage | **Vercel AI SDK (`ai`) + `@ai-sdk/*` + Zod** | TS 原生、Apache-2.0、`generateObject` 跨 provider 锁 schema、结果带 usage |
| 可选 provider 层备选 | **promptfoo `loadApiProviders` / `callApi`** | TS、MIT、官方稳定 Node API、`ProviderResponse` 自带 `tokenUsage` + `cost` |
| gate 校验器第二级（CEL） | **`@marcbachmann/cel-js`** | MIT、零依赖、活跃 |
| 配置/文档 frontmatter 解析 | （YAML/Zod 生态已有，自行选型） | — |
| 观测后端（可选） | **Langfuse（TS SDK，避开 `ee/`）或 Helicone** | — |

**适配后复用（包装一层，不进入核心语义）**

- LiteLLM / Portkey Gateway / TensorZero 作为**可选 sidecar 网关**（提供 fallback、重试、spend 追踪），不进入核心依赖图。
- OpenRouter 作为**可选 provider 通道**（快速获得 k 个异构模型 + usage/cost 回传），同样不设为唯一通道。
- `wink-distance` 之类的集合相似度：**能用但没必要**——Jaccard 自写更可控。

**没有现成实现，必须自研（这是 agent-cord 的真正价值与工作量所在）**

1. **投票执行器 / 共识状态机**：k 模型盲评编排、模型身份与顺序匿名化、2/2 一致判定、平票与弃权、confirmed/rejected/quarantine 状态流转、dissent 保留。**全生态无此原语**（所有 council 项目走的都是 debate + synthesis）。
2. **锚点机验（evidence gate）**：断言 → 真实文件/symbol/行的确定性校验；不合格断言**排除而非降权**。可参考 `ai-council/evidenceGate.mjs`。
3. **锚点同源检测**：锚点归一化 + Jaccard ≥ 阈值 → 升级人工。**无任何公开实现**（学术侧只证明问题存在，不给库）。
4. **盲评 + 非辩论的判决语义**：明确禁止模型互相看见对方输出（与 council 生态的默认行为相反）——需要自己坚持，因为所有现成库都默认"让模型互评"。
5. **工作流图 / YAML apiVersion 化 / 三级校验器**：无匹配实现。
6. **ledger.yaml / events.jsonl + git union merge**：无匹配实现。

**不要采纳**（许可或许可-语义不符）

- DeepEval / OpenAI Evals / Ragas / Inspect AI 作为核心（Python + eval 语义）
- RouteLLM（停滞 + 问题正交）、Martian（商业空壳）
- Arize Phoenix（**Elastic License 2.0**）、microsoft/autogen（**CC-BY-4.0**，非软件许可）
- karpathy/llm-council 及其 Skill 生态的**代码**（**无 LICENSE**）、`composable-models/llm_multiagent_debate`（无 LICENSE）、`Liyan06/MiniCheck`（无 LICENSE）、Skytliang/Multi-Agents-Debate（**GPL-3.0 传染**）
- `@instructor-ai/instructor`（TS instructor，已停滞 20 个月）

---

## 9. 复用优先级清单

**P0 — 立即采用（省下最确定的工程量，且零许可风险）**
1. **Vercel AI SDK + Zod**：provider 抽象、`generateObject` 结构化输出、`usage` 采集。作为投票执行器的底座。
2. **自写投票/共识状态机 + 盲评匿名化**：核心资产，不要指望开源（认清这是自研主战场）。
3. **自写锚点机验 + Jaccard 同源检测**：生态空白，且只有你能定义"锚点"格式。

**P1 — 立刻精读参考（省下最贵的设计试错）**
4. **`builtbyden/ai-council`（MIT, TS）**：evidence gate / dispute / consensus / verdict / dissent 保留的整套编排，最同构的公开实现。**先读它的测试与 `deliberate/*.mjs`**。
5. **OptiLLM 的 plugin 清单**：self-consistency / majority voting / MoA 的算法实现细节与参数。
6. **`lco-spec` / isakli05/llm_council_orchestrator（MIT, TS）**：council → schema-validated spec 的形态。
7. **学术侧确定性支撑**：Correlated Errors 系列（arXiv:2506.07962 / Apple 2026-06 / arXiv:2602.08003）+ LLM-as-a-Judge 综述的 swapping operation，用于给「Jaccard 同源升级人工」写 ADR 依据。

**P2 — 可选外围（按需接入，随时可摘）**
8. **promptfoo provider 层**（若不想把 AI SDK 作为唯一 provider 抽象）。
9. **LiteLLM / Portkey / TensorZero / OpenRouter**：作为可选网关或 provider 通道；**建议在 daemon 里做成可拔插 upstream**，而不是核心依赖。
10. **Langfuse（避开 `ee/`）/ Helicone**：观测与 cost 追踪。
11. **`@marcbachmann/cel-js`**：gate 校验器第二级。

**P3 — 仅作灵感，不采代码**
12. karpathy/llm-council 生态（匿名互评的交互设计）、FActScore（原子事实分解）、MiniCheck（claim-grounding 小模型）。

**明确排除**
13. RouteLLM、Martian、Arize Phoenix（ELv2）、microsoft/autogen（CC-BY-4.0）、@instructor-ai/instructor、以及所有无 LICENSE / GPL-3.0 的 council 与 debate 仓库代码。

---

## 10. 两个需要你（主 agent / 用户）拍板的点

1. **provider 抽象层选型**：Vercel AI SDK（TS 一等公民、结构化输出最顺，但生态被 Vercel 主导）vs promptfoo provider 层（MIT、已含 cost 数据、但 eval 形状有阻抗）vs 自写薄适配器（符合"不绑定厂商"，但要自己维护十几家差异）。我倾向 **AI SDK 为主 + 保留自写 AgentDriver 为投票执行器直连通道**（因为投票要求锁模型版本、temperature=0、结构化输出，AI SDK 能满足；而 agent 运行时的 headless CLI subprocess 走自研 Driver，两者不必统一）。**这一点需要确认，因为它决定了投票执行器是否"直连模型 API"还是"经由 SDK 间接直连"。**
2. **是否接受 Python sidecar**：如果接受，LiteLLM 能立刻给到 fallback/重试/spend 追踪；如果不接受，这些能力要在 TS 侧自研或在 AI SDK 之上薄封装。这会影响 daemon 的部署形态。

**未能核实的信息（如实说明）**：`Liyan06/MiniCheck` 与 `vectara/hallucination-evaluation-model` 的 HF 模型权重许可（HF API 在我这边返回错误，未能确认）；Future AGI `ai-evaluation` 的实际能力边界（仅从第三方博客获知）；Portkey 被收购后的许可证稳定性（仅有二手信息）。另需注意：搜索结果中若干博客把 RouteLLM 标为 MIT、与官方仓库 Apache-2.0 不一致，我以仓库 LICENSE 为准。
