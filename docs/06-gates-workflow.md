# 06 · 工作流与门禁（Workflow & Gates）

> 状态：**设计定稿，代码未实现**（本方案文档集全部为设计定稿，尚无实现代码）
> 关联决策：[ADR-0001](./adr/ADR-0001-positioning.md)（不做激进全自动）、[ADR-0002](./adr/ADR-0002-lightweight-default.md)（默认轻量通道 + 触发式升级）、[ADR-0012](./adr/ADR-0012-events-im-adapters.md)（事件与通信）、[ADR-0014](./adr/ADR-0014-workflow-gate-dsl.md)（工作流/门禁定义语言）、[ADR-0016](./adr/ADR-0016-distribution-plugins.md)（分发与插件三层）
> 关联需求：**R10**（到达配置了门禁的节点时，必须执行校验并按结果放行/拦截/升级）；触发式升级的提议与"角色可直接发起校验"不另立编号，作为本机制的设计细节承载（编号口径见 [`./02-requirements.md`](./02-requirements.md) §4）
> 相邻章节：[`./02-requirements.md`](./02-requirements.md)（需求基准与术语）、[`./04-consensus-ledger.md`](./04-consensus-ledger.md)（门禁消费的账本条目与证据锚点）、[`./05-voting.md`](./05-voting.md)（门禁中的投票类校验器）、[`./07-context.md`](./07-context.md)（门禁与防腐钩子共享同一套证据锚点索引）

## 本章回答什么问题

一个需求从进入到上线，到底按什么路线走？路线是谁定的、写在哪里？路上哪些位置必须停下来校验、由谁校验、校验不过会怎样？以及最关键的一问：**为什么 agent-cord 不允许 agent 自己决定流程，而是坚持"预定义的有向图 + 可配置门禁"**——这看起来比"让 agent 自由编排"更笨，本章要给出证据与理由。

读者读完本章应能：写出一个能跑的需求流程定义（含多个门禁），知道新增一个门禁为什么不需要改平台代码，以及流程在什么信号下会自动升级为重型通道。

---

## 1. 工作流 = 预定义的有向图

### 1.1 图由四件事构成

| 组成 | 含义 | 落在哪里 |
|---|---|---|
| **节点（node）** | 一个阶段，七个：进入 → 对齐与共识 → 计划 → 执行 → 验证 → 防腐 → 上线回流 | 流程定义 YAML（`gates/*.yaml`） |
| **出口（artifact）** | 节点完成时必须存在的**里程碑文档**：`prd.md` / `adr.md` / `plan.md` / `findings.md`（封闭枚举，外加执行阶段的代码产物）；与门禁写回目标（`write_back`）是两个不同字段 | 共识快照文件夹 `cord/<req-id>/` |
| **门禁（gate）** | 挂在节点上的检查点：角色 × 时机 × 校验 × 放行 | 同上，与节点定义同文件或独立文件 |
| **边（edge）** | 阶段之间的推进，以及**触发式升级**形成的旁路边（轻量通道 → 重型通道） | 由节点顺序 + 触发器声明共同决定 |

三个前提把图钉死：

1. **图是低频资产，校验逻辑是高频资产。** 流程拓扑（七步骨架）是季度级变化、需要在群里被人评审；校验逻辑（今天接 CI、明天加截图比对）是周级变化、需要工程能力。二者必须分文件、分注册表（ADR-0014）——这与 GitHub Actions 把 `run`（执行体）与 `if`（条件）分开、Temporal 把 Workflow（编排）与 Activity（执行体）分开是同一个结构性结论。
2. **图的消费者有两个是 LLM**：协调 agent（读写快照、路由、派任务）与人。因此流程定义必须是 LLM 最擅长生成与审阅的形态——带 JSON Schema 校验的 YAML，而不是藏在代码控制流里的拓扑。
3. **SSOT 是快照文件夹**，流程定义本身也是 git 仓库里的资产，可 diff、可评审、可回滚。

### 1.2 七个节点

