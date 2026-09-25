---
title: 多 agent 编排与工作流引擎
date: 2026-09-24
type: research-archive
status: 调研结论均为 2026-09-24 当日实测，时效性敏感（star 数、版本、license 可能变化）
---

# 多 agent 编排与工作流引擎调研报告

面向 agent-cord 的「有向图工作流 + 节点 gate + 人工审批暂停点 + 文件系统为 SSOT（git）」需求。

调研时间：2026-09-24。所有 star/license/提交时间均为当日通过 GitHub API 与 npm registry 实测所得（未认证 API 在调研后期被限流，Conductor / Kestra / wake 的精确 star 数未能取到，已在下文标注）。

---

## 一、结论速览

1. **没有任何一个引擎直接满足 agent-cord 的组合需求**（YAML 声明的有向图 + 节点 gate + 审批暂停 + git/文件为唯一 SSOT + TypeScript + 本地优先）。核心矛盾在于：所有成熟引擎都把**执行状态存在自己的库/服务里**，这与「纯文件 + git 为 SSOT」天然冲突，会形成第二个 SSOT。
2. **允许外部状态源（BYO state）的只有 4 个**：Vercel Workflow SDK（World 适配器）、LangGraph（自定义 Checkpointer）、Mastra（自定义 storage）、XState（snapshot 是普通对象）。其中 **Vercel Workflow SDK 最彻底**——它的持久层被显式抽象成可替换的 `World`，且自带的 local World 就落在文件系统上。
3. **概念上最贴近 agent-cord「gate = 角色×时机×校验×放行条件」的三个参照实现**（都不是 TS）：Microsoft Agent Framework（YAML 声明式 + HITL action + checkpoint 携带 pending 请求）、Conductor OSS（`HUMAN` 任务就是一个 literal gate）、BPMN 家族的 user task（candidate group × boundary timer × form validation × completion condition）。
4. **建议**：编排内核自研（薄层，确定性图执行 + 事件流），gate 的状态机语义可直接用 XState v5，durability 若要借力则优先评估 Vercel Workflow SDK 的自定义 World；Temporal / Restate / Hatchet / DBOS / Inngest / Trigger.dev / Conductor / Kestra 一律**不当 SSOT 宿主**，只借思路或作为可选外部后端。**Inngest 因服务端 SSPL 许可，对 Apache-2.0 项目属于硬性不匹配。**

---

## 二、评估判据

针对 agent-cord 的硬约束，我用 7 条判据逐项打分：

- **L（License）**：能否随 Apache-2.0 的 npm 包分发（MIT/Apache/ISC 安全；BSL/SSPL/AGPL/fair-code 有风险）
- **TS**：是否 TypeScript 原生（Python 项目只能借鉴思路）
- **Local**：能否在本地进程/单机跑，不强制外部服务（daemon + 薄 CLI 的形态约束）
- **BYO-state**：是否允许外部状态源，能否只借编排与暂停恢复
- **Decl**：图定义是「数据」还是「代码」（agent-cord 要 YAML + apiVersion）
- **Gate**：节点上挂「角色×时机×校验×放行条件」的表达力
- **HITL**：人工审批暂停/恢复的成熟度

---

## 三、候选详评

### A. TS 原生、可嵌入本地进程的编排/状态机候选（最高优先级组）

