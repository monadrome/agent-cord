# ADR-0018 ｜ 工作流 DSL 与编排内核的实现选型：自研 DSL + CEL 端口隔离 + 薄执行器/XState

- 状态：accepted（设计定稿，M2 薄执行器已实现；CEL/XState 集成待实现）
- 日期：2026-09-24
- 关联：ADR-0014（工作流与门禁定义语言——本 ADR 落地其实现选型，不改动「apiVersion YAML + 三级校验器」的形态决策）、ADR-0010（SSOT 存储——编排内核的恢复语义建立在事件流之上）、ADR-0019（外部校验器插件协议）
- 来源：开源实现调研（2026-09-24，[docs/research/2026-09-24-01](../research/2026-09-24-01-orchestration-workflow-engines.md) 与 [docs/research/2026-09-24-05](../research/2026-09-24-05-gate-dsl-cel-policy-plugins.md)）；2026-09-24 人工拍板

## 背景

ADR-0014 定了定义语言的形态（`apiVersion` 化 YAML + 内置枚举 / CEL / 外部插件三级校验器），并明确「不引入分布式工作流运行时」。2026-09-24 的调研把三个实现层问题推到了必须拍板的位置：

1. **DSL 语法：自研还是采纳现成标准？** CNCF Open Workflow Specification（OWS，原 Serverless Workflow）是现成的 YAML 工作流 DSL 标准，内置 DAG、并发、生命周期事件词表、`use` 复用容器，表达式语言槽位可插拔（默认 jq）——但它是服务编排导向，无 gate/圆桌语义，官方 TS SDK 仍是 alpha。
2. **CEL 求值器选谁？** CEL 官方组织（cel-spec）没有 JS 实现，TS 生态全是第三方实现；其中旧 `cel-js` 仓库已归档，其余多为停滞或个位数 star。这是本项目最大的单点依赖风险之一。
3. **编排内核用什么执行？** 调研确认：所有成熟引擎（Temporal / Restate / Hatchet / DBOS / Inngest / Trigger.dev / Conductor / Kestra）都把执行状态存在自己的库或服务里，与「纯文件 + git 为唯一 SSOT」直接冲突；允许外部状态源的只有 4 个（Vercel Workflow SDK 的 World 适配器、LangGraph 自定义 Checkpointer、Mastra 自定义 storage、XState 的普通对象 snapshot）。

## 备选方案

### 维度一：DSL 语法

- **A. 自研（沿用 ADR-0014 的 schema 方向）**：gate/节点/触发器字段完全自主；借鉴 OWS 的两份资产——生命周期事件词表（Workflow/Task Started/Suspended/Resumed/Cancelled/Faulted/Completed，直接对齐 `events.jsonl` 事件命名）与 `use` 复用容器结构（functions/retries/errors 的复用声明）。
- **B. 采纳 OWS 为基底**：白拿 DAG/并发/超时/重试/子流程的语义与 CTK 一致性测试套件；但 gate = 角色×时机×校验×放行条件、投票、升级语义都要自行扩展，且 TS SDK 是 alpha 不能当稳定依赖，表达式语言默认 jq 需换 CEL。

### 维度二：CEL 求值器

- **a. `@marcbachmann/cel-js`**（MIT，v8，活跃，零依赖）：支持 `env.check()` 编辑期类型检查、自定义函数/类型、AST 限制（防表达式炸弹）；用原生 RegExp（有 ReDoS 面）。
- **b. `@bufbuild/cel`**（Apache-2.0，beta）：RE2 正则（对第三方表达式更安全）、Buf 公司背书；但 beta、采用度低。
- **c. jsonata / json-logic-js / 自研子集**：偏离 ADR-0014 已定的 CEL 选型，不展开。

### 维度三：编排内核

- **i. 自研薄执行器 + XState v5**：执行器 = 读 YAML 图 → 拓扑推进 → 每节点追加事件 → 恢复时按事件流扫点跳过已完成节点（几百行）；gate 与节点的状态机语义用 XState v5 承载（snapshot 是普通对象，天然可进 git）。DAG 图算法用 `@dagrejs/graphlib`。
- **ii. Vercel Workflow SDK 自定义 World**：唯一把持久层显式抽象为可替换适配器的引擎（Apache-2.0），理论上可写「World over cord 目录 + git」；但需接入其编译链（SWC 指令），对「库 + daemon」形态有额外摩擦，且 step 事件日志仍是引擎形态数据。
- **iii. Mastra / Temporal 等引擎**：Mastra 需把 YAML 编译为其代码式工作流且状态归其 storage；Temporal 等的 Event History 就是状态源、不允许外部 SSOT——均与文件 SSOT 冲突。

## 决策

**DSL 自研（维度一 A）；CEL 单选 `@marcbachmann/cel-js` 并藏在端口后（维度二 a）；编排内核 = 自研薄执行器 + XState v5（维度三 i）。Vercel Workflow SDK 的自定义 World 保留为 spike 兜底，不押注。**

1. **DSL 自研，但借 OWS 两份资产**：生命周期事件词表（与 `events.jsonl` 的事件命名对齐）与 `use` 复用容器结构；不引入 OWS 规范依赖、不采用其 jq 表达式槽位。
2. **CEL 求值器端口隔离**：定义窄端口 `ExpressionEvaluator { check(expr, decls), eval(expr, vars) }`，默认实现为 `@marcbachmann/cel-js`；用 `@bufbuild/cel-spec`（Apache-2.0，含 CEL 官方测试数据）做一致性回归测试，保证求值器可整体替换。
3. **编排内核自研**：读图 → 拓扑推进（`@dagrejs/graphlib`）→ 节点状态机（XState v5）→ 每节点追加事件 → 恢复时按事件流扫点；XState snapshot 以普通对象落盘进 git。
4. **Workflow SDK World 的 spike 仅验证一件事**：durability 后端能否落在 cord 目录 + git 而无编译链侵入；spike 结论若翻案需新 ADR。

