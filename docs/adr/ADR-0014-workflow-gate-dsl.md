# ADR-0014 ｜ 工作流与门禁定义：apiVersion 化 YAML + 三级校验器

- 状态：accepted（设计定稿，代码未实现）
- 日期：2026-09-24
- 关联：ADR-0002（默认轻量 + 触发式升级）、ADR-0004（命令降级为门禁触发入口）、ADR-0016（插件三层与能力清单）
- 补充：ADR-0018（DSL/CEL/编排内核实现选型落定，2026-09-24 拍板）、ADR-0019（第 3 级校验器插件协议 = MCP）
- 来源：本方案技术选型调研（2026-09，内部调研纪要）——工作流与门禁的定义语言；吸收配套调研（2026-09）Q5 的 schema 草案、防退化条款、9 类触发器与三态语义

## 背景

本项目的流程骨架是**预定义的有向图**：节点 = 阶段（进入 → 共识 → 计划 → 执行 → 验证 → 防腐 → 上线回流），节点上挂门禁（gate = 角色 × 时机 × 校验 × 放行条件），节点出口有里程碑文档（随快照文件夹 git 版本化）。

定义语言要同时满足五条硬约束：

1. **新增 gate / agent 零代码**（验收标准明文要求，纯配置）；
2. **防退化**：命令只是门禁的触发入口字段，平台不存在独立命令；
3. **校验可插拔**：门禁校验逻辑由团队自定义（CI、测试、截图比对、LLM 评审都可能成为校验器），且**校验执行体与流程编排分离**；
4. **图是低频、人审的；校验逻辑是高频、多变的**——这个不对称是选型的核心变量；
5. **SSOT 是快照文件夹**：流程定义本身就是 git 仓库里的资产，LLM（协调 agent 与人）都要能读写它。

## 备选方案

### 备选 A：纯 YAML schema（CI 平台风格）

- **是什么**：一张 YAML 描述 DAG（节点、依赖、触发器、条件），节点上挂 step，`step = 执行体 + 条件 + 失败语义 + 输出`。
- **优点**：LLM 与人都最熟练的格式；diff / 评审友好（git 天然适配快照文件夹）；成熟的事件触发器 + 条件 + 三态失败语义模型经过十年生态验证；模板/复用/组织级强制的形态可直接借鉴。
- **缺点**：YAML 无类型、无抽象能力（社区长期抱怨无法抽取公共逻辑、无法类型检查）；**轻量校验条件**（例如「diff 行数超阈值才升级」）若每次都要写外部脚本插件，摩擦过大，实践中会逼出两种劣化：内嵌脚本文符串（回到代码即配置）或干脆放弃校验。
- **契合度**：高，是骨架的正确选择，但单独作为唯一表达不够。

### 备选 B：通用配置语言 DSL（CUE / KCL / Pkl / Jsonnet）

- **是什么**：带类型、约束、合并语法的配置语言，schema 与数据合一。
- **优点**：静态校验强、可消除一大类配置错误；多环境覆盖/合并是强项。
- **缺点**：学习成本高，且**协调 agent 也是配置的生产者**——LLM 生成这类约束求解式配置的出错率显著高于 YAML；生态绑定特定基础设施领域，在协作流程领域无先例；引入一门 DSL 与「不绑定特定厂商」的开源定位有张力；对「防退化」问题没有提供超出 YAML 的结构（约束 ≠ 编排）。
- **契合度**：低。它解决的是「配置写错」，而我们的主要风险是「流程退化成命令堆积」，诊断错配。

### 备选 C：代码即配置（Temporal / Dagger / Starlark 风格）

- **是什么**：用通用编程语言写工作流代码，引擎保证持久化与恢复。
- **优点**：图灵完备，复杂分支、动态节点、跨系统编排无表达力上限；其 **approval pattern**（提议 → 挂起 → 人 Signal → 恢复、等待期间零资源、审批记录持久化）与本项目的门禁等待模型完全同构——**在执行语义层面它是最接近的先例**。
- **缺点**：三个致命伤——(1) 新增 gate 需要改代码，**直接违反零代码验收标准**；(2) 图拓扑藏在代码控制流里，人和协调 agent 无法快速审阅「当前流程长什么样」，与快照文件夹 SSOT 的审阅文化冲突；(3) 把编排和校验焊死在同一语言运行时。
- **反向流动的事实**：业界正在出现「为工作流引擎造 YAML DSL」的项目与官方收录的 YAML DSL，理由是「原型迭代快、数据而非代码、非工程师可编辑」——正是我们场景（群里的人改流程）的诉求。
- **契合度**：作为整体方案否决；其**执行语义**被吸收进实现架构。

