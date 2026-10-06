# ADR-0023 ｜ 协调 session agent 与节点执行体：node.run + Coordinator + agent.task 事件

- 状态：accepted（设计定稿，原型已实现）
- 日期：2026-10-06
- 关联：ADR-0011（agent 运行时）、ADR-0017（驱动协议）、ADR-0018（薄执行器与恢复语义）、ADR-0003（共识载体：协调 agent 只持最新快照）、ADR-0020（事件协议）、ADR-0022（SDLC 定制模型）
- 来源：README 当前边界（「默认 SDLC 中的真实投票产出」与节点执行体未实现）；2026-10 开源 agent 编排生态扫描（Claude Agent SDK subagents/hooks、OpenAI Agents SDK handoffs/guardrails、ACP 并入 Linux Foundation A2A）

## 背景

M2/控制台 MVP 的执行器只推进 gate：节点 `entered → gates → exited`，**节点本身没有执行体**——`plan`/`implement` 等节点不产出任何内容，快照文档只能靠人手写。驱动层（ACP + 裸 headless，ADR-0017）已实现但没有调用方；「自定义 agent 可插拔」缺最后一块：把 agent 绑定到流程节点上。同时，方案中的「协调 agent（coordinator）」——持有最新需求快照、负责剪裁上下文、调度角色 agent 的 session 级协调者——一直没有实现载体。

2026 年生态扫描印证了这个分层：Claude Agent SDK 的核心模式是 subagents（子 agent 各自独立上下文窗口、由主 agent 分派任务），OpenAI Agents SDK 是 handoffs + guardrails；生产团队普遍混用「编排层 + 厂商执行层」。agent-cord 的执行器/gate 对应编排层，driver 对应执行层，缺的是中间的协调智能。

## 备选方案

1. **执行器内嵌 agent 调用**：executor 遇到 `node.run` 直接 `driver.run()`。最简单，但上下文剪裁、prompt 组装、结果解释是高频多变的「智能层」，塞进执行器违反 ADR-0018 的薄执行器定位，执行器从此同时背编排正确性与提示词工程两个变化轴。
2. **协调 agent 作为外循环**：coordinator 扫快照决定推进哪个节点，逐节点调 executor。executor 不变，但恢复语义被劈成两半（executor 扫点 + coordinator 自己的进度判断），两套「当前节点」真相必然漂移。
3. **node.run 声明 + NodeRunner 端口（选定）**：节点声明执行体（`run: { agent, prompt?, readonly?, timeout_ms? }`）；执行器把执行委托给注入的 `NodeRunner` 端口，自身推进/扫点/恢复逻辑一行不动；Coordinator 是 NodeRunner 的生产实现：重建最新快照 → 构建上下文包 → 经 AgentDriver 调度 → 事件落盘 → artifact 校验写回。

## 决策

1. **节点可声明执行体** `run`（可选，缺省节点无执行体，行为同 M2）：
   ```yaml
   - id: plan
     artifact: plan.md
     depends_on: [align]
     run: { agent: claude, readonly: false, timeout_ms: 600000 }   # prompt 可省，缺省按节点/产物给任务模板
   ```
   `agent` 是驱动名（registry 语法：`claude` / `acp:kimi` / `headless:codex` / `agents.yaml` 注册的别名）。
2. **Coordinator 是 session 级协调 agent**（`src/coordinator/`）：每次执行节点前重建**最新快照视图**（快照文档存在性与内容、账本条目、工作流进度——ADR-0003「协调 agent 只持最新快照，历史留事件流」）；为节点构建**上下文包**（高信号层：PRD 全文 + 上游 artifact 摘要 + 相关账本条目；定位符层：文件路径锚点，worker agent 按需自取——对应 W1.6 的两层剪裁）；缺省 prompt 模板按 artifact 类型分档（prd/plan/adr/findings/通用）。
3. **事件契约**（沿用 OWS 生命周期词表对齐惯例，ADR-0018 注意点 6）：`agent.task.started`（workflow_id, node_id, driver, prompt 摘要）与 `agent.task.completed`（status: ok/failed/timeout、text 摘要、artifact_written、written_by: agent|coordinator|none、agent_session_id、usage）。worker 的流式中间事件**不进**事件流（噪声且无审计价值）；完整原文截断后随 completed 落盘（上限 32KB，防事件流膨胀）。
4. **artifact 写回双通道**：worker agent（非只读）被指示把产物写到 `cord/<req-id>/<artifact>`；coordinator 完成后校验：agent 已写 → 记 `written_by: agent`；未写但返回了非空文本 → coordinator 代写为 draft 并记 `written_by: coordinator`；两者皆无 → `artifact_written: false`，由后续 gate（`file-nonempty` 等 checker）fail-closed 拦截。**执行体不能绕过门禁**：node.run 完成后照常走 post-gates。
5. **恢复语义不做 agent 会话续接**：节点重跑（恢复/重试）总是新会话 + 完整上下文包（上下文包自包含，事件流是唯一事实来源；外部 agent 侧会话可能已过期，依赖它违反 ADR-0018 注意点 4 的幂等要求）。`agent_session_id` 落盘仅供人工调试时手动 resume。
6. **自定义 agent 注册**：工作区级 `cord/agents.yaml`（`{name: {kind: acp|headless, bin, args?, env?}}`），server 启动时注册进驱动注册表（`registerKnownAgent` / `registerHeadlessCliTemplate`），新增 agent 零代码（DoD-1 前半）。BYO 凭证：env 只透传，不代管。
7. **默认 SDLC 不挂执行体**（开箱可跑不依赖任何 agent CLI 安装）；挂执行体的流程走模板库（agent 档模板），用户显式选择。

