# 05 · 通用投票机制

> 状态：**设计定稿，代码未实现**（本文档描述的是已定型的机制设计，仓库中尚无对应实现）
> 相关章节：[`./04-consensus-ledger.md`](./04-consensus-ledger.md)（共识账本与证据锚点，投票结果写回的对象）、[`./03-architecture.md`](./03-architecture.md)（三层架构、单机器人路由、`vote.completed` 事件）、[`./06-gates-workflow.md`](./06-gates-workflow.md)（校验器与触发式升级：难度门是 gate 的一个 checker）、[`./12-experiments.md`](./12-experiments.md)（实验一的可执行协议与全部阈值校准）、[`./08-self-evolution.md`](./08-self-evolution.md)（复述检验=投票机制在知识库的特化）
> 相关决策：[ADR-0002](./adr/ADR-0002-lightweight-default.md)（默认轻量 + 触发式升级）、[ADR-0006](./adr/ADR-0006-blind-voting.md)（独立盲评投票，不辩论）、[ADR-0007](./adr/ADR-0007-asymmetric-model-allocation.md)（非对称模型分配：生成弱/判定强，判定与生成必异构）、[ADR-0011](./adr/ADR-0011-agent-runtime.md)（agent 运行时：每任务 subprocess 驱动 headless CLI）、[ADR-0013](./adr/ADR-0013-vote-executor.md)（投票执行器=ProviderAdapter 直连模型 API）；完整 ADR 记录见 [`./adr/`](./adr/)

---

## 本章回答什么问题

> 术语：投票子系统代号 **conclave**（沿用项目旧名：隔绝、独立投票、直到达成共识——隐喻依然成立）。「run a conclave」即发起一轮盲评投票；项目名一律写 agent-cord。

多 agent 协作最常见的想像是"让几个 agent 讨论出一个结论"。本章要说明为什么本方案**不辩论、只盲评**，然后回答五个工程问题：**哪些决策点才允许投票**（难度门）；**投几票、结果怎么算放行**（k 值与放行规则）；**凭什么相信"一致"**（四条独立性保证，以及为什么它们只是必要非充分条件）；**具体怎么实现**（执行器选型、盲评隔离、锚点独立度检查）；**怎么度量**（投票记录 schema 与一致度的统计口径）。章末给出全部文献依据。

---

## 1. 为什么投票不辩论

直觉上，让多个 agent 互相讨论、互相纠错，应该比各自独立作答更准。这个直觉被三组证据证伪（[ADR-0006](./adr/ADR-0006-blind-voting.md)）：

**证据一：辩论不能稳定跑赢盲评投票与多路径集成。** ICML 2024 的系统 benchmark（Smit et al., *Should we be going MAD?*）对多 agent 辩论（Multi-Agent Debate, MAD）现状形态做了大规模对照，结论是它**不能稳定跑赢** self-consistency / 多路径集成，且对超参数高度敏感——换一组超参就退化。一个"时灵时不灵、还依赖调参"的机制不能作为平台的地基。

**证据二：辩论在理论上不改善期望正确率。** NeurIPS 2025 的工作（*Which Yields Better Decisions in Multi-Agent LLMs?*）证明：辩论诱导的是 agent 信念轨迹上的**鞅**（martingale）——在可交换的信念更新假设下，讨论只重新分配置信度，**不改善期望正确率**；同构 agent + 均匀信念更新时，期望正确率保持不变。也就是说，"靠讨论收敛出真相"这件事没有理论保证，只有"讨论让结论更自信"的副作用。

**证据三：自由互聊本身就是失败高发区。** UC Berkeley 的 MAST 研究（*Why Do Multi-Agent LLM Systems Fail?*, arXiv 2503.13657）分析了 AutoGen / ChatDev / CrewAI 等 7 个框架的 1600+ 条真实执行轨迹，归纳出 14 种失败模式、三大类（系统设计缺陷 / **agent 间错位** / 验证与终止缺陷），并指出多 agent 系统在流行基准上相对单 agent 的增益经常极小。其中"agent 间错位"类失败（A 不知道 B 已改了方案、对话被重置、责任不清）**直接源于无中介的自由对话**。这条证据同时也支撑了本方案的三层架构：agent 不直接互聊，统一经结构化状态中介（ADR-0003）。

加上成本：辩论的成本是"轮次 × agent 数 × 不断增长的共享上下文"，而盲评是 k 次互相独立的单次调用。在结论质量没有优势的前提下，"更贵且不可复现"是决定性的。

**辩论里真正有效的成分被吸收，而不是被丢掉：**

| 辩论的有效成分 | 本方案中的替代实现 |
|---|---|
| 匿名化削弱身份偏置（模型倾向偏袒与自己同 backbone 的一方，匿名化可缓解） | 盲评：不共享中间推理、不互相读输出，harness 级强制（§4.1） |
| 异构参与者带来多样性 | 异构模型 + 异构角色提示词（§4.2） |
| 异议被听见 | **少数派理由强制留痕**并随结论一并推给人（§3.4）——用结构化留痕替代口头反驳轮 |
| 强制反驳（devil's advocate） | 不由 agent 扮演反对者，改为"证据锚点独立度检查"：一致但锚点重合即视为疑似同源错误（§4.4） |