## 理由（第一性原理推导）

1. **SSOT 归属决定编排内核必须自研**。所有成熟引擎的状态都归引擎；本项目的状态必须归 git 文件。这不是功能差距而是所有权冲突，没有任何适配层能消除——因此内核自研不是「造轮子」，而是 SSOT 决策（ADR-0010）的直接推论。调研同时确认：这层是被高估的难点，拓扑排序 + 并发闸门 + 事件落盘合计几百行。
2. **DSL 的消费者是人和协调 agent**（ADR-0014 理由 1）。OWS 的语法覆盖面（服务编排的 call/run/listen）远超本项目需求，采纳它意味着永远带着一个不对口的概念包袱；但它的**事件词表**是多家引擎收敛出的公共词汇，自造一套只会增加用户的认知成本——借词表不借规范，是成本最低点。
3. **CEL 无官方 JS 实现 = 必须假设求值器会被替换**。单维护者库、beta 库都有各自的死法；唯一正确的姿势是把求值器藏在窄端口后，并用官方一致性测试数据把「正确」的定义与实现解耦。
4. **gate 状态机用 XState 而非自写**：gate 的「角色×时机×校验×放行」天然是状态机（guard/event/context），XState 是零依赖纯库、snapshot 可进 git、有可视化 tooling；它缺的 durability 本来就在自研内核层。

## 被否方案的否决理由（逐一）

- **采纳 OWS 为基底**：否决于概念包袱（服务编排导向、无 gate 语义）+ TS SDK alpha 不能当依赖；仅借事件词表与 `use` 结构。
- **`@bufbuild/cel` 作为主选**：beta + 低采用度；其 RE2 优势通过「CEL 输入可信性分级」（见注意点 3）弥补，保留为端口后的可替换实现。
- **Vercel Workflow SDK 作为主内核**：编译链侵入 + 事件日志形态与 `events.jsonl` 不一致；降级为 spike 兜底。
- **Mastra / Temporal / Restate / Hatchet / DBOS / Inngest / Trigger.dev / Conductor / Kestra**：状态归引擎，与文件 SSOT 冲突（Inngest 另有 SSPL、Restate 另有 BSL 许可问题）；Temporal approval pattern 等语义仅作设计参照（ADR-0014 已吸收）。
- **自研 CEL 子集 / 换 jsonata**：推翻 ADR-0014 已定选型且无收益。

## 关键实现注意点

1. **CEL 的 int 是 BigInt，JSON 无 int64**：约定 int64 在边界处字符串化（k8s 同款做法），写进 `ExpressionEvaluator` 端口契约。
2. **`@marcbachmann/cel-js` 默认 `unlistedVariablesAreDyn: false`**：gate YAML 里用到的变量必须显式注册声明；字段定义 → CEL 类型声明的自动生成属自研范围。
3. **ReDoS 面分级处理**：gate YAML 是仓库内可信输入（走门禁评审），风险可接受；若未来接受第三方 workflow pack（模板市场），表达式需经 AST 限制（`limits: { maxAstNodes, maxDepth }`）与超时双重约束，或切换到 RE2 实现。
4. **恢复语义**：执行器恢复 = 读 `events.jsonl` 扫点，跳过已完成节点；借鉴 LangGraph interrupt 的反面教训（恢复时节点从头重跑、多 interrupt 索引匹配）——本项目的恢复单位是节点，节点内副作用必须幂等。
5. **XState 无 durability 与定时器落盘**：gate 超时（`timeout.after`）的计时器状态由执行器写事件流持有，不依赖 XState 内存定时器。
6. **OWS 词表映射表**：DSL 文档中维护一张「cord 事件类型 ↔ OWS 生命周期事件」对照表，新增事件类型走 ADR（沿用 ADR-0012 注意点 10 的封闭枚举原则）。

## 证据来源

1. 开源实现调研归档（2026-09-24）：[docs/research/2026-09-24-01-orchestration-workflow-engines.md](../research/2026-09-24-01-orchestration-workflow-engines.md)（19 个引擎逐项评估、BYO-state 仅有 4 个）、[docs/research/2026-09-24-05-gate-dsl-cel-policy-plugins.md](../research/2026-09-24-05-gate-dsl-cel-policy-plugins.md)（CEL 实现对比、OWS 评估、k8s/Kyverno/Cerbos 同构先例）
2. CNCF Open Workflow Specification 与 DSL 参考：https://github.com/open-workflow-specification/specification （Apache-2.0）
3. `@marcbachmann/cel-js`：https://github.com/marcbachmann/cel-js （MIT）；CEL 官方测试数据：https://github.com/bufbuild/cel-es （`@bufbuild/cel-spec`，Apache-2.0）
4. XState 持久化（snapshot 为普通对象）：https://statelyai.com/docs/persistence
5. Vercel Workflow SDK 自定义 World：https://github.com/vercel/workflow （Apache-2.0）
6. 「YAML 声明式工作流 + HITL + checkpoint」的最完整参照（仅借思路）：Microsoft Agent Framework Declarative Workflows https://learn.microsoft.com/en-us/agent-framework/workflows/declarative ；Conductor OSS HUMAN task https://conductor-oss.github.io/conductor/documentation/configuration/workflowdef/systemtasks/human-task.html