### 备选 D：混合——YAML 声明骨架 + 三级校验器机制（选定）

- **是什么**：DAG、节点、gate、触发器、写回目标、权限全部用带 `apiVersion` 的 YAML 声明；`check.ref` 按名引用校验执行体，**校验器分三级注册**：
  1. **内置校验器枚举**（模板预置：单测通过、CI 绿、锚点存在、投票一致且锚点独立等）；
  2. **CEL 表达式**：`check.cel: "diff.added_lines <= 500"` 级别的轻量条件免插件（CEL 已被主流容器编排平台作为资源校验与准入策略的标准嵌入式表达式语言）；
  3. **外部校验器插件**（进程 / HTTP）：重逻辑（调 CI、跑截图比对、LLM 评审 agent）按名注册，`check.ref: screenshot-diff@1`。
- **优点**：零代码新增 gate 的承诺精确兑现——**gate 注册表与 checker 注册表是两个表**：新增 gate = 纯 YAML 组合已有 checker + 触发器；只有引入「新种类的校验逻辑」才碰第 3 级插件代码，而那是插件作者的职责，不是流程使用者的。表达力缺口由 CEL（条件）和插件（执行）两级补齐，YAML 不内嵌脚本，保持防退化结构。这与「策略决策与执行解耦」的成熟原则同构。
- **缺点**：三种校验级别增加实现面；CEL 沙箱（无 IO、纯函数、超时）要做对；外部插件的输入输出契约需严格定义。
- **契合度**：最高。

## 决策

**采用备选 D：`apiVersion` 化的 YAML 声明骨架 + 内置枚举 / CEL / 外部插件三级校验器。**

1. **gate 与 checker 双注册表**：`gates/*.yaml`（编排）与校验器能力清单（输入类型、输出三态、超时、所需权限）分开。新增 gate 零代码；新增 checker 类型是开发动作，走与新增 agent 相同的注册制。
2. **门禁四要素 + 三个防退化字段**：角色（`role`）、时机（`attach`，含触发器）、校验（`checks`）、写回（`write_back`，封闭枚举：`consensus_ledger` / `session_event` / `doc_block_draft` / `knowledge_entry`），加结果语义（`pass` / `on_fail`）、超时（`timeout`）、最小权限声明（`permissions`）。**字段级权威定义见 [docs/06-gates-workflow.md](../06-gates-workflow.md)，下面的示例仅示意形态**：

```yaml
apiVersion: agent-cord.dev/gates/v1
kind: Gate
metadata: { id: contract-check, name: 契约校验 }
spec:
  role:                              # 角色要素
    initiators: [backend, test]      # 可加 coordinator
    approvers: [architect]           # prevent self-review：与 initiators 不重叠
  attach:                            # 时机要素
    node: plan                       # 七步流程节点 id
    when: post                       # pre = 节点前；post = 节点出口
    triggers: [contract.touched, vote.split, anchor.drifted]
  checks:                            # 校验要素：三级混合，全部按名引用或纯表达式
    - ref: contract-validator@official
    - cel: "diff.added_lines <= 500"
  pass: { require: all, human_confirm: true }
  on_fail: block                     # block | warn | escalate
  write_back: [consensus_ledger]     # 封闭枚举
  link_entry: auto                   # 写回必须回链共识条目 id
  escalate:                          # on_fail: escalate 时的后续动作
    to: heavy-contract-review
    approve_by: [architect]          # 提议人不能自批
  permissions: { write: [consensus_ledger] }
  timeout: { after: 24h, on_timeout: escalate_human }
```

3. **门禁结果三态**：`pass` / `block` / `warn-and-continue`（warn 必须留痕）。
4. **门禁超时按「升级人工」处理**，不允许静默放行，也不允许无限挂起。
5. **里程碑文档 = 节点产物声明**：节点定义用封闭枚举声明出口产物（prd.md / adr.md / plan.md / findings.md …）；执行期临时产物归事件流，禁止晋升为长期文档。
6. **防退化条款**：平台不注册独立命令，命令是 gate 的字段；状态与顺序由 session 状态机持有，群消息只是 Signal 通道。
7. **引擎不引入分布式工作流运行时**：本项目是「协作流程」不是长事务，session 事件溯源 + 显式状态机足够；Temporal 的挂起/恢复语义被吸收为设计参考，不引入其运行时。

## 理由（第一性原理推导）