| 对比项 | 多 agent 辩论 | 独立盲评投票 |
|---|---|---|
| 结论质量 | 不能稳定优于盲评（ICML 2024），期望正确率无提升（NeurIPS 2025） | 在可机判答案 + 独立采样前提下有稳定增益（self-consistency） |
| 成本 | 轮次 × agent 数 × 增长的上下文 | k 次独立调用，线性且可预算 |
| 可复现性 | 依赖对话顺序与超参 | temperature=0 + 锁定模型版本 + 记录 prompt hash，可完全复现 |
| 可审计性 | 中间推理互相污染，净输入不可审计 | 每次调用独立留痕，净输入可被审计脚本检查 |
| 失败模式 | 从众 / echo chamber / 多数暴政（少数派顺从） | 相关错误（一致但同盲）——用难度门 + 锚点独立度 + 人工兜底处理 |

---

## 2. 适用范围：难度门

### 2.1 为什么必须前置难度门

投票只在"有先验把握"的决策点上放大正确率；在难题上它会**系统性反噬**。预注册研究（Bahuguna et al., 2026, *When Self-Consistency Backfires*）在 GPQA Diamond 上测得：多数投票使 **56.6%（Qwen2.5-7B）/ 65.7%（Llama-3-8B）的题目准确率反而下降**——难题上模型不是随机犯错，而是**一致地趋向同一个错误答案**，此时投票等于把错误放大并盖上"多数通过"的章。

所以规则是：**投票只用于非重点任务 + 可验证决策点**（难度门），不可逆/高风险决策一律走人工确认。这是 ADR-0002"默认轻量 + 触发式升级"哲学在投票场景的直接应用。

### 2.2 两个硬条件

决策点在进入投票队列**之前**必须同时满足（不满足则不进队列）：

| 硬条件 | 判据 | 为什么 |
|---|---|---|
| **可机验性** | 该决策点的证据锚点类型 ∈ {`code`, `case`}（可机验类型，见 [`./04-consensus-ledger.md`](./04-consensus-ledger.md) §4.5），即存在可机器执行的验证信号 | 只有可机验的结论才能被机器兜底；语义类决策无法被机器验证信号兜底（§3.3） |
| **可逆性** | 不在「不可逆动作」清单内 | 不可逆动作的错误代价无法通过后续迭代回收，必须人工 |

「不可逆动作」清单的初值（契约冻结、代码合入等）在 M1 评审时确定；边界太宽会让投票形同废设，太窄会把不可逆决策错误地自动化。

### 2.3 软信号：触发式升级

即使过了两个硬条件，以下软信号仍会调整投票配置（ADR-0002 同款哲学：系统提议升级，人确认即可）：

| 软信号 | 动作 |
|---|---|
| 决策点分类标签 ∈ {契约, 跨模块语义} | 即使可机验，也强制 **k=3**（不用 k=2）——分歧概率高的类别需要奇数票才能判分裂 |
| 该标签类别的历史推翻率高 | 自动降置信度 + 强制投票（即：原本可以人直接拍的低风险点，也要经过盲评）——这是推翻率回流机制的消费端 |
| 锚点失效（漂移重锚定失败） | 该决策点退化为重验，不走常规投票放行 |

### 2.4 不进投票队列的决策点去哪

| 决策点类型 | 处理路径 |
|---|---|
| 可机验 + 可逆（难度门通过） | 盲评投票，按 §3 规则放行 |
| 语义理解类（不可机验） | **不进投票队列**：不满足"可机验性"硬条件（§2.2），直接落 `needs_verification`，以人工选择题呈现（§3.3） |
| 不可逆 / 高风险 | 直接人工：以价值判断型或风险仲裁型介入点呈现（给选择题、并列证据与分歧理由） |
| 事实补充型（答案不在任何数据源中） | 不投票，直接问人（填空或短选择题） |

**难度门的实现形态**：它并不新增机制，而是 gate 的一个**校验器（checker）**实现（`checks: [difficulty_gate]`）。新增/调整判定规则只需改配置、组合已有 checker——与门禁章的"新增门禁零代码"原则一致。

---

## 3. k 值与放行规则

### 3.1 k=2-3 的初值依据

- **文献常态**：debate 系工作普遍使用 2-3 个 agent + 1 个 judge；本方案取 k=2-3，属于"够用且便宜"，而非"最优"。
- **收益饱和**：纯采样 + 投票的增益随 agent 数呈幂律并饱和（*More Agents Is All You Need*，agent 数增至 15-20 后才饱和）。k=2→3 有边际收益，继续增大在成本约束下不划算。
- **统计需要**：k=3 是机会校正一致度主指标（Fleiss' κ）的最低 rater 数，也是实测"2/3 多数规则"表现的唯一配置。因此**实验一的主配置为 k=3**，k=2 作为成本对照。
- **角色分工**：k=2 用于低风险、可机验、类别标签为普通的决策点；k=3 用于契约/跨模块语义等软信号触发升级的类别。

### 3.2 放行规则

| 场景 | 判定 | 后续动作 |
|---|---|---|
| k=2，2/2 一致，**可机验**（锚点类型 ∈ {code, case}） | `confirmed` | 账本条目晋升，`confidence_source: vote_agreement`，可驱动不可逆动作之外的关联动作 |
| k=3，3/3 一致，可机验，锚点独立度通过 | `confirmed` | 同上 |
| **语义类**（不可机验，未过难度门） | 不进投票队列，直接 `needs_verification` | 不产生投票记录；以人工选择题推人（§2.2、§3.3）。若另行配置参考性投票，其结果无论如何不得落 `confirmed` |
| k=3，2:1 分裂 | `needs_verification` | 少数派的结论、理由、证据锚点必须留痕，并随结论一并推给人 |
| 任一票弃权（`insufficient_evidence`） | 不允许 `confirmed` | 降级为 `needs_verification`；或补齐上下文/锚点后重投 |
| 锚点独立度触发（一致 + 锚点重合） | `escalated_anchor_overlap` | 强制升级人工，禁止自动 confirmed |
| 决策点涉及不可逆动作 | 人工 | 不进投票放行通道 |