**1. Mastra** — https://github.com/mastra-ai/mastra
- License：Apache-2.0（`@mastra/core` npm 元数据为 Apache-2.0；仓库 `LICENSE.md` 说明 `ee/` 目录另许可，含 `@mastra/core/auth/ee`、`@mastra/core/agent-builder/ee`——**法务需确认发布包内 ee 目录的边界**）
- 活跃度：28,312 stars，最后提交 2026-09-24；`@mastra/core` 1.70.0（当日发布）
- 提供什么：TS 原生 agent + workflow 框架。`createStep`/`createWorkflow` 组合有向图（`.then/.branch/.parallel/.dowhile`），step 内 `suspend({reason})` 暂停、`resume({step, resumeData})` 恢复、`bail()` 拒绝，`resumeSchema`/`suspendSchema` 用 Zod 校验审批输入；storage 可插拔（`@mastra/libsql` 提供本地 SQLite），工作流运行状态存在 storage 里
- 匹配度：**适配后复用**。「放行条件=分支、时机=step 内任意点、校验=resumeSchema」几乎一一对应 gate，storage 可自定义。代价是**图用代码写而非 YAML 数据**，需要把 agent-cord 的 YAML 编译成 Mastra 工作流；工作流状态仍归 Mastra 所有
- 出处：[Human-in-the-loop 文档](https://mastra.ai/docs/workflows/human-in-the-loop)、[Workflows 概览](https://mastra.ai/docs/workflows/overview)

**2. Vercel Workflow SDK（npm `workflow`）** — https://github.com/vercel/workflow
- License：Apache-2.0（`workflow`、`@workflow/core`、`@workflow/world-local`、`@workflow/world-postgres` 全部 Apache-2.0）
- 活跃度：`workflow` 4.8.9，当日发布；由 Vercel 团队维护，迭代极快
- 提供什么：TS durable execution。`"use workflow"`（确定性编排器）/`"use step"`（可重试、结果记录在事件日志的副作用叶子）指令；**World 是显式的适配器层**——每个 World 提供「事件日志 + 队列 + 存储」三件套，自带 local World（本地开发零配置）与 Postgres World，官方明确写「self-host 可用 Postgres backend 或实现自定义 World」，并提供 `createWorld`/`setWorld` API
- 匹配度：**适配后复用（最有价值的候选）**。它是唯一把「状态放哪」交还给你的引擎，理论上可以写一个「World over cord/<req-id>/*.jsonl + git」；HITL 用 hooks/webhooks。风险点：需要构建插件（Next.js 用 `withWorkflow`，非 Next 项目需接入 SWC/编译链），对一个「库 + daemon」形态是额外摩擦；且 step 事件日志仍是引擎形态的数据
- 出处：[repo README](https://github.com/vercel/workflow)（"To self-host, use the Postgres backend or implement a custom World"）

**3. XState v5** — https://github.com/statelyai/xstate
- License：MIT；活跃度：30,161 stars，最后提交 2026-09-24；`xstate` 5.33.2
- 提供什么：状态机/状态图/actor 模型，零依赖纯库。`actor.getPersistedSnapshot()` 产出**普通对象**，`createActor(logic, { snapshot })` 恢复；v5 支持递归深度持久化（子 actor 一并保存）；内置 delayed transition（定时器语义）
- 匹配度：**直接复用（作为本地状态机内核）**。它是唯一「状态完全归你」的库：snapshot 存成 YAML/JSON 进 git 毫无障碍。gate 四元模型可自然映射：角色=context、时机=state、校验=guard、放行=event。代价：无 durability、无跨进程工作器、定时器需自己落盘，这些要自研
- 出处：[Persistence 文档](https://stately.ai/docs/persistence)

**4. `@effect/workflow`（未列入主题，重要发现）** — https://github.com/Effect-TS/effect
- License：MIT；活跃度：`@effect/workflow` 0.19.1（2026-09-18），`effect` 3.22.2，同一 monorepo 当日仍在发版
- 提供什么：TS 原生 durable workflow（`Workflow.make`、Activity、`DurableDeferred` 持久化 promise），构建在 `@effect/cluster` 之上，存储侧走 `@effect/sql`（SQLite / Postgres，可用 `sqlite-node` 纯本地）
- 匹配度：**适配后复用（观察项）**。是 TS 生态里少数「库形态 + 可本地 SQLite」的 durable execution。但仍是 0.x（未 1.0），Effect 生态学习曲线陡，SQL 存储与「纯文本 SSOT」有摩擦。我未能取到官方文档页（多个 URL 404），建议以 npm 与社区 issue 为准再确认
- 注意：诚实说明——本项的机制细节我基于 npm 元数据与公开 issue/社区资料判断，**未读到官方文档原文**，落地前需复核

### B. 持久化执行引擎（durable execution；能力最强，但状态归引擎）

**5. Temporal** — https://github.com/temporalio/temporal
- License：MIT（服务端与 TS SDK 均 MIT）；活跃度：23,274 stars，最后提交 2026-09-24；`@temporalio/workflow` 1.24.0（2026-09-15）
- 提供什么：最成熟的 durable execution。Workflow + Activity 分离（workflow 必须确定性，I/O 全在 activity）；HITL 用 Signal（单向、改状态）/ Update（可带 validator，在写入 history 前拒绝）/ `workflow.condition()` 阻塞等待；本地可用 `temporal server start-dev`
- 匹配度：**只能借鉴思路**。致命点是 **Event History 就是状态源，不允许外部 SSOT**，且工作流以代码而非数据定义。若选它，就是在 git 之外多一个权威状态源
- 出处：[TypeScript message passing 文档](https://docs.temporal.io/develop/typescript/message-passing)

**6. Restate** — https://github.com/restatedev/restate
- License：**BSL 1.1**（Additional Use Grant 明确允许自用生产部署；SDK 为 MIT，`@restatedev/restate-sdk` 1.17.2）。BSL 非 OSI 认证许可，对 Apache-2.0 项目属于**分发风险**
- 活跃度：4,468 stars，最后提交 2026-09-24，Rust 单二进制
- 提供什么：journaled execution（记录步骤结果，不重放业务代码）——**因此工作流代码不必确定性**，这点比 Temporal 舒服得多；awakeable / durable promise 是 HITL 最优雅的原语（暂停 → 拿一个 promise → 外部完成 → 精确恢复）
- 匹配度：**适配后复用（若接受 BSL + 额外进程）／否则借鉴**。运维足迹小（单二进制 + 内嵌 RocksDB），但状态在服务端，且许可不适合随包分发
- 出处：[Approvals with Pause & Resume](https://docs.restate.dev/ai/patterns/human-in-the-loop)

**7. Hatchet** — https://github.com/hatchet-dev/hatchet
- License：MIT；活跃度：7,997 stars，最后提交 2026-09-24；`@hatchet-dev/typescript-sdk` 1.33.1
- 提供什么：Postgres 为后端的 durable task queue。durable task 可「等时间 / 等事件 / 派生 child task」，等待期间可被驱逐释放 worker；官方明确「durable event waits 是 human-in-the-loop 的基础」
- 匹配度：**适配后复用（若已接受 Postgres 依赖）**。HITL 语义干净、Postgres-only 运维简单；但状态全在 PG，且需要跑 worker + server

**8. DBOS** — https://github.com/dbos-inc/dbos-transact-ts
- License：MIT；活跃度：1,372 stars，最后提交 2026-09-24；`@dbos-inc/dbos-sdk` 5.0.2
- 提供什么：把工作流状态存进 Postgres 的「库形态」durable execution。`DBOS.registerWorkflow` + `DBOS.runStep`，durable sleep、workflowID 即幂等键、timeout 持久化；工作流需确定性（官方文档明确要求）。HITL 走「与工作流通信」（durable recv/send 类原语）
- 匹配度：**适配后复用（若接受 Postgres 为 system-of-record）**。它是 B 组里最像「嵌入现有 Node 进程」的，但 Postgres 是硬依赖，与「本地优先、纯文件 SSOT」的取向冲突
- 出处：[TypeScript workflow 教程](https://docs.dbos.dev/typescript/tutorials/workflow-tutorial)

**9. Trigger.dev** — https://github.com/triggerdotdev/trigger.dev
- License：Apache-2.0（仓库）；`@trigger.dev/sdk` 4.6.4 MIT；活跃度：16,392 stars，最后提交 2026-09-24
- 提供什么：**waitpoint token 是本次调研中设计最好的审批 API**：`wait.createToken({timeout, idempotencyKey, tags})` → 返回 `id` / `url`（server-to-server 回调地址）/ `publicAccessToken`（浏览器可安全完成，CORS 已开）；任务内 `wait.forToken(id)` 暂停，任意外部系统 POST 即恢复
- 匹配度：**只借 HITL 思路，不整体复用**。自托管需要 webapp + supervisor + Postgres + Redis + ClickHouse + 对象存储（官方 K8s 文档列的资源清单），对一个本地 daemon 来说重得离谱
- 出处：[Wait for token 文档](https://trigger.dev/docs/wait-for-token)

**10. Inngest** — https://github.com/inngest/inngest
- License：**服务端仓库为 SSPL 1.0（附「Apache 2.0 Future License」）**，非 OSI 认证；npm `inngest` 包 4.21.0 元数据为 Apache-2.0（SDK 与服务端许可不一致，需按包逐个核对）
- 活跃度：5,881 stars，最后提交 2026-09-24
- 提供什么：step memoization（每个 `step.run` 结果持久化，重跑跳过已完成步骤）、`step.waitForEvent` 完全挂起且不占算力
- 匹配度：**不匹配（License 硬约束）**。SSPL 对一个要随 Apache-2.0 包分发的项目是不可接受的依赖风险

### C. 声明式工作流 + gate（数据驱动的图，但非 TS / 非本地）

**11. Conductor OSS（未列入主题，重要发现）** — https://github.com/conductor-oss/conductor
- License：Apache-2.0；活跃度：Netflix 2023-12 移交社区，现由 Orkes + 社区维护并持续发版（README 显示 CLI/UI/多语言 SDK 与 AI 任务仍在演进；精确 star 数因 API 限流未取到）
- 提供什么：**JSON DSL 声明的有向图工作流**，定义带 `"version": 1` 且**每次执行 pin 到启动时的版本**（这就是 agent-cord 想要的 apiVersion 化，且顺带解决了"改图不破坏在跑实例"）；`HUMAN` 任务官方定义就是「a gate that remains IN_PROGRESS until marked as COMPLETED by an external system」；另有 WAIT、SWITCH、DO_WHILE、FORK_JOIN、SUB_WORKFLOW、DYNAMIC 任务；原生 LLM / MCP 任务与 human approval；pause/resume/retry/rerun/restart；worker 支持 JS 等多语言
- 匹配度：**只能借鉴思路（但概念贴合度最高）**。它的设计哲学与 agent-cord 高度同构——「引擎负责确定性，你的 worker 代码不必确定性」「orchestration 是可版本化、可检查的图，副作用在 worker」。阻碍是 JVM 服务端（需 Java 21）与自有 DB（Redis+ES / Postgres / MySQL），与本地优先 TS daemon 的形态不符
- 出处：[Human Task 文档](https://conductor-oss.github.io/conductor/documentation/configuration/workflowdef/systemtasks/human-task.html)、[repo README](https://github.com/conductor-oss/conductor)

**12. Kestra（未列入主题）** — https://github.com/kestra-io/kestra
- License：Apache-2.0（OSS 核心）；JVM 服务端
- 提供什么：YAML 是一等公民的工作流平台；`Pause` 任务 + `onResume` 输入实现 human-in-the-loop（官方 how-to 与 approval-processes 用例页均在 OSS 文档下）；Namespace Files + [plugin-git 的 GitOps 同步](https://kestra.io/blueprints/sync-from-git) 把 flows 与文件以 git 为源同步进平台——这是本次调研中**最接近「文件 + git 即 SSOT」的工程实践**
- 匹配度：**只能借鉴思路**。若未来愿意引入外部引擎作为可选后端，Kestra 的 GitOps 同步模型值得抄

**13. Microsoft Agent Framework（AutoGen 的正统继任者，未列入主题）** — https://github.com/microsoft/agent-framework
- License：MIT；活跃度：13,777 stars，最后提交 2026-09-24；1.0 GA 于 2026-04-03；语言为 .NET / Python / Go（**无官方 TypeScript**，社区有 `polymind-inc/agent-framework-js` 但太年轻）
- 提供什么：**本次调研中「YAML 声明式工作流 + HITL + checkpoint」最完整的实现**。声明式 YAML 工作流（`kind: Workflow` / `actions:`，action 种类覆盖变量、控制流、agent/tool 调用、HTTP/MCP、**human-in-the-loop**、对话控制）；HITL 通过 `RequestPort`（C#/Go）或 `ctx.request_info()` + `@response_handler`（Python），工作流暂停并发出 `RequestInfoEvent`，外部回应后自动路由回原 executor；**checkpoint 会把 pending 请求一起存下**，恢复时重新抛出发出，甚至可以在一次调用里同时传 `checkpoint_id` 和 `responses`
- 匹配度：**只能借鉴思路（但设计对照价值第一）**。如果 agent-cord 要把 gate 做成「YAML action + 暂停 + checkpoint 携带 pending 请求」，这份规范就是现成的最佳范本
- 出处：[Declarative Workflows](https://learn.microsoft.com/en-us/agent-framework/workflows/declarative)、[Human-in-the-loop](https://learn.microsoft.com/en-us/agent-framework/workflows/human-in-the-loop)

**14. BPMN 家族：Operaton / Flowable（未列入主题）**
- Operaton（Camunda 7 社区 fork）：Apache-2.0；Flowable：Apache-2.0；Camunda 7 上游已进入 EOL 路线
- 提供什么：**「角色×时机×校验×放行条件」在工程上的成熟原型**——user task（时机）+ candidate group / assignee（角色）+ form / task validation（校验）+ completion condition / boundary timer / boundary event（放行与超时）
- 匹配度：**只能借鉴思路（概念来源，不落地）**。Java 引擎、BPMN 表达力远超需求，且引入它等于把状态交给引擎库

### D. 多 agent 框架（对话与角色编排，Python 为主）

**15. LangGraph** — https://github.com/langchain-ai/langgraph
- License：MIT；活跃度：42,229 stars，最后提交 2026-09-23；JS 版 `@langchain/langgraph` 1.4.17 MIT（2026-09-22）
- 提供什么：StateGraph（节点+边+共享状态）+ Checkpointer。HITL 原语是 `interrupt()`：动态暂停点，checkpointer 存状态，`Command(resume=...)` 恢复；支持自定义 Checkpointer（社区有完整的 `FileCheckpointSaver` 实现，落 JSON 文件）——即**理论上可以把 graph state 写进 git**
- 匹配度：**只能借鉴思路（JS 版可做原型验证）**。原因是官方文档列明了若干硬约束，与「文件即可读 SSOT」相性差：恢复时**节点从头重跑**（interrupt 前的副作用必须幂等）、多 interrupt 按索引严格匹配、禁止 `while True` + interrupt（会指数级重放）、payload 必须 JSON 可序列化。加上它把状态存成 engine 形态的 checkpoint（Python 侧 msgpack），塞进 git 的可读性很差
- 出处：[Interrupts 文档](https://docs.langchain.com/oss/python/langgraph/interrupts)、[Persistence 文档](https://docs.langchain.com/oss/javascript/langgraph/persistence)

**16. CrewAI** — https://github.com/crewAIInc/crewAI
- License：MIT；活跃度：58,981 stars，最后提交 2026-09-23；**Python only**
- 提供什么：Crew（角色团队）+ Flow（事件驱动工作流，`@start`/`@listen`/`@router`）+ `@persist`（FlowPersistence 状态持久化）+ `@human_feedback`（暂停、展示输出、收集人工反馈并决定回环）。Flow 还有 `usage_metrics` 的跨 Crew token 汇总
- 匹配度：**只能借鉴思路**。`@human_feedback` 的 outcome/审查人/回环语义很值得抄；但 Python 且状态存 LanceDB/持久化后端，与 TS 技术栈无关

**17. AutoGen / AG2**
- **microsoft/autogen**：README 已挂维护模式横幅（2025-10 起），最后提交 2026-04-15，61,141 stars（历史积累）；**代码 MIT（`LICENSE-CODE`）、文档 CC-BY-4.0**，GitHub 展示为 CC-BY-4.0 易误判。官方继任者是 Microsoft Agent Framework → **不匹配**
- **AG2（ag2ai/ag2）**：Apache-2.0，4,955 stars，最后提交 2026-09-24（仍在活跃开发），保留 GroupChat / swarms 等对话式模式 → **只能借鉴思路（Python）**

### E. Agent 运行时与审批原语（不是图引擎，但与 AgentDriver 直接相关）

**18. OpenAI Agents SDK** — https://github.com/openai/openai-agents-python / https://github.com/openai/openai-agents-js
- License：MIT；活跃度：Python 29,676 stars（2026-09-23）；JS 3,857 stars（2026-09-24）；`@openai/agents` 0.18.0（2026-09-10）
- 提供什么：**审批 + 可序列化状态**做得非常克制而实用：tool 上 `needsApproval`（布尔或异步函数）→ 运行暂停并返回 `interruptions` → `state.approve()/reject()` → 用 `RunState.fromString(agent, snapshot)` + `run(agent, state)` 恢复；支持 `alwaysApprove` 粘性决策、跨 handoff / `agent.asTool()` 嵌套审批；官方示例直接把 `result.state` 写进本地文件。Session 可插拔
- 匹配度：**适配后复用（作为 AgentDriver / 审批机制的参考），不匹配「有向图引擎」**。它没有声明式工作流图，是 agent loop + handoff；但对「每任务 subprocess 驱动 headless CLI」这一层，它的 interruption + 序列化状态模型是最值得照搬的 API 形态
- 出处：[HITL JS 指南](https://openai.github.io/openai-agents-js/guides/human-in-the-loop/)

**19. wake（未列入主题，高度相关）** — https://github.com/nelsonwerd/wake
- License：Apache-2.0；活跃度：**极新、作者自述无用户无 traction、experimental**（最后 README 更新含 2026-07 的 live run 记录）
- 提供什么：Go 单一二进制、本地优先，把**未经改造的 agent 子进程**（Claude Code / Codex / 任意 binary）跑在「corruption-evident、crash-durable 的事件日志」里：子进程通过 stdio 上的小型 NDJSON 协议通信；`kill -9` 后 `wake resume` 可续到同一终态；`wake replay` 纯归约（零副作用执行）；`wake fork` 从任意事件 O(1) 分叉；`wake verify` 逐字节哈希链校验。它明确自陈「人类审批/gated tier 尚未跑通，是 pending 设计项」
- 匹配度：**只能借鉴思路，但值得逐字读它的 PROTOCOL.md / guarantees.md**。它是本次调研中与 agent-cord「events.jsonl + subprocess AgentDriver + 可复现/可回放」最同构的工程，且 Apache-2.0 可读代码。差别在 Go vs TS、无 gate 收敛
- 出处：[repo README](https://github.com/nelsonwerd/wake)

### F. 投票/共识类（顺带核查，对应 agent-cord 的盲评投票执行器）

- karpathy/llm-council（本地 web app，OpenRouter 多模型 + 互评 + 综述）、RyanLisse/Quorum、PolyCouncil、quoroom-ai/room、niveshdandyan/llm-council 等
- 共同形态是「多模型并行作答 → 互评/辩论 → 主席综述」，**没有证据锚点（anchor）的机器可验证、也没有锚点 Jaccard 同源检测与人工升级**
- 匹配度：**不匹配**。agent-cord 的「k=2~3 盲评 + 锚点机验 + 2/2 一致才 confirmed + Jaccard ≥0.5 升级人工」没有现成实现，必须自研（但底层调用与结构化输出可复用）

---

## 四、横向对比

| 项目 | License | TS | 本地无服务 | 外部状态源 | 图定义 | 审批/HITL 原语 | 匹配度 |
|---|---|---|---|---|---|---|---|
| Mastra | Apache-2.0（ee 目录另计） | 是 | 是（LibSQL） | 可自定义 storage | 代码 | suspend/resume/bail + resumeSchema | 适配后复用 |
| Vercel Workflow SDK | Apache-2.0 | 是 | 是（local World） | **是（World 适配器）** | 代码 + 指令 | hooks / webhooks | 适配后复用 |
| XState v5 | MIT | 是 | 是 | **是（snapshot 归你）** | 代码（状态图） | 无（guard/event 自建） | 直接复用（内核） |
| @effect/workflow | MIT | 是 | SQLite | 存储可换 SQL | 代码 | DurableDeferred | 适配后复用（0.x） |
| Temporal | MIT | 是 | 需服务端（有 dev server） | **否** | 代码（须确定性） | Signal / Update+validator / condition | 只能借鉴 |
| Restate | **BSL 1.1**（SDK MIT） | 是 | 单二进制（须跑服务） | **否** | 代码（无需确定性） | awakeable / durable promise | 适配后复用（许可风险） |
| Hatchet | MIT | 是 | 否（Postgres） | **否** | 代码 | durable event waits | 适配后复用 |
| DBOS | MIT | 是 | 否（Postgres） | **否** | 代码（须确定性） | send/recv + durable sleep | 适配后复用 |
| Trigger.dev | Apache-2.0 | 是 | 否（webapp+PG+Redis+CH+对象存储） | **否** | 代码 | **waitpoint token（最佳 API）** | 借 HITL 设计 |
| Inngest | SDK Apache-2.0 / **服务端 SSPL** | 是 | 否 | **否** | 代码 | step.waitForEvent | **不匹配（许可）** |
| LangGraph | MIT | JS 版有 | 是 | 可自定义 checkpointer | 代码 | interrupt() + Command(resume) | 只能借鉴 |
| CrewAI | MIT | 否 | — | — | 代码 | @human_feedback | 只能借鉴 |
| AG2 / AutoGen | Apache-2.0 / MIT | 否 | — | — | 代码 | GroupChat | 只能借鉴 / 不匹配 |
| MS Agent Framework | MIT | **否** | — | 检查点存储可换 | **YAML 声明式** | RequestPort / request_info + checkpoint 携带 pending | 只能借鉴（范本） |
| Conductor OSS | Apache-2.0 | worker 侧有 | 否（JVM + DB） | **否** | **JSON DSL + version pin** | **HUMAN task（literal gate）** | 只能借鉴（贴合度高） |
| Kestra | Apache-2.0 | 脚本侧 | 否（JVM） | **否** | **YAML** | Pause + onResume | 只能借鉴 |
| BPMN（Operaton/Flowable） | Apache-2.0 | 否 | 否 | **否** | BPMN XML | user task + candidate group | 只能借鉴（概念源） |
| OpenAI Agents SDK | MIT | JS+Py | 是 | 是（RunState 序列化） | 无图 | needsApproval + interruptions | 适配（Driver 层） |
| wake | Apache-2.0 | 否（Go） | 是 | — | 声明式 fleet spec | gate 未收敛 | 只能借鉴 |

---

## 五、造轮子 vs 复用：逐组件建议

### 必须自研（没有现成实现，且是 agent-cord 的护城河）

1. **SSOT 层：`cord/<req-id>/` 目录 + `ledger.yaml` 条目状态机 + `events.jsonl` + 证据锚点机验 + 锚点 Jaccard 同源升级**。所有引擎都不提供，且所有「状态归引擎」的引擎（Temporal / Restate / Hatchet / DBOS / Inngest / Trigger.dev / Conductor / Kestra）**与它直接冲突**。
2. **gate 的四元模型与三级校验器（内置枚举 / CEL / 外部 IPC 插件）**。最近的参照是 MAF 的声明式 action 与 Conductor 的 HUMAN task，都是别的语言、都无法把 YAML 当唯一 SSOT。
3. **确定性图执行器 + 事件驱动的恢复**（若不用 Mastra/WDK）。工作量不大（薄层：读图 → 拓扑推进 → 每节点追加事件 → 恢复时按事件跳过已完成），但决定了 SSOT 归属，值得自己做。可参照 wake 的 guarantees 与 LangGraph interrupt 语义规避坑。
4. **投票执行器语义**：锁模型版本、temperature=0、结构化输出、k 路盲评、锚点机验、2/2 一致判定、升级人工。开源 llm-council 家族只有「辩论+综述」，无锚点机验。

### 直接复用（P0，库级、本地、许可干净）

- **YAML 解析与 apiVersion 化**：`yaml`（ISC，2.9.1，2026-09-11）——注意用它的 Document API 才能保住注释与格式
- **Schema 校验**：`ajv`（MIT，8.20.0）用于 YAML 定义与插件契约；`zod`（MIT，4.6.5）用于 TS 侧类型与结构化输出
- **放行条件表达式**：`jsonata`（MIT，2.2.2，2026-07-30）作为工程权衡；若要 CEL 语义，`cel-js`（MIT）可用但**自 2025-07-11 起未更新**，需评估或自研子集（TS 生态没有 Google CEL 的官方实现）
- **Markdown + frontmatter**：直接用 `yaml` + 自己切 `---`，**不要用 `gray-matter`**（4.0.3，自 2021 年后实质停更）
- **subprocess 驱动 AgentDriver**：`execa`（MIT，10.0.1）
- **git 操作**：`simple-git`（MIT，3.36.0）。**events.jsonl 的 union merge 不需要写任何代码**——`.gitattributes` 里 `events.jsonl merge=union` 就是 git 内置 driver；但要注意 union 合并会重复行，必须靠 event id 去重
- **文件监听**：`chokidar`（MIT，5.0.0）
- **哈希与锚点指纹**：`@noble/hashes`（MIT，2.4.0，已审计）
- **并发控制**：`p-limit`（MIT，7.3.3）
- **本地 IPC/HTTP**：`jayson`（MIT，5.0.0，JSON-RPC）或 `hono`（MIT，4.13.9）
- **知识库索引**：`better-sqlite3`（MIT，13.0.3，SQLite ≥3.34 的 FTS5 trigram tokenizer 可用；注意原生模块的 npm 分发需预编译二进制）
- **模型调用与结构化输出**：`@ai-sdk/*`（Apache-2.0，`@ai-sdk/openai` 4.0.74）或各厂商 SDK + zod
- **可选：MCP 兼容面**：`@modelcontextprotocol/sdk`（MIT，1.30.1）——若希望 agent-cord 的 gate/工具能被外部 agent 调用，这是现成入口

### 适配后复用（P1，建议做 spike 验证）

1. **XState v5** 承载 gate/节点状态机：snapshot 是普通对象，天然可进 git；只缺 durability，而那层你本来就要自研
2. **Vercel Workflow SDK 的自定义 World**：唯一「持久层可完全替换」的引擎，做一个「World over cord 目录 + git」的 spike 是本次调研最值得投入的验证
3. **Mastra** 作为 work-flow 引擎候选：如果你愿意把 YAML 编译成 Mastra 工作流并接受状态归它（可落本地 LibSQL）
4. **@effect/workflow**：若团队已用 Effect，它能提供纯本地 SQLite 的 durable workflow

### 只借思路（P2）

- **Conductor OSS**：抄「定义版本 pin 到执行」「HUMAN task 即 gate」「引擎确定性、worker 不必确定性」
- **MS Agent Framework**：抄「YAML action 种类设计」与「checkpoint 携带 pending 请求、恢复时重新抛出」
- **Kestra**：抄「GitOps 同步 flows + namespace files，git 为源、平台为镜像」
- **LangGraph**：抄 interrupt 语义，并**避开**它的坑（恢复时节点重跑、索引匹配、禁止 while+interrupt）
- **Trigger.dev**：抄 waitpoint token 的 API 形态（token + 回调 URL + 浏览器安全 token + 幂等键 + 超时）
- **CrewAI**：抄 `@human_feedback` 的 outcome 语义
- **wake**：抄事件日志的「哈希链 + 纯归约回放 + 事件粒度分叉」

### 明确不要用

Inngest（服务端 SSPL）、AutoGen（维护模式）、n8n（Sustainable Use License，非 OSI，禁止未授权转售/嵌入）、Windmill（默认文件为 AGPLv3，另有 Apache 与专有部分混合）、Restate 若要求随包分发（BSL 1.1）。CrewAI / AG2 / Conductor / Kestra / BPMN / MAF 因语言与形态不符，不作为运行时依赖。

---

## 六、复用优先级清单

**P0 — 立刻可用，零风险**
1. `yaml` + `ajv` + `zod`：YAML apiVersion 定义与三级校验器的前两级
2. `.gitattributes` 的 `merge=union`：events.jsonl 防丢事件（配 event id 去重）
3. `execa` + `@noble/hashes` + `p-limit`：AgentDriver 与锚点指纹
4. `simple-git` + `chokidar`：git 操作与文件监听
5. `better-sqlite3`（FTS5 trigram）：知识库派生索引
6. `@ai-sdk/*` 或厂商 SDK + `zod`：投票执行器与结构化输出

**P1 — 做 spike 后再定**
7. `XState` v5 承载 gate 状态机（推荐先做，成本最低、收益明确）
8. Vercel Workflow SDK 自定义 World：验证「durability 后端能否直接落在 cord 目录 + git」
9. `Mastra`：验证「YAML → Mastra 工作流编译」的摩擦成本
10. `jsonata`（或 `cel-js` 自担维护）作为放行条件表达式

**P2 — 只读设计与代码，不引依赖**
11. Conductor HUMAN task / MS Agent Framework 声明式 workflow / Kestra GitOps 三份文档
12. wake 的 PROTOCOL.md + guarantees.md（事件日志与可复现语义）
13. Trigger.dev waitpoint 的 API 契约
14. LangGraph interrupts 文档（当反面教材读坑）

**自研（不可外包）**
15. `cord/<req-id>/` SSOT 层 + ledger 条目状态机 + 证据锚点机验
16. gate 四元模型 + 外部 IPC 插件校验器
17. 确定性图执行器 + 事件恢复
18. 投票执行器（盲评 + 2/2 一致 + Jaccard 同源升级）

---

## 七、需要进一步验证 / 未能证实的点

1. **GitHub API 在调研后半程被限流**，Conductor OSS、Kestra、wake、Vercel Workflow SDK 的精确 star 数与最近提交日期未能取到；Mastra、LangGraph 等的 star 数取自当次成功调用（2026-09-24）。建议落地前用 `gh api` 复核一次。
2. **`@effect/workflow` 的官方文档页全部 404**（effect.website 路径已变），其机制描述来自 npm 元数据与公开 issue，**未读官方原文**，需复核。
3. **Mastra 的 `ee/` 边界**：仓库 LICENSE.md 声明 `@mastra/core/auth/ee`、`@mastra/core/agent-builder/ee`、`@mastra/editor/ee` 另有许可，但 npm 上 `@mastra/core` 元数据只写 Apache-2.0。若要依赖，需检查发布包内文件的实际许可归属。
4. **Inngest 的双许可**：服务端仓库为 SSPL 1.0（附 Apache-2.0 future license），npm `inngest` 包元数据为 Apache-2.0。若要使用，需按具体包与部署方式逐项核对。
5. **Restate 的 BSL 变更日期**（Change Date → Apache-2.0）我未读到完整参数行，需看完整 LICENSE。
6. **Kestra 的 Pause/onResume 我按 OSS 文档判定可用**，但更细的审批 UI/RBAC 属 EE；若依赖更重的审批界面需重新评估。
7. **Trigger.dev 自托管的完整组件清单**来自其 K8s 文档片段（webapp / supervisor / Postgres / Redis / ClickHouse / 对象存储），未逐项实地验证。