1. **谁在读/写这份定义？** 三类消费者：人（评审流程变更）、协调 agent（读写快照、路由）、引擎（执行）。其中两个是 LLM。对 LLM 生成与审阅最友好的结构化格式是带 JSON Schema 校验的 YAML——这是从约束 1/4 推出的，而非从众。
2. **什么东西变化频率不同？** 流程拓扑（七步骨架）是季度级变化、需要群里可评审；校验逻辑是周级变化、需要工程能力。Temporal 用「Workflow 持有编排 / Activity 是执行体」分离二者，CI 平台用「step 的执行体与条件分离」分离二者——两个独立收敛的系统给出同一结构，说明**编排与执行必须分文件、分注册表**。代码即配置把两者焊死，通用 DSL 只约束不编排，故均否决。
3. **「零代码」到底承诺什么？** 精确化后它不是「平台永不需要代码」，而是「**流程使用者**新增/修改 gate 不需要代码」。解法是把「校验逻辑」从「gate 编排」中剥离为独立注册表：gate YAML 只含 `check.ref` 引用。此时零代码承诺在操作闭包上成立——新增 gate 的操作闭包不含代码。
4. **表达力缺口怎么补最省？** 轻量条件（阈值、路径 pattern、字段比较）是高频小需求，走外部插件是杀鸡用牛刀且破坏零代码体验；CEL 是被准入链验证过的嵌入式纯表达式语言，无 IO、可沙箱、LLM 生成可靠性高，正好填这个档位。重型执行走外部插件（HTTP / 进程），与现有工具链（CI、截图比对、Code Review）天然对接。
5. **从「引擎持有状态」反推**：门禁的等待与恢复必须由状态层（session）持有，群消息只是 Signal 的传输载体；审批校验必须在执行层强制，不能依赖 agent 主动调用审批步骤——否则「绕过门禁」就是一次漏调。这条决定了 gate 必须有 `permissions` 声明与引擎侧校验，而不是靠流程文档规定。
6. **从「schema 必须能演进」反推**：流程定义是长期资产，而 gate 字段会随实验校准变化。必须从一开始就带 `apiVersion`、有 JSON Schema、有版本兼容策略——否则第一次字段变更就会迫使全域迁移。

## 被否方案的否决理由（逐一）

- **备选 B（通用配置语言 DSL）**：否决于诊断错配——它防「配置写错」，我们不防这个（JSON Schema 足够）；对 LLM 生产者不友好；生态窄；不提供编排结构增益。
- **备选 C 全量代码即配置**：直接违反「新增 gate 零代码」验收标准；图不可快速审阅，违背快照文件夹的评审文化；业界反向 YAML 化的证据表明此路作为「唯一表达」不对。**注**：其执行语义（挂起/恢复/Signal/审批持久化）被采纳为实现架构参考，否决的只是「用代码定义流程图」。
- **备选 A 纯 YAML（无 CEL、无插件分级）**：轻量校验条件被迫写成脚本文符串或外部插件，实践中必然劣化；只作为子集保留。
- **「markdown 工件链 + 斜杠命令驱动」的规格驱动开发形态（每阶段一文件一命令）**：不构成流程定义语言的有效备选——它适合单 agent 单需求，但无节点依赖、无门禁挂载点、无升级触发器，不支持「预定义有向图 + 节点挂 gate」；只能借其模板分档思想。
- **「YAML 内嵌 shell 脚本作为校验」**：否决于重新引入代码即配置的耦合，且脚本无法被审计与权限约束（会同时破坏防退化与最小权限两条）。
- **「命令作为一等公民」**：否决于退化路径——命令必须降级为门禁的触发入口字段，门禁才持有状态、时机与写回目标（ADR-0002、ADR-0004）。
- **「引入 Temporal 作为执行引擎」**：否决于固定建设成本与运维面——本项目的流程是协作流程而非长事务，session 事件溯源已提供持久化与恢复；为一个 DAG 引入分布式运行时，成本远超收益。

## 关键实现注意点