补充规则：

- **判定 agent 失败重试**：单票判定失败重试 1 次，仍失败则记 `abstain`（等价于投兜底项），不阻塞整体投票——与"证据不足"的语义一致，宁可弃权也不要编答案。
- **判定必须能出具锚点**：每票不仅要给选项，还要给证据锚点；给不出锚点就必须选兜底项。这一条同时服务证据覆盖率指标与锚点独立度检查。
- **禁止在选项集之外作答**：诸如"以上都对/需要更多上下文"的话术视为解析失败，重试一次。
- **机制可复用**：知识条目的复述检验就是本机制的一个特化——同样是与抽取者异构的 k=2 盲评，只是把选项换成"适用条件 / 边界 / 例外 / 证据"四项是否一致（见 [`./08-self-evolution.md`](./08-self-evolution.md)）；门禁、防腐等场景的"机器判定"也走同一套放行语汇。

### 3.3 语义类决策：不进投票队列

这是整个投票机制里**最重要的一个堵漏**。可机验的决策点即使投错了，还有机器验证信号在下游兜底（用例会失败、契约校验会拦住）；语义理解类决策没有这个兜底——两个 agent 一致同意"这个字段的含义是 A"，但它真实含义是 B，下游所有验证都建立在错误理解上，会全绿。

所以规则是硬的：**语义类（不可机验）决策点不满足难度门的"可机验性"硬条件，因此不进投票队列**（§2.2），也不产生投票记录——直接落 `needs_verification`，以人工选择题呈现。人的成本因此从"读全部上下文"降到"看并列的两组候选理解与各自的证据锚点"。

允许的唯一变体是**参考性投票**：团队可以显式配置对语义类跑一次盲评，把多个独立视角的结论与证据打包成人做选择时的参考。但参考性投票的结果**无论如何不得落 `confirmed`**——它既不改变"不进队列"的定性，也不能替代人工裁决。

### 3.4 少数派理由为什么必须留痕

3 个异构 agent 的实验中，**39.1% 的样本出现 2:1 分裂**，其中 **25.5% 的分裂里少数派才是对的**（Minority Sentinel, 2606.29270）——这在基准上对应约 10pp 的可回收错误率。这意味着"2/3 多数通过"这个规则自带一个已知错误下限。

要回收这部分错误，人必须能看到少数派**为什么**反对。所以 `minority_report` 是 **2:1 分裂时的必填字段**，含三项：结论、理由、证据锚点，并随 `needs_verification` 一并推给人。没有理由留痕的少数派结论等于噪声——人无法判断该不该翻案。

同理，多数派结论也要带锚点——人的裁决依据是"两边的证据哪个站得住"，不是"哪边人多"。

---

## 4. 独立性保证：四条机制

算法（投票规则）可以调参，**独立性一旦破了，调什么参数都没用**——k 个 agent 如果实际上是同一个盲区在说话，投票只会把盲区加固。所以独立性的四条保证比 §3 的放行规则更根本。

| # | 机制 | 依据 | 破了会怎样 |
|---|---|---|---|
| 1 | 盲评匿名化，不共享中间推理 | 匿名化可缓解身份偏置（模型倾向偏袒同 backbone 一方） | 后发言的 agent 顺着先发言的走，k 票退化为 1 票 |
| 2 | 异构模型（跨家族 / 跨供应商 / 异角色提示词） | 等预算下异构集成优于同构集成；投票式聚合对异构有利 | 同构同源的错误被"多票一致"合法化 |
| 3 | **判定 agent 与生成 agent 必须异构** | LLM 评委系统性偏爱自己模型的输出（self-preference bias） | 生成方自己评自己，判定失去意义 |
| 4 | **证据锚点独立度检查** | 相关错误的测量逻辑（条件一致率：一致且引用同一证据 = 同源而非独立） | 两个 agent 引同一行代码"互相印证"，实为同一个证据的两种转述 |

### 4.1 盲评与匿名化

- 每票在**独立进程 + 独立临时工作区**里运行，互相不共享中间推理、不读取彼此输出；
- 输入中不出现其他 agent 的身份信息与输出（匿名化）；
- **per-agent 选项随机置换 + 决策点呈现顺序随机化**，置换记入投票记录（防 option-position prior 造成的假一致，也供实验一反查 position bias）；
- 这些都通过 **harness 强制**实现，不靠提示词叮嘱（"不要看别人的答案"不是一种机制）。

### 4.2 异构模型

使用不同模型家族 / 供应商，或至少不同角色提示词（如"代码考古 / 测试视角 / 架构审查"三种视角）。等预算条件下异构集成优于同构集成有直接实证（DEI, 2605.27130）；聚合方式也影响异构收益方向——**投票式聚合利异构，综合式（summary/merge）聚合可能反利同构**，本方案用投票式，方向一致。

### 4.3 判定与生成必异构

LLM 评委系统性偏爱自己（或同家族）模型的输出，且人类评审认为两者质量相当（self-preference bias, NeurIPS 2024；机制层面与困惑度/熟悉度相关）。因此：**生成侧用什么模型，判定侧就必须换一个模型家族。**

这一条与 ADR-0007"非对称模型分配"是**正交**的两件事，都成立：

- **非对称分配**管**能力档位**：生成用低成本模型，判定用高能力模型（判定侧成本高可接受，因为生成侧省下来了）；
- **判定异构**管**血统**：判定侧必须与生成侧不同家族，消除自评偏置。

只有两者同时满足，"生成弱 / 判定强"才不会退化成"自己夸自己"。