## 理由（第一性原理推导）

1. **从「变化轴分离」反推**：流程拓扑（季度级）、提示词与上下文剪裁（周级）、执行器推进逻辑（协议级，随 ADR 变）是三个不同频率的变化轴。方案 1 把后两个焊进第一个；方案 3 让执行器只背协议级变化，智能层在 NodeRunner 端口后自由演进——与 ADR-0014「编排与执行分注册表」同构。
2. **从「恢复语义唯一」反推**：ADR-0018 已定恢复单位是节点、靠事件流扫点。方案 2 引入第二个进度真相源（coordinator 外循环），杀进程恢复时两个循环各自扫点必然打架。执行必须在 executor 的节点生命周期内完成（entered 与 exited 之间），扫点逻辑才能保持「有 exited 即跳过」一条规则。
3. **从「事件流永不进 LLM 上下文」（ADR-0012）反推**：worker agent 的上下文必须由 coordinator 从快照剪裁产出，而不是把事件流塞给它——这正是上下文包存在的理由，也是「协调 agent 只持最新快照」的实现形态。同时 worker 的中间流式输出不进事件流，否则事件流退化成聊天记录（ADR-0003 否决项）。
4. **从「agent 只产 Draft」反推**：worker 写快照文档不违反设计原则——文档是 living 的、状态机流转只经事件流、合入由人工 gate 决定。coordinator 代写通道同理：它产的是 draft 文本，是否算数由后续 gate（证据 checker + 人工确认）判定，fail-closed 兜底。
5. **为什么上下文包是代码而非 LLM**：协调者的「可靠性职责」（扫描状态、组装上下文、校验产物、落事件）必须是确定性的代码——否则恢复、审计、幂等全部失守；LLM 只出现在被调度的 worker 侧。这与 2026 生态收敛一致：编排层确定性（LangGraph 图 / Agents SDK handoff 代码），模型智能在执行层。

## 被否方案的否决理由（逐一）

- **执行器内嵌 agent 调用**：违反薄执行器（ADR-0018）；提示词工程的变化频率会污染协议级代码。
- **coordinator 外循环逐节点驱动 executor**：双进度真相源，恢复语义劈叉；「当前节点」会有事件流与 coordinator 内存两个答案。
- **节点重跑时 resume agent 会话**：外部会话状态不在事件流内，违反幂等恢复（ADR-0018 注意点 4）；仅保留 session_id 供人工调试。
- **worker 流式事件全量进事件流**：事件流退化为聊天记录（ADR-0003 否决群聊当档案的同一理由）；审计只需要任务级 started/completed。
- **默认 SDLC 直接挂执行体**：开箱可跑要求零外部依赖（agent CLI 未必安装）；执行体永远显式 opt-in。

## 关键实现注意点

1. `NodeRunner` 端口挂在 `ExecutorOptions`（`nodeRunner?: (node, session) => Promise<void>`）；未注入时 `node.run` 被忽略并记 `warn` 理由进 node.exited 事件（不静默跳过）。
2. `agent.task.completed.text` 截断 32KB；prompt 摘要在 started 事件截断 4KB。两条事件都带 `workflow_id`/`node_id` 与 `correlation_id = node_id`，时间线投影零改动。
3. Coordinator 每节点重建快照（不是启动时快照一次）：长 run 中人在控制台改文档要能被下一个节点看到（living 文档语义）。
4. `run.readonly: true` 的节点走只读驱动参数（评审/分析类任务），且 coordinator 不代写 artifact。
5. `agents.yaml` 加载失败（语法错/未知 kind）→ server 启动报错并给出字段路径；单条 agent 配置错不阻断其他 agent 注册（逐项降级为告警）。
6. 超时：node.run.timeout_ms 缺省 10 分钟（与 driver 默认一致），超时 = `agent.task.completed{status: timeout}`，节点不退出，下次 run 重试该节点。
7. 驱动解析失败（agent 名未知）在 validate 期可提示（已知名清单），但**不做硬校验**——agent 可用性是运行时事实（CLI 可能后装），validate 硬拒会把「流程定义」与「环境状态」错误耦合。

## 证据来源

1. 2026-10 开源生态扫描：Claude Agent SDK subagents/hooks 模式（子 agent 独立上下文窗口、主 agent 分派）与 OpenAI Agents SDK handoffs/guardrails——编排层确定性 + 执行层模型智能的分层是 2026 年收敛方向；ACP 已并入 Linux Foundation A2A（ADR-0017 选型持续有效）。https://www.morphllm.com/ai-agent-framework ；https://langfuse.com/blog/2025-03-19-ai-agent-comparison
2. 项目内部：ADR-0003（协调 agent 只持最新快照）、ADR-0011（每任务 subprocess）、ADR-0017（驱动探测顺序）、ADR-0018（薄执行器与恢复语义）、docs/10-roadmap.md W1.6（上下文剪裁两层结构）。