| # | 节点 | 谁做 | 节点出口（里程碑文档） | 默认挂载的门禁 | 门禁写回目标（`write_back`） |
|---|---|---|---|---|---|
| ① | 需求进入 | 人（产品/业务 owner）把需求发给单机器人路由 | `prd.md`（需求条目 + EARS 验收规则） | 需求可执行性门（轻量：验收边界是否可机判） | `session_event` |
| ② | 对齐与共识 | 探索 agent（强模型）+ 盲评投票组 | `findings.md`（带证据锚点的现状结论，临时身份）+ `adr.md`（决策记录） | 共识入账门（无证据不入账；投票结论的锚点独立度检查） | `consensus_ledger` |
| ③ | 计划 | 协调 agent（coordinator） | `plan.md`（任务图 + 契约引用 + DoD） | 计划冻结门（契约一致性校验；涉及不可逆决策点时必须完成投票 + 人工确认） | `consensus_ledger` + `session_event` |
| ④ | 执行 | 实现 agent（弱模型，Draft-only） | 代码产物：Draft PR / diff（含契约文件变更） | 派发门（该工作单元的上下文包是否齐备） | `session_event` |
| ⑤ | 验证 | 验证 agent（强模型，与生成 agent 异构） | `findings.md` 追加验证报告（PASS / WARN / FAIL 摘要 + 链接） | 验证门（单测、集成测试、截图比对、对抗 review 投票） | `consensus_ledger` + `session_event` |
| ⑥ | 防腐 | 提交前置钩子 + 证据锚点索引 | 快照文档的**块级更新**（只更新已有的 `prd.md` / `adr.md` / `plan.md` / `findings.md`，不新增文档类型） | 影响检查门（diff ∩ 证据锚点，命中即确认共识仍成立） | `doc_block_draft` |
| ⑦ | 上线回流 | 系统 | 无新增里程碑文档（知识条目落 `cord/knowledge/`，见 [`./08-self-evolution.md`](./08-self-evolution.md)） | 回流门（复述检验通过才获得权威） | `knowledge_entry` |

关于出口的四条规则：

- **同一份快照文档可以承载多个节点出口**（`findings.md` 既在 ② 出现、又在 ⑤ 被追加），但只有**被节点声明为出口的那一层内容**才作为该门禁的输入。门禁读的是结构化的段，不是整份文档。
- **出口是封闭枚举**：节点只能声明 `prd.md` / `adr.md` / `plan.md` / `findings.md` 四种里程碑文档之一（外加执行阶段的代码产物）。新增一种里程碑文档类型需要过门禁（见 §6）。
- **执行期的临时工件不进文档位**：过程性进度（任务计划、progress、中间草稿）归事件流 `events.jsonl`，任务归档即弃，禁止晋升为长期文档。理由是这类文档只服务当次执行，留下来就是腐化源。
- **节点出口与门禁写回目标是两个字段，不可混用**：节点出口（`artifact`）回答"这个节点做完必须存在什么文档"，取值只能是四种里程碑文档之一（外加执行阶段的代码产物）；门禁写回目标（`write_back`）回答"这次校验的结论落到哪个结构化对象"，取值是另一个封闭枚举 `consensus_ledger` / `session_event` / `doc_block_draft` / `knowledge_entry`（见 §2.1、§5）。`doc_block_draft` 与 `knowledge_entry` 是写回目标，不是里程碑文档。

**和 README / [`./03-architecture.md`](./03-architecture.md) 的「七步」是什么关系**：同一流程的两个视图，不是两套流程。本节是**工作流图视角**（节点 = 阶段，门禁挂在节点上），README §4.2 与 03 章 §4 是**数据流视角**（每步给出谁在动、读写哪些文件、落什么事件）。一行映射：`进入` ↔ `进入`；`对齐与共识` ↔ `上下文剪裁 + 探索与共识`（剪裁是该节点的前置准备动作）；`计划` ↔ `计划冻结与派发`；`执行` + `验证` ↔ `执行与验证`（图上是两个节点，数据流上合成一步）；`防腐` ↔ `提交与防腐`；`上线回流` ↔ `上线与回流`。

### 1.3 为什么预定义，而不是让 agent 自由编排

这是本章最重要的一节。业界的反面证据已经足够密集：