### 4.4 证据锚点独立度检查

相关错误（correlated errors）是投票机制的**核心威胁**：两个 agent 都答错时，有 60% 的概率错在同一个答案上（Kim et al., ICML 2025，350+ 模型大规模实证）；共享架构与供应商是相关性的驱动因素，而且**更大更准的模型即使跨架构跨供应商，错误相关性依然很高**。当投票是"两个 agent 引用了同一行代码"时，"一致"根本不构成独立验证。

检查逻辑只处理**一个危险象限**：结论一致 **且** 证据锚点重合。

- **比较对象**：只比规范化后的**符号锚点**集合（文件路径 + 顶层符号路径，如 `src/rules/Evaluator.java#RulesEngine.evaluate`）；行号不参与比较（既会漂移，也会巧合重合）。
- **重合度**：对两票的锚点集合算 **Jaccard 相似度**；**Jaccard ≥ 0.5 或一方集合是另一方的子集**，且结论一致 → 标记 `independence_flag: anchor_overlap` → 该决策点**强制升级人工**，禁止 confirmed。
- **对立面才是健康信号**：结论一致而锚点完全不同（各自引了不同证据）才构成独立验证。所以检查只需要处理"一致 + 重合"这一个象限，不需要惩罚分歧。
- 阈值 0.5 是**初值**，校准输入来自实验一的"证据锚点重合度"统计——这把风险 R-1（相关错误）的验证方法**前移到了运行时**，而不是只在实验里事后统计。

### 4.5 底线认知：异构是必要非充分条件

必须把这件事说清楚，避免把"异构投票"当成解药：

- **相关错误跨架构、跨供应商依然显著**（ICML 2025），且模型越大越准相关性越强；
- **echo chamber / 多数暴政是理论机制而非偶然**：多数 agent 若共享错误观念，少数派会顺从而非反驳（Estornell & Liu, NeurIPS 2024 的贝叶斯框架证明）；有干预手段（异构、匿名化、强制反驳），但都是缓解；
- **采样一致性类方法检测不到"一致的错误"**：语义熵（Nature 2024）这类方法能发现模型"不确定"，但模型集体自信地错时它无能为力；
- 还有一层是本方案自身的循环风险（[`./11-risks.md`](./11-risks.md) R-2）：**测试用例来自共识，共识错则测试全绿是更强的幻觉**。

因此最终兜底只能落在两处：**证据锚点**（结论必须落到可独立复核的代码/用例/契约上）与**独立于共识的验证信号源**（真实流量回放、灰度对比等真实世界的反馈）。异构投票的价值是降低错误率，不是消除错误率；所以语义类决策永不免审（§3.3）、锚点重合永不放行（§4.4）、不可逆决策永远人工（§2.2）。

---

## 5. 工程实现

### 5.1 投票执行器：ProviderAdapter 直连模型 API

投票的本质是 **k 次受控、可复现、可审计的判定调用**，不是 k 个通用 agent 任务。它需要的控制面——温度固定、模型版本锁定、结构化输出约束、逐次用量与成本采集、净输入可审计——只有直连各家 API 的薄适配层能给全。

**接口形态**（概念伪代码）：

```ts
interface ProviderAdapter {
  complete(req: VoteRequest): Promise<VoteResult>;
}

type VoteRequest = {
  modelIdVersion: string;      // 必须带版本后缀，如 "claude-sonnet-4-5-20250929"
  temperature: 0;              // 固定 0，不可配置
  systemPrompt: string;        // 角色设定 + 输出契约
  userPrompt: string;          // 决策点 + 上下文包 + 只读 worktree 定位符
  responseSchema: object;      // {option, anchors[], confidence}
};

type VoteResult = {
  parsed: { option: "A" | "B" | "C"; anchors: Anchor[]; confidence: number };
  rawUsage: { inputTokens: number; outputTokens: number; costUsd: number };
  latencyMs: number;
  requestId: string;
  modelIdResolved: string;     // 服务端实际解析到的模型版本，与请求值一并落库
};
```

- 能用 OpenAI 兼容端点的 provider 共用一个适配器；差异大的（Anthropic、Gemini 等）各写一个。新接一个 provider = 新增一个适配器文件 + 配置，平台核心零改动。
- `modelIdVersion` **必须带版本**（服务端灰度会让"同名字模型"在不同时间表现不同），否则实验一的可复现性直接落空；`modelIdResolved`（服务端实际解析到的版本）与请求值一并写入投票记录——「请求了什么」和「实际跑了什么」都要能查。
- **禁止静默降级**：模型不可用或版本下线时，适配器不得悄悄换一个模型继续跑——那会让投票记录里的 `model_id` 与真实执行不符，可复现性直接失效。正确动作是显式记为该票异常（abstain），由编排层决定重投或转人工。

**为什么不用 coding CLI 充当投票执行器**（虽然角色 agent 正好是驱动 CLI 的）。五条否决理由，全部命中核心约束：

| # | 问题 | 后果 |
|---|---|---|
| 1 | CLI 不暴露 temperature / 采样参数 / 模型版本锁定（跟随服务端灰度） | 实验一依赖的可复现性无法满足 |
| 2 | CLI 有 `CLAUDE.md` / 记忆 / 权限提示等**隐式上下文注入** | 净输入不可审计；审计脚本（检查是否泄漏人工结论/他人输出）在 CLI 上做不彻底 |
| 3 | 输出是会话 transcript，不是 `{option, anchors[], confidence}` | 需要脆弱解析层 + 重试层 |
| 4 | 每次投票是一个完整 agent loop（工具调用、文件读写） | 比一次 completion 贵一个数量级，且引入写权限风险（违背"agent 只产 Draft"边界） |
| 5 | 订阅制计费无法按次精确核算，session 状态是隔离污染源 | 成本不可采集，盲评隔离需额外清理 |