1. **gate 与 checker 双注册表**：`gates/*.yaml`（编排）与校验器清单（能力声明：输入类型、输出三态、超时、所需权限）分开维护；新增 gate 零代码，新增 checker 类型走注册制。
2. **CEL 沙箱红线**：只读输入（diff 元数据、条目字段、触发器证据），禁 IO、禁随机、超时限制（如 50ms 量级）；**CEL 只做判定不做执行**，执行一律经外部插件。
3. **外部校验器契约**：输入 = session 快照引用 + 触发器命中证据（携带触发器 id，防「人一律点确认」的确认疲劳）；输出 = `{result: pass|block|warn, anchors: [...], reason: 结构化文本, confidence}`；`warn` 必须留痕。
4. **schema 版本演进**：每个定义文件头部带 `apiVersion`；仓库内置 JSON Schema（`additionalProperties: false`，未知字段拒绝加载）；非破坏性变更走 v1 内字段新增，破坏性变更升 v2 并提供迁移脚本；**引擎同时接受 N 与 N-1 两个 apiVersion**。
5. **里程碑文档必须在节点定义中显式声明**（封闭枚举），与工件总表对齐；未声明的产物类型不允许写入快照层。
6. **门禁配置自身的变更要走门禁**：修改 `gates/*.yaml` 的提交命中「流程定义」敏感路径，自动挂重型 gate，并强制 **prevent self-review**（改 gate 的人不能自批），防 agent 自改流程自放行。
7. **超时与权限**：门禁挂起超时策略默认为「升级人工」；`permissions` 按 gate 声明最小写权限，同一插件在不同 gate 下可获得不同凭证。
8. **触发器清单必须声明式且可穷举**（9 类：契约变更、跨仓库边界、高风险验证信号、投票分歧、推翻率高的知识区域、需求中途变更、敏感路径清单、diff 规模超阈值、锚点失效）；每次升级提议必须携带触发器 id + 命中证据。
9. **模板分档**：平台提供轻量/标准/严格三档默认配置，团队可覆盖字段，组织可声明不可覆盖的最低集。
10. **与插件的接缝是能力清单**：配置层只写 `validator: <能力名>@<插件>` + 参数；宿主按插件声明的能力清单在**加载期**校验引用是否存在、参数 schema 是否匹配——这是「零代码新增 gate」成立的结构性前提（详见 ADR-0016）。

## 证据来源

1. 本方案技术选型调研（2026-09，内部调研纪要）：备选 A–D 对比、推荐推导链五步、被否理由汇总、8 条实现注意点。
2. 门禁 schema 草案、防退化条款、9 类触发器、三态语义（一手）：配套调研（2026-09）Q5。
3. CI 平台工作流语法（事件触发器 / 条件 / 三态失败语义 / 最小权限 / starter 与 reusable workflows）：https://docs.github.com/actions/reference/workflow-syntax-for-github-actions ；社区关于「只有 YAML 的缺点」讨论 https://github.com/orgs/community/discussions/15904 ；Environments 审批门禁与 prevent self-review 实践 https://sph.sh/en/posts/github-environments-approval-gates/
4. Temporal approval pattern（挂起/恢复/Signal/审批持久化，本项目吸收其语义）：https://docs.temporal.io/design-patterns/approval ；human-in-the-loop AI cookbook https://docs.temporal.io/ai/cookbook/human-in-the-loop-python ；反向 YAML 化的证据：官方 YAML DSL 收录 https://temporal.io/code-exchange/temporal-dsl ；为工作流引擎造 YAML DSL 的理由 https://zigflow.dev/articles/why-i-built-a-yaml-dsl-for-temporal-workflows/
5. 代码派观点（用于双向权衡）：https://dev.to/vito/why-i-joined-dagger-43gb
6. CEL 作为嵌入式校验表达式语言：https://kubernetes.io/docs/reference/using-api/cel/ ；KEP-2876 CRD 校验表达式 https://github.com/kubernetes/enhancements/blob/master/keps/sig-api-machinery/2876-crd-validation-expression-language/README.md ；实践分析 https://blog.howardjohn.info/posts/cel-is-good/
7. CRD 多版本演进与兼容策略（N / N-1 兼容的依据）：https://kubernetes.io/docs/tasks/extend-kubernetes/custom-resources/custom-resource-definition-versioning/ ；https://blog.howardjohn.info/posts/crd-versioning/
8. 策略决策与执行解耦（checker 注册表设计原则佐证）：https://www.wiz.io/academy/application-security/open-policy-agent-opa
9. 通用配置语言的生态位（CUE / KCL / Pkl 对比讨论）：https://github.com/apple/pkl/discussions/7
10. 阶段×工件总表与里程碑文档清单（节点出口产物声明的依据）：配套调研（2026-09）Q10。
11. 项目内部：方案提案 §4.3（流程门禁、触发式升级，对应本文 R10/R11）、§7.A（gate 定义最小 schema 草案）；工作清单 W1.2（Gate 节点定义与编排：新增 gate 零代码）、R10（当流程到达配置了门禁的节点时，系统必须执行对应校验并按结果放行/拦截/升级）。