| 自由编排的失败模式 | 证据 | agent-cord 的对应结构 |
|---|---|---|
| **agent 间错位**：A 不知道 B 已改方案、对话重置、重复劳动 | MAST 对 AutoGen / ChatDev / CrewAI 等 7 个框架、1600+ 条真实执行轨迹的分析（[arXiv 2503.13657](https://arxiv.org/abs/2503.13657)）把 14 种失败模式归为三类，其中"agent 间错位（inter-agent misalignment）"直接源于无中介的自由对话；同一研究还指出多 agent 系统相对单 agent 的增益常常极小 | agent 不互聊，只与**结构化状态**交互（ADR-0004）；阶段边界固定，交接物是里程碑文档而非对话记录 |
| **验证与终止缺陷**：agent 会跳过验证、不终止 | 同上，MAST 第三类失败；AutoGen / CrewAI 均无内建验证层 | 验证是图上的**独立强制节点**，不指望 agent 自觉；门禁由引擎在执行层强制（不是"请 agent 调用审批步骤"） |
| **编排决策不落状态**，无法回放与审计 | AutoGen GroupChat 的发言者选择是瞬时决策、不落状态；LangGraph 的 supervisor 把路由决策写进共享 state，因此可审计可回放——后者是工业界收敛方向 | 流程拓扑是静态资产，协调 agent 只做路由与派发，不需要"自己规划流程"（同时也少了一个幻觉面） |
| **没有出口约定的协作退化为"聊了几轮"** | MetaGPT 把收益明确归因于 SOP + 结构化文档交接，而非多聊几轮（[arXiv 2308.00352](https://arxiv.org/abs/2308.00352)）；ChatDev 的两两对话能 work，前提是每个阶段固定两人、固定交接物——本质是"强流程约束下的受控对话"（[arXiv 2307.07924](https://arxiv.org/abs/2307.07924)） | 每个节点有强制出口文档；门禁按出口判放行 |

同时要说清**"预定义"的边界**，避免读者误以为这是一个重型流程引擎：

- 预定义的是**骨架**（七个阶段、出口枚举、门禁挂载点），不是每个团队的具体严格程度。严格程度由模板分档 + 触发式升级决定（§5、§7），默认走最轻的那一档。
- 有节点与出口、但没有依赖图、没有门禁挂载点、没有升级触发器的做法也不够。主流 SDD 工具（spec-kit、Kiro 类）是"每阶段一个文件 + 一个命令"，适合单 agent 单需求，缺的正是这三样——所以 agent-cord 借鉴它们的模板分档思想，而不采用它们的流程模型。
- 引擎选型上刻意**不引入持久化工作流运行时**：这是协作流程，不是长事务。session 的事件溯源 + 显式状态机足够（见 [`./03-architecture.md`](./03-architecture.md) §2.5），没必要为一个 DAG 背上分布式运行时的固定成本。

---

## 2. 门禁（gate）：定义与语义

### 2.1 四要素 + 两个必需字段

门禁的定义直接来自需求：**什么角色、在什么时机、执行什么校验、结果写回哪里**——四要素；schema 上再补两个字段，缺了机制就会退化或不安全：

| 要素 | 字段 | 说明 |
|---|---|---|
| 角色 | `role` | 谁可直接发起校验（`initiators`）、谁必须确认（`approvers`）；角色是绑定知识源与能力边界的工作单元 |
| 时机 | `attach` | 挂在哪个节点（`node`）、节点前还是出口（`when`）、哪些声明式触发器（`triggers`）、路径匹配（`match`） |
| 校验 | `checks` | 按名引用校验器（`ref`）或内联 CEL（`cel`）；配置内不内嵌脚本 |
| 放行 | `pass` + `on_fail` | 放行条件（`require` / `human_confirm`）与未通过时的动作（`block` / `warn` / `escalate`） |
| **写回目标**（必需） | `write_back` + `link_entry` | 结果写到哪：封闭枚举 `consensus_ledger` / `session_event` / `doc_block_draft` / `knowledge_entry`；且必须回链共识条目 id |
| **权限声明**（必需） | `permissions.write` | 本门禁所需最小写权限，默认不含群消息代发与 git 写权限 |

### 2.2 单个门禁的定义示例

```yaml
apiVersion: agent-cord.dev/gates/v1        # 引擎同时接受 vN 与 vN-1（§8）
kind: Gate
metadata: { id: contract-freeze, name: 契约冻结 }
spec:
  role:                                  # 角色要素
    initiators: [backend, test, coordinator]
    approvers: [architect]               # prevent self-review：与 initiators 不重叠

  attach:                                # 时机要素
    node: plan                           # 七步流程之一
    when: post                           # pre = 节点前；post = 节点出口
    triggers: [contract.touched, vote.split]     # 触发器 id，见 §5.2
    match: { paths: ["**/openapi/**", "**/*.proto"] }

  checks:                                # 校验要素：三级混合，全部按名引用或纯表达式
    - ref: contract-schema-valid@official
    - ref: anchor-exists@official
    - ref: vote-consensus@official
      with:
        k: 3                             # 盲评投票的 agent 数
        difficulty_gate: non_critical    # 难度门：只投非重点 + 可机验 + 可逆决策点
        require_anchor_independence: true
    - cel: "ledger.entry('C-002').status == 'confirmed'"

  pass: { require: all, human_confirm: true }    # 契约冻结属不可逆动作，必须人工确认
  on_fail: block                                 # block | warn | escalate

  write_back: [consensus_ledger, session_event]  # 封闭枚举
  link_entry: auto                               # 写回必须回链共识条目 id

  escalate:                                      # 触发式升级
    to: heavy-contract-review                    # 升级到哪条重型通道
    approve_by: [architect]                      # 提议人/提议 agent 不能自批

  permissions: { write: [consensus_ledger] }     # 最小写权限（不含群消息、不含 git）

  timeout: { after: 24h, on_timeout: escalate_human }   # 门禁挂起（等人确认）的超时口径
```

### 2.3 结果三态

纯二态门禁（通过 / 不通过）会制造流程税：现实中大量检查的结论是"有问题但不阻塞"。因此结果定义为三态（对标 GitHub Actions 的 `continue-on-error` 语义）：

| 结果 | 由什么字段产生 | 含义 | 后续动作 |
|---|---|---|---|
| `pass` | `pass` 条件满足 | 校验通过 | 写回账本/事件流，放行 |
| `block` | `on_fail: block` | 不通过且必须处理 | 阻断推进，回写 session，通知到具体联系人（R10、R11） |
| `warn-and-continue` | `on_fail: warn` | 有风险但不阻塞 | **放行但强制留痕**：写入事件流 + 账本备注，进入下一节点时可见 |

`warn-and-continue` 必须留痕是硬约束——否则它等于静默通过，回看时无法区分"检查过没问题"与"根本没检查"。第三种 `on_fail` 取值 `escalate` 不产生独立结果，而是直接进入升级流程（§5）。

### 2.4 超时策略

门禁的挂起/恢复是 session 状态的属性（群消息只是把"人已确认"这一 Signal 送回来的通道），因此可以长时间挂起、零资源占用。但协作流程不是长事务，超时必须给出确定语义：

- **默认：超时 = 升级人工 + 维持不放行（`escalate_human`）。** 交给具体联系人并在群内推一道选择题；不因为"没人理"就自动放行——自动放行会让门禁变成可绕过的装饰。
- 团队可以显式配置为降级放行。降级不需要理由（与"默认轻量通道"的取向一致），但**降级动作本身必须留痕**，并计入介入负担统计。
- **两种超时要分开**：门禁挂起超时（等人，量级 = 小时/天）与校验器执行超时（跑插件，量级 = 秒；CEL 为 50ms 级）。两者的口径不同，不可复用同一配置。
- 超时时长按门禁分档配置（示例中的 24h 是初始值，需试点校准）。

### 2.5 权限按门禁声明最小化

单机器人路由不采用"整体只读 / 整体可写"的二元选择，而是**按门禁声明最小权限**：`permissions.write` 的取值是封闭枚举（`session_event` / `consensus_ledger` / `doc_block_draft` / `knowledge_entry`），默认不含"代发群消息"与 git 写权限。agent 全程只产 Draft、合入永远人工。这样"注册一个新门禁"不会顺带扩大机器人的权限面。

---

## 3. 三级校验器（checker）机制

### 3.1 为什么分三级

YAML 的短板是表达力：如果每个轻量条件（"diff 行数 > 500 才升级"）都要写一个外部插件，摩擦大到团队会放弃校验，或退化成在配置里内嵌 shell 字符串（等于回到"代码即配置"）。反过来，如果所有校验都内联，配置又会变成脚本集合。解法是把校验按**重量**分三级，各自的实现成本与自由度不同。

### 3.2 三个级别

| 级别 | 形态 | 适用 | 例子 | 谁维护 |
|---|---|---|---|---|
| **L1 内置校验器枚举** | 平台预置、带版本号引用 | 通用判定 | 单测通过、CI 绿、锚点存在、锚点独立度、投票一致、账本条目状态、契约 schema 合法 | 平台 |
| **L2 CEL 表达式** | 内联纯表达式 | 轻量条件：阈值、路径 pattern、字段比较 | `cel: "diff.added_lines <= 500"`、`cel: "ledger.entry('C-002').status == 'confirmed'"` | 流程使用者（团队） |
| **L3 外部校验器插件** | 进程 / 插件，按名注册 | 重型执行：调 CI、跑截图比对、LLM 评审、人工审批 | `ref: screenshot-diff@1`、`ref: ci-gate@official` | agent / 工具作者 |

CEL 档位的先例是 Kubernetes：它已把 CEL 作为 CRD 校验与准入策略的标准嵌入式语言（[K8s CEL 文档](https://kubernetes.io/docs/reference/using-api/cel/)）；GitHub rulesets 也在用同类表达式。选择 CEL 而不是自定义迷你语言，是因为它无 IO、可沙箱、且 LLM 生成可靠性高——这一点很重要，因为协调 agent 也是流程定义的作者之一。

### 3.3 CEL 沙箱红线

CEL 只做**判定**，不做执行。红线四条：

1. 只读输入：diff 元数据、账本条目字段、触发器命中证据；无文件系统、无网络、无进程。
2. 禁止随机与时间依赖（同样的输入必须给同样的结论，否则门禁不可复现）。
3. 超时限制（初值 50ms），超时即按 `on_fail` 声明处理并记录。
4. 需要"做事"的校验一律下沉到 L3 插件（包括"调外部服务问一下"）。

### 3.4 外部校验器插件的契约

L3 插件是门禁与外部世界（CI、截图比对工具、代码评审服务、测试平台）对接的唯一入口。契约必须严格，否则门禁结论无法被机器聚合：

```yaml
# 输入
session_ref: <快照文件夹引用 + 条目 id>
artifact: <被校验的产物描述>              # 例如 diff 摘要、契约文件、验证报告
trigger_evidence:                         # 必须携带触发器 id 与命中证据
  - {trigger: contract.touched, evidence: {file: "openapi/rule-submit.yaml", diff_range: "..."}}
params: {...}                             # gate 配置里 with: 传入的静态参数

# 输出（三态 + 证据锚点 + 理由 + 置信度）
result: pass | block | warn
anchors: [{kind: code|case|contract|knowledge|doc|report, anchor: "...", snapshot: {commit: <sha>, lines: "...", content_hash: "..."}}]
reason: <结构化文本>
confidence: 0.0-1.0
```

三条设计要点：

- **输出必须带证据锚点**，否则结论无法入账（"无证据不入账"对门禁结论同样成立）。锚点格式与账本条目一致，见 [`./04-consensus-ledger.md`](./04-consensus-ledger.md) §4。
- **输入必须携带触发器 id 与命中证据**：人看到的升级提议要能回答"为什么这次要升级"。否则人会一律点确认，确认疲劳一起，触发式升级机制就死了。
- **插件协议有版本、且 v1 冻结**：能力声明 `capabilities`、健康检查 `health`、执行 `check` 三个端点（协议 v1 冻结，见 [ADR-0016](./adr/ADR-0016-distribution-plugins.md)）。官方插件集与第三方插件走同一协议。

### 3.5 gate 与 checker 是两个注册表

这是"新增门禁零代码"承诺能成立的**精确边界**：

| 注册表 | 内容 | 新增它的代价 |
|---|---|---|
| **gate 注册表**（`gates/*.yaml`） | 编排：节点、触发器、引用哪些 checker、放行条件、写回目标、升级路径、权限 | **零代码**——组合已有 checker 即可 |
| **checker 注册表** | 能力声明：输入类型、输出三态、超时、所需权限、版本 | 只有引入**新种类的校验逻辑**时才写插件代码 |

用一句话说清："平台永不需要代码"是错的；**"流程使用者新增/修改门禁不需要代码"是对的**。写新 checker 属于 agent/工具作者的开发动作，走与新增 agent 相同的注册制。这个区分避免了两类失败：既不会让团队为了加一个门禁去改平台，也不会假装一切都能纯配置完成。

---

## 4. 触发式升级：默认轻量 + 声明式触发器

### 4.1 为什么默认必须轻量（ADR-0002）

重型流程平台的典型死法不是"没人用"，而是"**默认重型，但用户可以逃**"——逃的人多了，平台就只剩文档。AI 已经把编码效率提升了一大截，新流程若在这之上又加限制，用户会退回无流程的手动协作。正确的朝向是**系统替用户挡掉不必要的流程**，让"走流程"的感知成本低于"手动协调"。

因此：默认走轻量通道；系统根据信号**提议**升级，人一键确认；**降级不需要理由**（升级要证据，降级要自由度）。

### 4.2 九类触发器

触发器必须声明式配置（不硬编码），且每类都要能回答"为什么这次升级"。

| # | 触发器 id | 信号来源 | 命中后 |
|---|---|---|---|
| 1 | `contract.touched` | diff 命中接口定义文件（OpenAPI / Protobuf / JSON Schema / 类型文件） | 提议升级到契约类重型通道；契约冻结必经人工确认 |
| 2 | `cross_repo` | 依赖清单 / diff 路径跨越仓库边界 | 提议升级：增加跨仓库回归验证门 |
| 3 | `high_risk_signal` | 测试失败率突变、验证 agent 低置信度、验证报告 `FAIL` | 提议升级：增加对抗 review 投票 + 人工仲裁点 |
| 4 | `vote.split` | 盲评投票 2:1 分裂、或锚点独立度检查判定疑似同源 | 直接升级人工（不是"提议"）：分歧必须由人裁决 |
| 5 | `overturn_hotspot` | 该模块历史 `overturned` 条目比例超阈值 | 默认升级：该区域 diff 的校验强度提高，同类结论强制投票 |
| 6 | `requirement.mid_change` | 事件流收到需求中途变更事件 | 在途任务的校验强度升级 + 触发影响分析（见 [`./07-context.md`](./07-context.md) §6） |
| 7 | `path.sensitive` | diff 命中团队配置的敏感路径 pattern（金额、权限、安全相关） | 提议升级：强制人工确认 |
| 8 | `diff.size_threshold` | diff 行数 / 文件数超阈值 | 提议升级：拆解评审或增加验证门 |
| 9 | `anchor.drifted` | 重锚定三级全失败（由账本的 `entry.anchor_drifted` 事件触发） | 条目降回临时 + 触发重新验证 |

清单的两类来源：方案内部一致性（投票分歧、推翻率热点、中途变更、锚点失效四项本来就是"介入/降级信号"，只是此前没有挂到升级触发器上）与外部对标（敏感路径、规模阈值，来自 GitHub environment protection rules 的分支/路径限制与触发维度）。触发器阈值的具体数值属于需实验校准的设计参数。

### 4.3 升级是一次"选择题"，不是一次流程变更

```
命中触发器 → 系统生成升级提议（携带触发器 id + 命中证据 + 升级到哪条通道）
          → 推给人（默认推荐项 = 升级）
          → 人一键确认 / 拒绝（拒绝即留在轻量通道，留痕，不追责）
          → 确认后：在途工作单元改挂重型 gate，事件流记录升级原因
```

- **升级由系统提议、人确认**，agent 不能自行提高或降低流程严格度——否则门禁就丧失了"在执行层强制"的性质。
- **提议必须携带证据**（触发器 id + 命中路径/diff 片段/失败信号），一句话讲清"为什么这次升级"。这是防确认疲劳的关键。
- **拒绝升级要留痕但不追责**：这是校准触发器阈值的唯一数据来源。

---

## 5. 防退化设计（五条结构性保证）

这套机制的长期风险只有一个：**退化成"命令脚本集合"**——每个团队堆几十个 ad-hoc 命令，命令之间没有状态、没有顺序约束、没有统一结果约定。五条防线：

1. **平台不存在独立命令。** slash command 只是 gate 定义里的**触发入口字段**（一个 gate 可以有零到多个入口别名，多个入口可以指向同一 gate），平台解析命令 → 定位 gate → 走 gate 的 `attach` / `checks` / `write_back` 全流程。注册新流程 = 新增 gate 配置，而不是注册一个新 handler。这条是防退化的条款本体：命令的生命周期被绑定在一个已有状态与写回约定的对象上。
2. **写回目标是封闭枚举**：`consensus_ledger` / `session_event` / `doc_block_draft` / `knowledge_entry`。禁止把结果写成自由文本散落各处；写回必须回链共识条目 id。
3. **状态与顺序由 session 持有**，群消息只是 Signal 通道。gate 之间的先后关系不通过命令互相调用表达，而是由图拓扑与 session 状态机表达；审批的等待/恢复进事件流，可审计可回放。
4. **校验执行体按名引用，配置内不内嵌脚本**：`checks[].ref` 只写名字与版本，脚本活在自己的注册表里。这保证 YAML 不会长成代码。
5. **门禁配置的变更自身也要过门禁。** 修改 `gates/*.yaml` 的变更命中"流程定义"敏感路径，自动挂载重型 gate，且 **prevent self-review**：改门禁的人和提议改流程的 agent 不能自批放行。否则"agent 改流程 + agent 放行"构成一个自循环，整个门禁体系形同虚设。

---

## 6. 平台默认模板：分档 + 覆盖 + 组织最低集

首批用户的接入成本取决于"默认配置由谁提供"。答案是有强先例的三层模式（对标 GitHub 的 starter workflows + reusable workflows + rulesets required workflows）：

| 层 | 提供方 | 内容 |
|---|---|---|
| **模板（默认）** | 平台 | 按需求类型分档。**快速通道模板**为默认：仅需求可执行性门（`warn` 语义）+ 提交关联门（L1）；**契约/高风险模板**：对齐门 + 计划冻结门 + 验证门 + 影响检查门，多个 `block` |
| **覆盖** | 团队 | 团队可覆盖模板中的任何非强制项：增删 gate、改 `on_fail`、换 checker、调触发器阈值——全部是配置动作，不改平台代码 |
| **最低集** | 组织 | 组织可强制若干 gate 必须挂载且不可覆盖（例如"契约冻结必经人工确认""防腐影响检查必须启用"）。强制项用配置表达并随仓库版本化 |

配置落点：

```
cord.toml              # 选用的模板、组织最低集引用、布局/事件 schema 版本（见 ADR-0010）
gates/*.yaml           # 团队覆盖后的流程与门禁定义（与代码同仓，随 PR 评审）
checkers/              # 仅当团队引入新种类校验逻辑时存在
```

模板的职责是让"开箱即用"与"默认轻量"同时成立：默认挂上的门禁都是低摩擦的（`warn` 或近乎零成本），重型门禁靠触发器按需挂上。

---

## 7. 完整示例：一个含三个门禁的需求流程

```yaml
apiVersion: agent-cord.dev/gates/v1
kind: Workflow
metadata: { id: standard-feature, name: 中等需求标准流程 }
spec:
  template: quick-lane               # 从快速通道模板派生
  nodes:                                   # artifact = 节点出口（里程碑文档，封闭枚举：prd.md / adr.md / plan.md / findings.md）
    - { id: intake,  stage: 进入,       artifact: prd.md,           gates: [intake-check] }
    - { id: align,   stage: 对齐与共识, artifact: [findings.md, adr.md], gates: [] }
    - { id: plan,    stage: 计划,       artifact: plan.md,          gates: [plan-freeze] }
    - { id: execute, stage: 执行,       artifact: code_artifact,    gates: [] }   # 执行阶段的产物是代码变更（Draft PR / diff）
    - { id: verify,  stage: 验证,       artifact: findings.md,      gates: [acceptance-check] }
    - { id: submit,  stage: 防腐,       gates: [anchor-impact] }   # 无里程碑文档出口：只对已有文档做块级更新（写回目标才是 doc_block_draft）
    - { id: upturn,  stage: 上线回流,   gates: [] }                # 无里程碑文档出口：知识条目写 cord/knowledge/（写回目标才是 knowledge_entry）
  enforced: [plan-freeze, anchor-impact]      # 组织最低集：不可被团队覆盖删除
---
apiVersion: agent-cord.dev/gates/v1
kind: Gate
metadata: { id: intake-check, name: 需求可执行性 }
spec:
  role: { initiators: [coordinator], approvers: [product] }
  attach:
    node: intake
    when: post
    triggers: [requirement.opened]
  checks:
    - ref: ears-acceptance-parseable@official     # 验收规则是否可机判
    - ref: requirement-anchor-exists@official     # 每条验收规则是否有锚点
  pass: { require: all }
  on_fail: warn                                   # 缺验收规则不阻塞，但必须留痕
  write_back: [session_event]
  link_entry: auto
  escalate: { to: heavy-requirement-review, approve_by: [product] }
  permissions: { write: [session_event] }
---
apiVersion: agent-cord.dev/gates/v1
kind: Gate
metadata: { id: plan-freeze, name: 计划冻结 }
spec:
  role: { initiators: [coordinator], approvers: [backend, architect] }
  attach:
    node: plan
    when: post
    triggers: [contract.touched, high_risk_signal, diff.size_threshold]
    match: { paths: ["**/openapi/**", "**/*.proto"] }
  checks:
    - ref: contract-schema-valid@official
    - ref: anchor-exists@official
    - ref: vote-consensus@official
      with: { k: 3, difficulty_gate: non_critical, require_anchor_independence: true }
    - cel: "ledger.entries('plan').map(e, e.status).all(s, s == 'confirmed')"
  pass: { require: all, human_confirm: true }     # 契约冻结为不可逆动作
  on_fail: block
  write_back: [consensus_ledger, doc_block_draft]
  link_entry: auto
  escalate: { to: heavy-contract-review, approve_by: [architect] }   # prevent self-review
  permissions: { write: [consensus_ledger, doc_block_draft] }
  timeout: { after: 24h, on_timeout: escalate_human }
---
apiVersion: agent-cord.dev/gates/v1
kind: Gate
metadata: { id: anchor-impact, name: 影响检查（防腐） }
spec:
  role: { initiators: [commit_hook], approvers: [file_owner] }
  attach:
    node: submit
    when: post
    triggers: [contract.touched, path.sensitive, overturn_hotspot, anchor.drifted]
  checks:
    - ref: anchor-intersect@official
      with:
        granularity: symbol                      # 符号级求交 + 文件级粗筛
        ignore_revs: .cord-blame-ignore-revs
    - ref: ledger-still-valid@official           # 命中即要求确认条目仍成立
  pass: { require: all, human_confirm: true }    # 命中后的放行 = 人确认，或走推翻流程
  on_fail: block                                 # 未命中不触发本门禁；命中未确认即阻断
  write_back: [doc_block_draft]
  link_entry: auto
  escalate: { to: heavy-contract-review, approve_by: [architect] }
  permissions: { write: [doc_block_draft, session_event] }
  timeout: { after: 72h, on_timeout: escalate_human }
```

可读性说明：`plan-freeze` 与 `anchor-impact` 被列为组织强制项，任何覆盖都不能删掉它们；`intake-check` 是 `warn` 语义，缺验收边界不阻塞但留痕，这是"默认轻量"的具体形态。

---

## 8. schema 版本演进策略

流程定义与门禁定义是长期资产，必须能演进：

1. **每个定义文件头带 `apiVersion`**（当前 `agent-cord.dev/gates/v1`），解析器据此分派；`kind` 区分 `Workflow` / `Gate` / `Checker`。workflow / gate / agent / 知识条目 frontmatter 全在同一版本策略下。
2. **仓库内置 JSON Schema，严格校验**：`additionalProperties: false`——未知字段直接拒绝加载，而不是静默忽略。静默忽略会让"我明明配了但没生效"变成常态。
3. **引擎同时接受 N 与 N-1 两个版本**（对标 Kubernetes CRD 的多版本与转换策略）：新版本发布后，旧文件至少在一个大版本周期内继续可加载，给出弃用告警。
4. **非破坏性变更留在 v1 内**（新增可选字段、新增内置 checker、新增触发器 id）。
5. **破坏性变更升 v2 + 提供迁移脚本**：语义变更（例如改变默认超时行为、改变 `on_fail` 默认值）必须升版本；配套 `cord doctor` / `cord upgrade --to v2` 做检测与批量迁移，且迁移结果以 diff 形式可评审。
6. **事件 schema 同样带版本**：事件流里的每条事件带 `schema_version` 字段，`cord.toml` 记录当前布局/事件版本；回放器按版本分派（见 [ADR-0010](./adr/ADR-0010-ssot-storage.md)）。

---

## 9. 尚未实现与待校准项

本章机制为设计定稿，**代码未实现**。以下是明确的开放项，不掩盖：

| 项 | 现状 | 校准方式 |
|---|---|---|
| CEL 档位的实际覆盖度 | 未知——有多少团队自定义校验能落在 CEL 内而不必写插件 | 试点统计插件/CEL 比例 |
| 内置校验器枚举的最终清单 | 当前是示例清单，非冻结 | 随官方插件集 v1 冻结 |
| 九类触发器的阈值 | 全部未定（diff 行数、失败率突变幅度、推翻率阈值等） | 需内部返工相关性数据 + 试点数据校准；补数据前阈值取保守值 |
| 超时时长与超时默认行为 | 默认"升级人工 + 不放行"，时长 24h 为初值 | 试点统计人的实际响应时间分布 |
| 组织最低集的边界 | 哪些 gate 属于"必须强制"尚无结论 | 由首个组织的试点经验决定 |
| 引擎兼容窗口长度 | 同时接受 N / N-1 已定，窗口长度未定 | 随发布节奏定，写入仓库的发布说明 |
| prevent self-review 的例外 | 单人家族仓库（无第二审批人）如何放行 | 需给出降级路径（例如强制留痕 + 延迟生效） |

门禁误伤率的度量与阈值（影响检查门命中但无需处理的比例）在 [`./07-context.md`](./07-context.md) §5 中展开，与锚点工程解一起校准。

---

## 10. 小结

- 流程是**预定义的有向图**：七阶段节点、四种里程碑文档作为出口、门禁挂在节点上。预定义的理由不是保守，而是业界失败数据（MAST 的错位类与验证终止类失败）与成功结构（SOP + 结构化交接）都指向同一个结论。
- 门禁的定义是四要素（角色 × 时机 × 校验 × 放行）+ schema 上两个必需字段（写回目标、权限）；结果三态 `pass` / `block` / `warn-and-continue`，分别由 `pass` 条件与 `on_fail` 取值产生；写回一律回链条目 id。
- 校验器分三级（内置枚举 / CEL / 外部插件），gate 与 checker 是两个注册表——这是"新增门禁零代码"能成立而不掺水的精确边界。
- 默认轻量、触发式升级（九类声明式触发器）；升级必须携带证据，降级不需要理由。
- 防退化的核心条款只有一句：**平台不存在独立命令，slash command 只是门禁的触发入口字段**；门禁配置自身的变更也要过门禁。