**LiteLLM 的定位**：仅作**可选加速件**——在某语言生态下用它的 SDK 加快适配器编写，但接口必须是我们自己的 ProviderAdapter，其类型不得泄漏进平台核心（语言选型见 [ADR-0009](./adr/ADR-0009-language-runtime.md)，本基座是 TypeScript，因此这个选项在实际落地时基本不可用，此处只记录它被评估过）。不作为架构依赖的理由：proxy 模式引入常驻有状态服务（与"默认轻量"冲突），且它抹平 provider 差异的取向与"异构需要暴露差异"相反；托管网关（OpenRouter 等）因数据经第三方且违反"不绑定厂商"原则被否决。

### 5.2 生成侧仍用 CLI：两侧执行器不对称

投票侧用直连 API，**生成侧角色 agent 仍用 headless CLI 驱动**（[ADR-0011](./adr/ADR-0011-agent-runtime.md)）——生成侧真正需要的是工具使用、长程编辑、仓库探索，这些是 CLI 的主场；判定侧需要的是确定性、可复现、可计量，这些是 CLI 的短板。两侧执行器不同不是妥协，而是 [ADR-0007](./adr/ADR-0007-asymmetric-model-allocation.md)"非对称分工"在执行器层的对应物。

| 任务类型 | 执行器 | 关键要求 |
|---|---|---|
| 生成（实现、重构、探索） | 每任务 subprocess 驱动 headless CLI | 工具能力、成本低（弱模型）、产物为 Draft |
| 判定（投票、评审、对抗验证） | ProviderAdapter 直连模型 API | temperature=0、锁版本、结构化输出、逐次计量 |

### 5.3 盲评隔离的工程实现

| 隔离维度 | 实现 |
|---|---|
| 上下文隔离 | 每票 = 独立进程 + 独立临时目录（`mktemp -d`），进程间无共享内存/文件；编排层只通过 IPC 收集最终 JSON |
| 输入隔离 | 由 harness 预组装输入：**只读 git worktree**（`git worktree add --detach <commit>`）+ 该票可见文件的**白名单**，从机制上杜绝"读到别人的输出"，不靠提示词约束 |
| 偏置隔离 | per-agent 选项随机置换 + 决策点顺序随机化，置换与顺序记入投票记录 |
| 违规处置 | **盲评审计脚本**作为 gate 的校验器：净输入中出现其他票输出或人工结论关键词 → 该票**作废重跑** |

### 5.4 难度门与锚点独立度也是检查器

两类判定都不需要新机制，直接实现为 gate 的 checker 并与已有 checker 组合：

- `difficulty_gate`：读决策点元数据（锚点类型、可逆性、分类标签、历史推翻率）→ 输出"投票 / 升级 k / 转人工"；
- `anchor_independence`：读各票锚点集合 → 输出 `pass` / `anchor_overlap`。

新增判定规则 = 改配置（组合 checker），符合"新增门禁零代码"原则。

---

## 6. 投票记录 schema

### 6.1 完整 schema

```yaml
# cord/<req-id>/votes/V-0007.yaml —— 一次独立投票的完整留痕
schema_version: 1
vote_id: V-0007
req_id: REQ-2026-042
entry_id: C-005                      # 对应账本条目

decision_point:
  id: D-0007
  question: "gate 的触发条件是否只由 attach.triggers 声明决定？"
  options:
    A: "是（只有 attach.triggers 生效，节点进入不再隐式触发）"
    B: "否（workflow 节点进入也会触发门禁）"
    C: insufficient_evidence         # 固定兜底项：证据不足，不许强行二选一
  difficulty_bucket: medium          # easy | medium | hard（分桶口径由实验一校准）
  machine_verifiable: true           # 证据锚点类型 ∈ {code, case}（可机验类型，见 04 章 §4.5）
  reversible: true                   # 不在不可逆动作清单内
  labels: [跨模块语义]                # 分类标签：契约 | 跨模块语义 | 求值顺序 | 其他

gate:
  difficulty_gate: pass
  anchor_independence: pass          # pass | anchor_overlap

config:
  k: 3
  temperature: 0
  option_permutation: per_agent_random
  worktree: "9f3c1ab7d2e5@read-only" # 只读快照，agent 在此自行读码
  isolation: process+tmpdir

votes:
  - agent_id: reviewer-a
    provider: anthropic
    model_id: claude-sonnet-4-5-20250929         # 请求的模型，必须带版本
    model_id_resolved: claude-sonnet-4-5-20250929  # 服务端实际解析到的版本
    prompt_hash: "sha256:1f8c..."
    option_permutation: [C, A, B]
    option: A
    anchors:
      - {kind: code, anchor: "src/gate/trigger-registry.ts#TriggerRegistry.resolve", line_hint: "trigger-registry.ts:412"}
    confidence: 0.82
    usage: {input_tokens: 12400, output_tokens: 320, cost_usd: 0.041}
    request_id: "req_8c1f..."
  - agent_id: reviewer-b
    provider: openai
    model_id: gpt-5-2026-08-01
    model_id_resolved: gpt-5-2026-08-01
    prompt_hash: "sha256:44a0..."
    option_permutation: [B, C, A]
    option: A
    anchors:
      - {kind: case, anchor: "TC-GATE-118"}
    confidence: 0.71
    usage: {input_tokens: 11880, output_tokens: 290, cost_usd: 0.027}
    request_id: "req_2b7d..."
  - agent_id: reviewer-c
    provider: moonshot
    model_id: kimi-k2-2026-07-15
    model_id_resolved: kimi-k2-2026-07-15
    prompt_hash: "sha256:9d31..."
    option_permutation: [A, B, C]
    option: B
    anchors:
      - {kind: contract, anchor: "contracts/gates/trigger-registry.yaml#attach.triggers"}
    confidence: 0.55
    usage: {input_tokens: 12110, output_tokens: 410, cost_usd: 0.009}
    request_id: "req_77ac..."

statistics:
  raw_agreement: 0.67          # 原始一致率（辅指标）
  fleiss_kappa: 0.41           # 机会校正主指标（k=2 时为 null）
  gwet_ac1: 0.55               # 防 prevalence paradox，与 κ 并报
  anchor_overlap: 0.0          # 一致票之间的规范化符号锚点 Jaccard（0 = 各自引了不同证据）
  unanimous: false

decision: needs_verification   # confirmed | needs_verification | escalated_anchor_overlap
minority_report:               # 2:1 分裂时必填；无分裂为 null
  option: B
  reason: "workflow 节点进入也会触发门禁，attach.triggers 只是可选过滤器"
  anchors:
    - {kind: contract, anchor: "contracts/gates/trigger-registry.yaml#attach.triggers"}
created_at: 2026-09-24T14:09:38+08:00
```

### 6.2 字段与账本的映射

| VoteRecord 字段 | 写回账本条目 | 规则 |
|---|---|---|
| `vote_id` | `vote_record_id` | 稳定引用键，实验与审计脚本据此回查原始调用日志 |
| `decision_point.question` / `options` | `vote_record.decision_point` | 选项集必须与投票时完全一致（含兜底项），便于人事后复核"当时选的是一道什么题" |
| `votes[]`（含 `model_id` / `model_id_resolved` / `prompt_hash` / `option_permutation`） | `vote_record.votes` | 逐票留痕，可复现；缺任一项即视为该次投票不可复现 |
| `statistics` | `vote_record.statistics` | 一致度统计与 `anchor_overlap` 一并写回 |
| `decision` | `status` + `confidence_source` | `confirmed` → `status: confirmed` + `confidence_source: vote_agreement`；`needs_verification` / `escalated_anchor_overlap` → 条目保持 `provisional` |
| `minority_report` | `vote_record.minority_report` | 2:1 时必须非空；缺失即视为投票记录不合规 |

### 6.3 写回规则

1. **`confirmed` 且 `confidence_source: vote_agreement`**：投票记录**整体嵌入账本条目**的 `vote_record` 字段（k≤3、体积很小，嵌入的好处是 PR diff 评审时一次看全），同时事件流写入 `vote.completed` 事件；投票记录全文保留在 `votes/V-xxxx.yaml`，两处以 `vote_id` 对齐。
2. **`needs_verification`**：条目保持 `provisional`，`vote_record` 字段写入，并生成一道人工选择题推出——并列各票结论与锚点、标注少数派理由与分歧点。人裁决后再写 `human_confirmation` 或推翻事件。**原投票记录不得被裁决结果覆盖**（裁决是叠加的新证据，不是对投票数据的改写）。
3. **`escalated_anchor_overlap`**：同 2，并额外写入 `independence_flag: anchor_overlap`；该标记会阻止任何后续自动 confirmed 路径，必须人工处置。
4. **弃权票**：`option: C` 的票计入 `raw_agreement` 的分母，但不构成"一致"；全票弃权时不下判定，转人工补充事实与上下文。
5. 一切写回都经单一 `append_event` 路径进入账本（见 [`./04-consensus-ledger.md`](./04-consensus-ledger.md) §6.3），不允许投票编排器直接改 `ledger.yaml`。

---

## 7. 度量口径

### 7.1 为什么原始一致率不够

"k 票一致的比例"（原始一致率）是最容易算、也最容易骗人的指标：当多数决策点的人工结论都落在同一个高频选项上时（这在真实项目里是常态），即使 agent 完全随机，原始一致率也会接近 100%——这就是评分者一致性研究里的 **prevalence paradox**。方案的口径因此分三层：

| 指标 | 角色 | 说明 |
|---|---|---|
| **原始一致率** | 辅助 | 直观、可解释，但会被选项分布倾斜虚高 |
| **机会校正一致度（Fleiss' κ 主指标）** | 主 | 扣除随机一致后的真实一致性；k=3 用 Fleiss' κ，k=2 用人机对照的 Cohen's κ |
| **Gwet's AC1** | 与 κ **并报** | 用"期望不一致率"校正，对 prevalence paradox 稳健；不替换 κ，因为两者的校正哲学不同 |
| **一致但错率** | 直测风险 R-1（相关错误） | `|{投票一致 且 多数选项 ≠ 人工结论}| / |{投票一致的决策点}|`——这是唯一能直接量化"一致但同盲"的数字 |

个别条目缺票（某票弃权/失败）时改用 Krippendorff's α 兜底。

### 7.2 按难度分桶 + 与推翻率联合解读

固定健康区间（例如"一致率应在 70-90%"）没有文献依据，且一致率与任务难度强耦合——难题上一致率可以很高，但一致地错（§2.1）。因此口径改为：

- **按决策点难度分桶统计**（`easy` / `medium` / `hard`，分桶规则由实验一校准），分桶内再报 §7.1 的四个数；
- **与推翻率联合解读**：

| 一致度 | 推翻率 | 解读 |
|---|---|---|
| 高 | 低 | 唯一可称健康组合 |
| 高 | 高 | **危险**：一致地错（相关错误），收紧难度门与锚点独立度检查 |
| 低 | 低 | 可能是难度导致的正常弃权/分歧，检查是否该转人工而非投票 |
| 低 | 高 | 机制在正常暴露问题，重点看推翻原因分类 |

- **100% 一致在难题桶里是警报，不是健康信号**——它恰恰是相关错误的形态（模型集体自信地错）。这与"零推翻率是警报"（见 [`./04-consensus-ledger.md`](./04-consensus-ledger.md) §5.3）是同一种反直觉但必要的解读纪律：诚实优先于好看。

### 7.3 阈值初值（实验一校准）

| 判据 | 初值 | 含义 |
|---|---|---|
| 证据覆盖率 | **= 100%** | 硬门槛；达不到说明锚点机制有洞（回查 [`./04-consensus-ledger.md`](./04-consensus-ledger.md) §3.1、§4） |
| Fleiss' κ | ≥0.61 有效 / 0.41-0.60 勉强 / <0.40 机制需重设计 | 0.61 为评分者一致性"substantial"分级下限 |
| **一致但错率** | ≤10% 绿 / 10-20% 黄 / **>20% 红** | 红色 = 独立一致度不能单独支撑 confirmed，必须叠加人工兜底 |
| 人机 Cohen's κ | ≥0.60 | 投票结论可作为"人认可"的代理信号 |
| 锚点重合度阈值 | Jaccard ≥0.5 或子集关系 | 触发强制升级人工的初值 |
| 原始一致率 | 不作健康判据 | 仅描述性统计，分桶呈现 |

参照系：通用推理基准上实测"agreement ≥ 0.8 时仍有 48% 是错的"（arXiv 2607.08065）。上面的 ≤10% 阈值比该基准严格近 5 倍——实验一的意义正是在于实测"业务代码理解场景是否显著好于通用推理基准"。若实测落在 10%-48% 之间，说明本方案场景优势有限，风险 R-1 需要升级应对（例如提高人工兜底比例）。

### 7.4 实验一：这些数字怎么产生

实验一（共识机制回放，最高优先级实验）用已人工确认的历史决策集**盲跑**投票，产出 §7.3 的全部数字。本节只给结论性摘要，**可执行协议（决策集导出 schema、三组对照、脚本清单、阈值判绿/黄/红）见 [`./12-experiments.md`](./12-experiments.md)**：

| 项 | 设计 |
|---|---|
| 样本量 | 决策点 N ≥ 100（评分者一致性研究的经验法则为 50-100 subjects 起步） |
| 主配置 | k=3（Fleiss' κ 的最低 rater 数，且可实测 2/3 放行规则） |
| 对照组 | G1 同构（同模型 × 3 异角色提示词）/ G2 异构（跨家族 × 3）/ G3 单 agent 强模型——G3 是"无投票基线"，用于量化投票的净增益 |
| 盲跑协议 | 只读 worktree 锁定 commit；每票独立进程；禁止看到人工结论、他人输出、`最终状态`/`推翻原因`/确认人信息；选项顺序 per-agent 随机置换；temperature=0；记录 prompt hash / 模型 id / permutation |
| 脱敏 | 代码不导出，只导出锚点 + commit，agent 在隔离环境 checkout 后自读；业务实体用占位符映射，映射表不进实验包 |
| 核心统计 | 原始一致率、Fleiss' κ、Gwet's AC1、**一致但错率**、人机 Cohen's κ、**证据锚点重合度**（对齐 2607.08065 的条件一致率测量逻辑） |
| 工具 | 决策集导出校验 → 只读快照构建 → 盲跑执行 → 盲评合规审计 → 打分 → 报告生成（六个脚本，串成一条流水线） |
| **口径限制** | 推翻率是纵向指标（观察期内 confirmed → overturned），**回放实验测不了真正的推翻率**；回放只能出历史 `overturned` 构成比（描述性统计），不得当作平台运行指标使用 |

实验报告产出后，本节所有阈值与 §2.3 的软信号规则一并校准。

---

## 8. 参考文献

### 8.1 机制证据（投票 vs 辩论、相关错误、异构、难度门）

| # | 文献 | 年份 | 结论一句话 |
|---|---|---|---|
| 1 | [Self-Consistency Improves Chain of Thought Reasoning](https://arxiv.org/abs/2203.11171)（Wang et al., ICLR 2023） | 2023 | 同一模型采样 + 多数投票在可机判答案任务上显著提升（GSM8K +17.9pp）；有效性前提是"答案可自动判定 + 采样独立" |
| 2 | [Improving Factuality and Reasoning in Language Models through Multiagent Debate](https://arxiv.org/abs/2305.14325)（Du et al., ICML 2024） | 2024 | 多 agent 辩论在数学/策略/事实任务上可提升准确率——辩论有效的正面证据，但成本更高 |
| 3 | [Encouraging Divergent Thinking in LLMs through Multi-Agent Debate](https://arxiv.org/abs/2305.19118)（Liang et al.） | 2024 | 异质角色提示的辩论有提升效果 |
| 4 | [Should we be going MAD?](https://arxiv.org/abs/2311.17371)（Smit et al., ICML 2024） | 2024 | 系统 benchmark：多 agent 辩论现状形态**不能稳定跑赢** self-consistency / 多路径集成，且对超参敏感 |
| 5 | [Which Yields Better Decisions in Multi-Agent LLMs?](https://arxiv.org/html/2508.17536v1)（NeurIPS 2025） | 2025 | 理论证明：辩论使 agent 信念轨迹成为鞅，**本身不改善期望正确率** |
| 6 | [Mixture-of-Agents Enhances LLM Capabilities](https://arxiv.org/abs/2406.04692)（Wang et al.） | 2024 | 异构模型分层聚合在 AlpacaEval 2.0 超过 GPT-4o；注意其为"综合式"聚合 |
| 7 | [More Agents Is All You Need](https://arxiv.org/abs/2402.05120)（Li et al.） | 2024 | 纯采样 + 投票的收益随 agent 数呈幂律并**饱和**（15-20 后趋平），支持小 k |
| 8 | [Correlated Errors in Large Language Models](https://proceedings.mlr.press/v267/kim25e.html)（Kim et al., ICML 2025） | 2025 | 350+ 模型实证：两个模型都答错时 **60% 错在同一答案**；跨架构、跨供应商相关性依然显著，模型越大越准相关性越强 |
| 9 | [Multi-LLM Debate: Framework, Principals, and Interventions](https://proceedings.neurips.cc/paper_files/paper/2024/hash/32e07a110c6c6acf1afbf2bf82b614ad-Abstract-Conference.html)（Estornell & Liu, NeurIPS 2024） | 2024 | 贝叶斯框架证明 echo chamber / 多数暴政：多数派共享错误观念时少数派会顺从；异构、匿名化、强制反驳是有效干预 |
| 10 | [Minority Sentinel](https://arxiv.org/abs/2606.29270)（He et al.） | 2026 | 3 个异构 agent 中 **39.1% 出现 2:1 分裂，其中 25.5% 少数派正确**；多数规则存在约 10pp 可回收错误率 |
| 11 | [When Self-Consistency Backfires](https://arxiv.org/abs/2608.11403)（Bahuguna et al.） | 2026 | 预注册研究：GPQA Diamond 难题上多数投票使 **56.6% / 65.7%** 的题目准确率反而下降——难题上模型一致趋向错误答案 |
| 12 | [LLM Evaluators Recognize and Favor Their Own Generations](https://arxiv.org/abs/2404.13076)（Panickssery et al., NeurIPS 2024） | 2024 | LLM 评委系统性偏爱自己模型的输出（self-preference bias），人类评审认为两者等质 |
| 13 | [Self-Preference Bias in LLM-as-a-Judge](https://arxiv.org/abs/2410.21819)（Wataoka et al.） | 2024 | 自评偏置的机制解释（与困惑度/熟悉度相关） |
| 14 | [DEI: Diversity in Evolutionary Inference](https://arxiv.org/abs/2605.27130) | 2026 | 等预算下**异构集成全面优于同构**——收益来源是模型多样性而非并行度 |
| 15 | [The Selection Bottleneck in Multi-Agent LLM Pipelines](https://www.mdpi.com/2076-3417/16/10/4914)（MDPI） | 2026 | 聚合方式决定异构收益方向：投票式聚合利异构，综合式聚合可能利同构 |
| 16 | [匿名化缓解身份偏置](https://arxiv.org/html/2510.07517v1) | 2025 | 辩论中模型倾向偏袒同 backbone 一方，**匿名化可缓解** |
| 17 | [Semantic Entropy / Detecting Hallucinations](https://www.nature.com/articles/s41586-024-07421-0)（Farquhar et al., Nature） | 2024 | 采样一致性类方法能检测"模型不确定"，但**检测不到"一致的错误"**——独立真值源才是兜底 |

### 8.2 统计方法学与工程先例

| # | 文献/来源 | 年份 | 用途 |
|---|---|---|---|
| 18 | [When LLMs Agree, Are They Right?](https://arxiv.org/abs/2607.08065) | 2026 | "一致 ≠ 正确"的直接实证：agreement 与 correctness 相关性仅 rho 0.20-0.59；agreement ≥0.8 时 48% 错；跨 provider 相关错误复现 |
| 19 | [MAST: Why Do Multi-Agent LLM Systems Fail?](https://arxiv.org/abs/2503.13657)（UC Berkeley） | 2025 | 7 框架 1600+ 轨迹、14 种失败模式；自由互聊是"agent 间错位"类失败高发区，支撑"不辩论 + 结构化中介" |
| 20 | [High Agreement and High Prevalence: The Paradox of Cohen's Kappa](https://pmc.ncbi.nlm.nih.gov/articles/PMC5712640/)（Zec） | 2017 | prevalence paradox：多数判进同一类别时原始一致率虚高、κ 被压低——主指标必须机会校正 |
| 21 | [Gwet's AC1 is not a substitute for Cohen's kappa](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC10205778/) | 2023 | AC1 与 κ 的校正哲学不同，应**并报**而非替换 |
| 22 | [A Tutorial on Sample Size Calculation for Inter-rater Agreement Studies](https://pmc.ncbi.nlm.nih.gov/articles/PMC12935580/) | 2024 | kappa 研究样本量经验法则：50-100 subjects 起步，支撑 N ≥ 100 |
| 23 | [Fleiss' Kappa 教程与分级](https://statisticsbyjim.com/glossary/fleiss-kappa/)（Landis–Koch "substantial" 下限 0.61） | — | κ ≥0.61 作为"有效"阈值的来源 |
| 24 | [RefactoringMiner](https://github.com/tsantalis/RefactoringMiner) / [difftastic](https://github.com/Wilfred/difftastic) / [`.git-blame-ignore-revs`](https://git-scm.com/docs/git-blame) | — | 锚点重锚定与格式化豁免的工程先例（详见 [`./04-consensus-ledger.md`](./04-consensus-ledger.md) §4） |
| 25 | [Claude Code headless 文档](https://code.claude.com/docs/en/headless) | 2025 | coding CLI 的程序化调用面（生成侧执行器）与无法锁温度/版本的边界（投票侧否决 CLI 的依据） |
