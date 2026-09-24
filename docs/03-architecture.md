# 03 · 总体架构

> 状态：**设计定稿，代码未实现**（本方案全部章节均处此状态）。
> 本章把定位（ADR-0001）、共识载体（ADR-0003/0005）、运行形态（ADR-0009/0011/0012/0013/0014/0016）等已定稿决策收敛成一张可实现的系统图。
> 术语一律使用方案术语表（共识快照 / 全局 session / 协调 agent / 共识账本 / 事件流 / 快照文档 / 证据锚点 / 门禁 / 校验器 / 触发式升级 / 盲评投票 / 难度门 / 锚点独立度 / 上下文包 / 知识条目 / 复述检验 / 单机器人路由）。

## 本章回答什么问题

第一次接触 agent-cord 的读者读完本章，应能回答八个问题：

1. 系统由哪几层构成，每层负责什么、明确不负责什么？
2. 「全局 session」和「共识快照文件夹」是一个东西还是两个东西？
3. daemon 内部有哪些模块，各自输入输出是什么，读写快照文件夹的哪一部分？
4. 模块之间的接口契约长什么样（事件 envelope、AgentDriver、ProviderAdapter、插件 IPC、gate YAML）？
5. 一个需求从进入到上线回流，数据在模块与文件之间怎么流动？
6. 快照文件夹的标准布局是什么，三层（事件流 / 账本 / 快照文档）为什么能共存？
7. 协调 agent 为什么不容易幻觉，隔离靠什么强制而不是靠自觉？
8. 它怎么部署、怎么重启、崩了会丢什么？

读法建议：先读 §1（总览图 + 地基定义），再按需跳读。想先理解「为什么这么设计」，可先看 [ADR 索引](./adr/README.md)。

---

## 1. 架构总览

### 1.1 三层架构与运行形态的融合图

三层架构（交互捕获层 / 翻译层 / 结构化状态层）是**按职责**的切分；运行形态（常驻 daemon + 薄 CLI 客户端 + 库导出）是**按进程**的切分。两者不是两套设计，而是同一套模块的两种视图：翻译层与结构化状态层的全部逻辑住在 daemon 进程内，交互捕获层则一半在 IM 平台、一半在 daemon 的 adapter 模块里。

```
════════════════════════════════════════════════════════════════════════════
 交互捕获层（会场，不是档案）
   飞书群（人机同席的圆桌）/ Slack / Discord / 纯 CLI 终端
   人在这里说话、发文档、发标注、发 slash command、点卡片选项
   · 只做两件事：把人的输入送进来；把结构化状态以摘要/选择题推回去
   · 明确不是 SSOT：群消息是事件源，不是事实来源（ADR-0003）
════════════════════════════════┬═══════════════════════════════════════════
                                │ ingress：IM 官方 SDK 长连接优先；
                                │ webhook 只在需要公网的部署形态做前端
════════════════════════════════▼═══════════════════════════════════════════
 翻译层 + 结构化状态层   cord daemon（常驻核心；不持有不可重建的状态）

   adapter ──▶ normalizer ──▶ append_event ──▶ dispatcher（进程内分发）
      ▲            │              │                 │
      │            │ 低置信度     │ 事件流 = 唯一   ├──▶ router（单机器人路由）
      │            └─▶ 反问卡片 ─▶│ 事实与顺序来源  │       │ 高置信度
      │               （留痕）    │                 │       ▼
      │                           │                 │  workflow engine
      │                           │                 │  （预定义有向图 + gate 求值 +
      │                           │                 │    状态机持有挂起/恢复）
      │                           │                 │       │
      │                           │                 │       ├──▶ coordinator（协调 agent）
      │                           │                 │       │      只持最新快照上下文
      │                           │                 │       │       ├──▶ AgentDriver
      │                           │                 │       │       │      └─▶ 角色 agent 子进程
      │                           │                 │       │       │          claude/codex/kimi/gemini
      │                           │                 │       │       ├──▶ voting ─▶ ProviderAdapter ─▶ 模型 API
      │                           │                 │       │       ├──▶ knowledge（FTS5 派生索引）
      │                           │                 │       │       └──▶ plugins（IPC 插件宿主）
      │                           └─────────────────┴───────┴──▶ 唯一写路径：
      │                                                          append_event + Draft 通道
════════════════════════════════┬═══════════════════════════════════════════
        读：context pack          │  写：事件（append-only）
        （前置高信号层 + 定位符层）│  ✗ 永不读：events.jsonl
════════════════════════════════▼═══════════════════════════════════════════
 结构化状态层：共识快照文件夹（SSOT 的物化形态）

   cord/<req-id>/prd.md adr.md plan.md findings.md  最新层（人可编辑、可主动清理）
   cord/<req-id>/ledger.yaml                         机判层（事件流的确定性投影）
   cord/<req-id>/votes/                              投票记录全文（权威留痕，入 git）
   cord/<req-id>/events.jsonl                        历史层（append-only、永不清理、入 git）
   cord/knowledge/               跨需求知识库
   cord/.index/                  派生索引（gitignore，可 `kb reindex` 重建）
   cord/cord.toml                布局版本 / schema 版本 / 配置
   git = 版本化权威（事件流经 merge driver 并集合并）
════════════════════════════════════════════════════════════════════════════
```

图里有三条骨架：

- **上行只有一条：ingress 进事件。** 人的任何输入（一句话变更、一张截图标注、一个文档链接、一次卡片点选）都必须先变成一条结构化事件，才可能影响系统状态（ADR-0003）。
- **下行只有一条：Draft 与选择题出。** 系统对人的输出只有两种形态——给选择题（人做决策）、给 Draft（人做合入）。agent 全程只产 Draft，合入永远人工。
- **中间只有一条写路径：`append_event` + Draft 通道。** 一切会改变判定结果的写入都经过它。

### 1.2 地基问题：全局 session 是逻辑概念，共识快照文件夹是它的物化形态

这是全案最容易读错的一处，必须先钉死：

> **不是两层系统，是同一实体的两个视图。**
>
> - **全局 session = 逻辑视图**：一个需求的全部决策、变更、证据、交互的结构化载体。锚定单位是**单个需求**（一个需求 ↔ 一个全局 session）。它是领域模型里的概念，不占磁盘、不占进程。
> - **共识快照文件夹 = 物理视图**：`cord/<req-id>/` 目录，连同其中的快照文档、`ledger.yaml`、`events.jsonl` 与承载它的 git 历史。它是全局 session 在文件系统上的唯一物化形态。

因此下列说法在本方案中是等价的，不存在「同步两份东西」的问题：

| 说法 | 落到的文件/对象 |
|---|---|
| 全局 session 的状态 | `cord/<req-id>/` 目录的当前内容 + 事件流折叠出的状态 |
| 把变更写入 session | 向 `events.jsonl` 追加一条事件，并投影到 `ledger.yaml` / 快照文档草案 |
| session 的历史 | `events.jsonl` 全文 + git 提交历史 |
| session 的当前共识 | `ledger.yaml` 的 confirmed 条目集合（机判）+ 快照文档（显示） |

一个推论值得单独说清：**群不是 session 的载体，文件夹也不是「另一个」session。** 群是会场、账本是档案（ADR-0003）。「变更散落在群聊里没有统一载体」正是本项目要消灭的现状，所以群永远不会被当作事实来源；而文件夹也从不维护第二份真相——它本身就是真相的唯一形态。

### 1.3 三条架构级不变量

后面所有模块设计都从这三条推出，出现冲突时以它们为准：

1. **判定只查事件流与账本，frontmatter 只是显示层。** 任何「这条共识成立吗 / 这个门禁过了吗 / 这票投了什么」的判断，都必须能在 `events.jsonl`（或由它确定性投影出的 `ledger.yaml`）里找到依据；文档头部 frontmatter 里的状态字段是给人一眼看懂的，可能滞后，永不参与判定。
2. **事件流永不进 LLM 上下文。** `events.jsonl` 是人审计与程序查询用的历史层；agent 只消费投影（快照文档 + 上下文包）。违反它的后果是上下文腐化——「我们有完整历史」会变成「把历史全塞进 prompt」。
3. **写操作必经路由。** coordinator、角色 agent、插件都不直接改 SSOT；一切状态变化经 daemon 的单一写路径落成事件，一切对人的输出经 router 回到会场。

---

## 2. 模块划分（daemon 内部）

daemon 是唯一的常驻进程，内部按职责切成九个模块。模块之间只通过两类东西耦合：**事件**（进程内 dispatcher 分发）与**显式函数调用**（同进程同步接口）。CLI 客户端与插件在进程外，分别走本地 IPC/HTTP 与插件 IPC 协议。

模块总览（R=读、W=写；「投影」= 可删除重建的派生内容）：

| # | 模块 | 一句话职责 | 快照文档 | ledger.yaml | events.jsonl | knowledge/ |
|---|---|---|---|---|---|---|
| 1 | adapter | 各入口（IM / CLI）的薄适配器 | — | — | W（经 append_event） | — |
| 2 | normalizer | 平台原始事件 → 统一 NormalizedEvent | — | — | W（经 append_event） | — |
| 3 | router | 单机器人路由：解析输入、推回摘要/选择题 | R（投影） | R（投影） | — | R（检索） |
| 4 | coordinator | 快照协调 agent：派任务、产草案、判分歧 | R + W（仅 Draft） | R | **✗ 永不读** | R（经工具） |
| 5 | workflow engine | 预定义有向图 + gate 求值 + 挂起/恢复 | R（节点出口产物） | R | W（状态迁移事件） | — |
| 6 | AgentDriver | 每任务 subprocess 驱动 headless CLI | — | — | W（结论/usage/引用） | — |
| 7 | voting | 投票编排 + ProviderAdapter 直连判定 | R（只读快照） | W（投票记录，经事件） | W | R（注入） |
| 8 | knowledge | 知识库与 FTS5 派生索引 | — | R（抽取来源） | W（晋升/废止事件） | R + W |
| 9 | plugins | IPC 插件宿主（校验器/适配器供能） | — | — | — | — |

### 2.1 adapter —— 交互捕获层的端口

**职责**：把各入口的原始输入变成平台内部事件，把平台的输出渲染回各入口。它是「不绑定特定 IM」承诺在代码层的兑现点（ADR-0012/ADR-0016）。

**接口**：入 = 飞书长连接、Slack Socket Mode、Discord Gateway + Interactions、CLI stdin，以及可选部署形态下的 webhook ingress（验签 + 去重 + 快速 ACK）；出 = 平台原始消息（平台侧 id、发送者、会话 id、原文、附件引用）或渲染后的出站消息/交互卡片。

**与快照文件夹的关系**：只写事件（经 `append_event`），不碰文档与账本；附件落盘在工作区，事件里只留引用与 hash。

**边界**：不做业务解析（「这句话什么意思」不是 adapter 的事）；入站必须**先落盘再处理**（飞书要求 3 秒内响应）；幂等键取平台 message id / delivery id；出站只允许「摘要（3-5 句结论，默认折叠）」与「选择题（选项 + 超时 + 默认兜底）」两种形态，**不允许出现论述题**。**纯 CLI 也是适配器**：stdin 一行消息 → NormalizedEvent（`actor=human`、`source.adapter=cli`），选择题渲染为编号选项 + 输入循环；「同一事件模型」由类型系统强制，而非靠纪律。

### 2.2 normalizer —— 归一化与去重

**职责**：把各平台千差万别的原始事件清洗成唯一的 `NormalizedEvent`（§3.1），完成验签、去重、时间戳规范化、凭证脱敏。

**接口**：入 = adapter 的平台原始事件；出 = 一条 `NormalizedEvent`，交给 `append_event` 落盘，再由 dispatcher 分发。

**与快照文件夹的关系**：唯一写动作是 `append_event`（append-only，不修改历史行）。

**边界**：**不做意图判断**（消息是需求变更还是闲聊由 router 判定，这里只保证形态正确）；**凭证脱敏默认开启**（事件流会进 git，一次误粘贴的 token 会永久留在历史里）；重复投递按平台 id 丢弃并记一条对账事件，不静默吞掉。

### 2.3 router —— 单机器人路由（翻译层核心）

**职责**：把结构化群消息解析成结构化事件（意图 + 路由目标 + 参数），把状态变化渲染成推回会场的摘要/选择题；解析不确定时**反问而不是猜**（ADR-0004）。

**接口**：入 = `im.message.received` / `cli.message.received` 事件；出 = `route.parsed`（含置信度与命中的路由目标）或 `route.clarification_requested`（反问卡片），以及到后端模块的任务调用。

**与快照文件夹的关系**：只读投影视图（当前快照摘要、confirmed 条目清单、待办选择题），用于生成摘要与候选选项；**不直接写任何文件**，写操作一律转交 coordinator / workflow engine 走事件路径。

**边界（全系统单点，要求最严）**：意图集合**封闭**——路由目标只能是已注册的角色、已注册的 gate、固定的几条元指令，LLM 只做受限分类，不自由生成目标；解析结果与置信度必须一起落事件（原文 → 结构化结果 → 置信度 → top-2 候选，全部可回放）；低置信度或 top-2 接近 → **强制反问**，且反问本身也是事件（可统计理解错误率，兼作实验数据源，见 <https://arxiv.org/abs/2307.07924>）；权限收敛为「只读路由 + 白名单代写」，解析错误的最大后果被压到「说错话 / 记错账」；平台**不注册独立命令**——slash command 只是 gate 的触发入口字段，命令不能绕过门禁改状态（ADR-0014 防退化条款）。

### 2.4 coordinator —— 协调 agent

**职责**：以「只持有最新快照上下文」为前提做需求级协调：把结构化事件翻译成给角色 agent 的任务，把结论投影成快照文档草案，把需要人判断的事变成选择题，把分歧交给投票与门禁。

**接口**：入 = dispatcher 分发的业务事件、上下文包中的最新快照投影、角色 agent 返回的结构化结论；出 = 任务派发（给 AgentDriver / voting）、文档草案（Draft）、选择题（经 router 推回会场）、判定请求（给 workflow engine 的 gate 求值）。

**与快照文件夹的关系**：读快照文档（最新层）、`ledger.yaml` 的投影视图、知识库检索结果；写**只产 Draft**（块级文档草案、条目草案），经 `append_event` 记 `doc.draft_created`，合入由人或门禁触发时才落定；**永不读 `events.jsonl`**（见 §6）。

**边界**：不持有长会话（每轮路由都是「取快照 → 派任务 → 收结论」，与常驻会话池的连续性假设天然不契合，ADR-0011）；不直接改判定数据（它提议，门禁与账本裁决）；不做角色 agent 的活——不写代码、不做审查判定。

### 2.5 workflow engine —— 预定义有向图与门禁

**职责**：持有工作流拓扑与状态机；在节点上求值 gate（角色 × 时机 × 校验 × 放行条件），按结果放行/拦截/升级；持有挂起与恢复。

**接口**：入 = 事件（gate 触发信号、人工确认、校验器返回值）；出 = 节点迁移事件（`workflow.node.entered/exited`）、gate 判定事件（`gate.passed` / `gate.blocked` / `gate.escalated`）、放行或阻断结果、升级选择题。

**与快照文件夹的关系**：读节点出口的里程碑产物（`prd.md` / `adr.md` / `plan.md` / `findings.md`，封闭枚举）；所有状态迁移经 `append_event`；产物「冻结」体现为事件 + 文档标记，不靠文件锁。

**边界**：图是**预定义的低频资产**（拓扑季度级变化、需群里可评审），校验逻辑是周级变化、需工程能力，两者分文件分注册表，这是「新增 gate 零代码」在操作闭包上成立的前提（ADR-0014）；**吸收 Temporal 的执行语义但不是 Temporal**——门禁等待 = 状态挂起到收到 Signal（人的卡片点选或校验器回调），等待期间不占资源，审批记录持久化在事件流，因此重启后挂起态可重建；超时按「升级人工」处理，**不放行**（ADR-0002）；改门禁配置的变更自身也要过门禁，改的人不能自批。

### 2.6 AgentDriver —— agent 运行时

**职责**：以「每任务一个 subprocess」为基座，驱动 headless CLI（claude / codex / kimi / gemini 等）执行角色 agent 的任务，把输出收敛为结构化结果。

**接口**：入 = `AgentTask`（角色、prompt、工作目录、工具白名单、权限档、turn/预算上限、上下文包引用、目标输出 schema）；出 = `AgentResult`（状态、最终文本、结构化结论、证据锚点、usage、CLI 版本、session id、transcript 路径）。

**与快照文件夹的关系**：工作目录是**独立临时 worktree**，绝不指向 SSOT；产出（结论、锚点、usage、transcript）由平台写回事件流。

**边界**：只依赖各 CLI 的**稳定子集**（print 模式、machine-readable 输出、resume、工具/权限参数、turn/budget 上限），不解析人类可读输出，不泄漏任何一家 SDK 的专有类型（ADR-0011）；版本探测 + 优雅降级（多个 flag 有「requires vX.Y.Z or later」，缺 flag 要降级而非崩溃）；隔离由「每任务新进程 + 独立 worktree + 独立 env」天然获得，不靠提示词约束；**生成侧才用 CLI**，判定侧走 ProviderAdapter（ADR-0013）；角色 agent 一律只产 Draft，无 SSOT 写权限、无合入权。

### 2.7 voting —— 投票编排与判定执行器

**职责**：对通过难度门的决策点组织 k=2~3 次独立盲评，做锚点独立度检查与放行判定，把结果作为投票记录写回账本（细节见 [05-voting.md](./05-voting.md)）。

**接口**：入 = 决策点（结构化选项集、难度桶、可机验性标志）与受控上下文；出 = `vote.completed` 事件 + 投票记录（含少数派理由、锚点重合度、permutation、usage）与判定 `confirmed` / `needs_verification` / `escalated_anchor_overlap`。

**与快照文件夹的关系**：读只读快照 + 锚点指向的代码快照；写只经事件，投票记录最终嵌入账本条目。

**边界**：只投**非重点 + 可机验 + 可逆**的决策点；语义理解类即使 2/2 一致也落 `needs_verification`；**不辩论、不共享中间推理**，且不共享位置（per-agent 选项随机置换，permutation 记入记录）；**判定 agent 与生成 agent 必须异构**；锚点重合（Jaccard ≥ 0.5）→ 疑似同源错误 → 强制升级人工；重试一次仍失败则该票记 `abstain`，不阻塞整体。

### 2.8 knowledge —— 跨需求知识库

**职责**：沉淀跨需求的规则 / 术语 / 踩坑（KB-xxxx），管理其生命周期与检索，供上下文包注入（细节见 [08-self-evolution.md](./08-self-evolution.md)）。

**接口**：入 = 需求归档时的账本条目（规则抽取）、bad case 回流信号、复述检验结果、人工确认；出 = 知识条目文件（Markdown + frontmatter）、FTS5 派生索引、注入上下文包的条目清单。

**与快照文件夹的关系**：`cord/knowledge/` 是唯一跨需求目录；从各需求 `ledger.yaml` **抽取**（不是移动）条目入库；索引是派生层，可 `kb reindex` 全量重建。

**边界**：文件是唯一 SSOT、数据库是缓存（ADR-0015）；起步走符号/词法检索（FTS5 BM25 + frontmatter 过滤 + 条目间链接），**不走 embedding**——条目注入上下文即获权威，「为什么注入这条」必须可解释；生命周期 = 状态机 + 门禁复用，生效需过**复述检验**（与抽取 agent 异构的 agent 盲写 + 固定问卷比对）**加人点确认**，废止为软删除且全文保留；写入只有一条路径（门禁钩子内同步更新索引）；注入配额——生效条目进上下文包层 1 且有硬上限，候选条目只进层 2 由 agent JIT 拉取。

### 2.9 plugins —— 插件宿主

**职责**：为「新种类的校验逻辑」与「新入口平台」提供扩展点；以 IPC 进程装载第三方插件，并让配置层能引用插件声明的能力（ADR-0016）。

**接口**：入 = 插件的能力声明与 gate 求值时的 `check` 调用；出 = 插件注册表（能力清单 + 参数 schema）、`check` 结果（三态 + 证据锚点 + 机器可读理由 + 置信度）、`health` 状态。

**与快照文件夹的关系**：插件不直接读写 SSOT；它只拿到宿主显式注入的产物描述与锚点，一切写回由宿主经事件路径完成。

**边界**：三层插件分工不同（纯配置层组合已有能力、声明式 markdown 层、IPC 进程插件层提供新能力），**配置只能组合能力，插件才能提供能力**；**禁止插件注册自由命令**，否则平台退化成脚本集合；**官方插件集走同一 IPC 协议**，不允许开后门；最小权限（插件只拿到注入的 stdin JSON 与环境变量，凭证走环境/短时效 token）；marketplace 清单**只做发现不做执行**，安装需锁 commit/tag。

---

## 3. 关键接口边界

接口即协议：它同时是运行时校验、编译期类型与对外契约。

### 3.1 NormalizedEvent envelope

所有进入系统的事件共用同一个信封（ADR-0012）。它是**唯一事实与顺序来源**的书写格式，也是回放实验的数据格式。

```jsonc
{
  "event_id": "01J9Z3K7...",        // ULID，全局唯一；消费端幂等去重键
  "seq": 42,                        // 单 session 内单调递增，顺序的唯一依据
  "type": "im.message.received",    // 点分层命名，事件即 API
  "schema_version": "1",            // 解析器按版本分派
  "timestamp": "2026-09-24T12:00:00.000Z",
  "actor":   { "kind": "human|agent|system", "id": "ou_...", "display": "..." },
  "session_id": "REQ-2026-014",     // 全局 session（= 需求文件夹）
  "correlation_id": "01J9Z3K7...",  // 因果链：本事件因哪条事件/哪次外部调用产生
  "source":  { "adapter": "feishu|slack|discord|cli|system",
               "raw_id": "om_...",  // 平台侧幂等键（去重依据）
               "channel": "oc_..." },
  "payload": { }                    // 按 type 定义，受 JSON Schema 约束
}
```

要点：**顺序以 `seq` 为准而非到达时间**（IM 不保证顺序且会乱序重投，`seq` 由单一写入者在追加时分配）；**幂等**（入站按 `source.raw_id` 去重，消费端按 `event_id` 去重，天然支持至少一次投递）；**类型封闭 + 家族命名**（`im.*` / `cli.*` / `route.*` / `req.*` / `context.*` / `plan.*` / `workflow.*` / `gate.*` / `vote.*` / `ledger.*` / `knowledge.*` / `doc.*` / `anti_rot.*` / `system.*`，新增类型走 ADR，改字段走 `schema_version`）；**脱敏在写入前完成**；**事件流不进 LLM 上下文**——envelope 是给程序和人看的。

### 3.2 AgentDriver 接口

驱动生成侧角色 agent 的统一原语（ADR-0011），刻意做小，只覆盖所有 CLI 都稳定的能力子集。

```ts
interface AgentDriver {
  readonly id: string;                       // claude-code | codex | kimi | gemini | ...
  probe(): Promise<{ cliVersion: string; capabilities: string[] }>;
  run(task: AgentTask): Promise<AgentResult>;
  resume(sessionId: string, task: AgentTask, opts?: { fork?: boolean }): Promise<AgentResult>;
  cancel(handle: TaskHandle): Promise<void>;
}

interface AgentTask {
  task_id: string;
  role: string;                   // 探索 / 实现 / 验证 / 评审 ...
  prompt: string;
  cwd: string;                    // 独立临时 worktree，绝不指向 SSOT
  context_pack: string;           // 上下文包引用（层1 + 层2）
  tools?: { allow?: string[]; deny?: string[] };  // 按角色裁剪，评审票只给只读
  permission_mode?: "plan" | "dontAsk";
  max_turns?: number;
  max_budget_usd?: number;        // 硬预算熔断
  output_schema?: JsonSchema;     // 要求的结构化结论形态
}

interface AgentResult {
  status: "ok" | "failed" | "timeout";
  final_text?: string;
  structured?: unknown;           // 符合 output_schema 的结论
  anchors: EvidenceAnchor[];      // 符号锚点 + commit SHA + 行号（显示层）
  session_id?: string;            // 供 resume
  usage: Usage;                   // 逐次采集，供成本核算
  cli_version: string;            // 与结果一起落事件，保证可回溯
  transcript_path?: string;
  exit_code: number;
}
```

契约要点：只走官方 machine-readable 模式；不做 SDK 内嵌；`probe()` 在启动与 CI 冒烟中各跑一次；resume 依赖各家 session 文件约定，跨家差异由适配器抹平；`fork` 不可用时降级为新会话而不是报错。

### 3.3 ProviderAdapter 接口

投票与判定的执行器（ADR-0013）：直连模型 API，锁模型版本、`temperature=0`、结构化输出、逐次 usage。

```ts
interface ProviderAdapter {
  readonly provider: string;               // anthropic | openai-compatible | gemini | ...
  capabilities(): { structured_output: boolean; thinking: boolean; max_context: number };
  complete(req: VoteRequest): Promise<VoteResult>;
}

interface VoteRequest {
  model_id: string;            // 必须带版本后缀，如 claude-sonnet-4-5-20250929
  temperature: 0;
  system_prompt: string;       // 净输入：不含他人结论、不含人工结论
  user_prompt: string;
  response_schema: JsonSchema; // 结论 + 证据锚点 + 置信度
  timeout_ms: number;
}

interface VoteResult {
  parsed_json: unknown;
  raw_usage: Usage;            // 逐次采集（token / 成本）
  request_id: string;
  model_id_resolved: string;   // 服务端实际解析到的版本，写进投票记录
  latency_ms: number;
}
```

契约要点：模型版本必须锁定并落库，否则「可复现」落空；`prompt_hash` 与 `model_id@version` 写入投票记录（回放实验的复现依据）；OpenAI 兼容族共用一个适配器；新增 provider = 新增一个适配器文件 + 配置，零平台代码改动；LiteLLM 一类工具只能作为写适配器的加速件，其类型不得泄漏进平台核心。

### 3.4 插件 IPC 协议 v1（冻结）

宿主 spawn 插件进程，双方以 JSON 帧交换消息（ADR-0016）。**协议 v1 即冻结**：只承诺三种消息 + 版本协商。

| 消息 | 方向 | 载荷要点 | 语义 |
|---|---|---|---|
| `capabilities` | 插件 → 宿主 | 能力名 + 参数 JSON Schema + 输出三态 + 超时默认值 + 所需权限 | 供配置层引用（`validator: ci-status@my-plugin`）；加载期校验引用是否存在、参数是否匹配，缺能力即拒绝加载而非运行期炸 |
| `check` | 宿主 → 插件 | 产物描述 + 证据锚点 + 触发器命中证据（携带触发器 id，防「人一律点确认」的确认疲劳） | 出 `{result: pass\|block\|warn, anchors[], reason, confidence}`；`warn` 必须留痕 |
| `health` | 双向 | 版本、就绪状态、最近错误 | 探活与降级依据 |

要点：握手先交换 `protocolVersion`，不兼容即拒绝加载（宿主升级不炸插件）；超时默认 60s、gate 可覆盖，超时按「升级人工」处理而**不放行**；IM 适配器的长连接类事件推送单独定义 `stream` 语义，不与门禁校验复用同一超时口径；凭证走环境变量或短时效 token，禁止 stdin 明文长期密钥，插件按 gate 声明的最小权限集启动；官方插件集走同一协议，并作为协议的自测样本。

### 3.5 gate YAML 的 apiVersion 约定

工作流、门禁、agent、知识条目 frontmatter 的定义都是带 `apiVersion` 的 YAML，配 JSON Schema 校验（`additionalProperties: false`，未知字段拒绝加载）（ADR-0014）。

```yaml
apiVersion: agent-cord.dev/gates/v1        # 引擎同时接受 vN 与 vN-1
kind: Gate
metadata: { id: contract-freeze, name: 契约冻结门禁 }
spec:
  attach:
    node: execution                       # 节点 = 阶段（七步流程之一）
    when: pre                             # pre | post
    triggers: [contract.touched, cross_repo, high_risk_signal]
  checks:                                 # 三级校验器混合
    - ref: unit-tests@official
      with: { suite: "rules-engine" }
    - cel: "diff.added_lines <= 500"      # 轻量条件免插件；纯函数、禁 IO、有超时
    - ref: contract-consistency@contract-plugin
      with: { contract: "api/rule-submit.yaml" }
  pass:  { require: all, human_confirm: true }   # 放行条件
  on_fail: block                          # block | warn | escalate
  timeout: 60s
  permissions: { write: [session_event] } # 最小写权限
  write_back: [consensus_ledger, session_event, doc_block_draft]   # 封闭枚举：consensus_ledger | session_event | doc_block_draft | knowledge_entry
```

契约要点：**两类注册表分开**——门禁（编排）与校验器（执行体，含能力声明）分开注册，新增门禁只组合已有校验器，「零代码」因此在操作闭包上成立；**schema 演进**——非破坏性变更在 v1 内加字段，破坏性变更升 v2 并配迁移脚本，`cord doctor/upgrade` 负责迁移，引擎同时接受 vN 与 vN-1；每个门禁与其下游写回目标都是封闭枚举，这是「防退化成脚本集合」的结构性保证。

---

## 4. 数据流：一个需求走完七步

以「某业务系统新增一条规则 + 表格 UI + 接口契约」这类中等规模需求为例（示例仅用于说明数据流，不是 Demo 剧本）。每步给出：谁在动、读写哪些文件、落什么事件、人的介入点。

### 4.1 七步总表

| 步 | 阶段 | 谁在做 | 读 | 写 | 关键事件 | 人的介入 |
|---|---|---|---|---|---|---|
| ① | 需求进入 | adapter → normalizer → router → workflow engine | — | 建 `cord/<req-id>/`；`events.jsonl`；空 `ledger.yaml`；`prd.md` 草案 | `im.message.received` → `req.opened` → `workflow.node.entered` | 无 |
| ② | 上下文剪裁 | coordinator（+ knowledge 检索） | `prd.md`、账本投影、`knowledge/` | 只记录包清单与 hash 的事件 | `context.pack_built` | 无 |
| ③ | 探索与共识 | coordinator 派发 → 探索 agent（强模型）+ voting | 只读快照、代码只读 worktree、知识条目 | `ledger.yaml`（条目投影）、`findings.md` / `adr.md` 草案 | `ledger.entry.proposed/confirmed`、`vote.completed`、`gate.passed` | 结构性 gap → 选择题 |
| ④ | 计划冻结 | coordinator 派发 → workflow engine | confirmed 条目、`adr.md` | `plan.md`（冻结）、`ledger.yaml` | `gate.passed(contract-freeze)`、`plan.frozen` | 契约冻结需人工确认 |
| ⑤ | 执行与验证 | 实现 agent（弱模型）+ 验证 agent（强模型、异构）+ voting | 任务级上下文包、接口面 | 分支/patch（Draft，不进 SSOT）；`findings.md` 验证记录 | `gate.passed/blocked/escalated`、`vote.completed` | 对抗分歧 → 并列证据选题 |
| ⑥ | 提交与防腐 | git/CI 钩子 → daemon → workflow engine | git diff、账本锚点 | `ledger.yaml`（条目状态变更） | `anti_rot.hit`、`ledger.entry.reconfirmed/overturned` | 命中才拦人 |
| ⑦ | 上线与回流 | 系统 + knowledge | 观察期数据、归档条目 | `knowledge/`（候选→生效）、`ledger.yaml` | `knowledge.candidate/promoted/retired` | 知识晋升需人点确认 |

### 4.2 逐步说明

**① 需求进入。** 人在群里发需求（文档链接、一段 PRD、或已有需求单 id）→ adapter 收下 → normalizer 去重与脱敏 → `append_event` 落 `im.message.received`（先落盘再处理）→ dispatcher 交给 router → router 分类为「新需求」并解析出 req-id → workflow engine 初始化图与状态机 → 创建 `cord/<req-id>/`：初始化 `events.jsonl`、空 `ledger.yaml`、`prd.md` 草案（frontmatter 只有显示字段）。此时账本是空的，这是有意的：**无证据不入账**。

**② 上下文剪裁。** coordinator 组装上下文包：层 1（前置高信号）= 需求摘要 + 已有 confirmed 条目（带锚点）+ 生效知识条目（硬上限）；层 2（定位符）= 相关文档路径、符号路径、检索入口。包本体默认只在进程内构造，事件里记录清单与 hash（可审计、可复现，又不让派生数据污染仓库）。包由消费方 agent 直读，人审对象是账本条目而不是上下文包（见 [07-context.md](./07-context.md)）。

**③ 探索与共识。** 探索任务派给强模型角色 agent（独立只读 worktree + 步骤②的包）。结论必须带证据锚点，否则不许入账（`ledger.entry.proposed`）。难度门内的决策点走盲评投票：2/2 且锚点可机验 → `confirmed`；2:1 或语义类 → `needs_verification`（少数派理由随选择题一起推给人）；锚点重合 ≥ 0.5 → 升级人工。判定结果经事件写入并投影到 `ledger.yaml`；文档侧结论以块级草案落到 `findings.md` / `adr.md`，合入由人或门禁确认。遇到答案不在任何数据源里的问题（structural gap），router 把它变成一道选择题推回群里。

**④ 计划冻结。** confirmed 条目构成依赖图，任务粒度由依赖图自然产生（不人为拍粒度）。`plan.md` 由 coordinator 产草案，由 `contract-freeze` 门禁求值（契约一致性校验 + 必要时的投票 + **人工确认**，因为触碰接口契约属不可逆动作）。通过后落 `plan.frozen`，随后按任务派发，每个任务拿任务级上下文包（以接口面为主，不传实现细节）。

**⑤ 执行与验证。** 实现任务派给低成本模型（ADR-0007），产物是分支上的 Draft，从不直接写 SSOT。验证任务派给**异构**强模型：单测（来自 confirmed 条目的关联动作）、集成测试、对抗 review 投票。门禁结果三态（[06 章 §2.3](./06-gates-workflow.md)）：`pass` 放行、`block` 阻断并回写 session、`warn-and-continue` 放行但强制留痕（否则等于静默通过）。注意 `escalate` 不是第四种结果，而是 `on_fail` 的一个动作——取 `escalate` 时直接进入升级流程，升级时给的是并列证据 + 各自理由，人只做选择题。

**⑥ 提交与防腐。** 提交钩子（git pre-push 或 CI 钩子）把 diff 交给 daemon 做锚点求交：命中某条 confirmed 条目的锚点区域 → 强制确认该共识是否仍成立，或走推翻流程（附新证据，状态机单向流转，被推翻条目留全文）。行号漂移本身是信号（条目降回临时并触发重验）。误伤率是已知风险，所以 L2 影响检查起步策略是「命中才确认、可异步」而非一律阻断。**合入永远人工**：平台最多产出 PR 与说明。

**⑦ 上线与回流。** 观察期采集推翻率（按原因分类）；需求归档触发规则抽取（账本条目 → 知识候选）→ 复述检验 → 人点确认 → 生效。同时看 Issue 密度是否随需求序号衰减：密度不衰减说明流程在收税而不是放大效率，这既是飞轮是否转起来的证据，也是介入负担告警的输入。

---

## 5. 快照文件夹标准布局

### 5.1 布局

```
cord/                                  # SSOT 根目录（与代码同仓；clone 即拥有全部真相）
├── <req-id>/                          # 一个需求一个快照文件夹 = 一个全局 session 的物化形态
│   ├── prd.md                         # 快照文档：最新层，frontmatter 仅显示层
│   ├── plan.md                        # 同上
│   ├── adr.md                         # 决策记录（supersede 链接）
│   ├── findings.md                    # 调研 / 实验结论
│   ├── ledger.yaml                    # 共识账本：机判层（事件流的确定性投影）
│   ├── votes/                         # 投票记录落盘（V-xxxx.yaml），与账本内嵌记录以 vote_id 对齐
│   └── events.jsonl                   # 事件流：历史层，append-only，永不清理，入 git
├── knowledge/                         # 跨需求知识库（KB-xxxx，每条目一文件）
├── .index/                            # 派生索引（SQLite FTS5）：gitignore，可 `kb reindex` 重建
└── cord.toml                          # 布局版本、事件 schema 版本、索引与工作流配置
```

`cord.toml` 是「文档支持版本」这条共识在工程上的落点：布局版本 + 事件 schema 版本 + 工作流/门禁/agent 定义的 apiVersion + 索引配置。任何迁移由 `cord doctor` / `cord upgrade` 执行，人不需要手工搬文件。

`votes/` 与 `.index/` 是两个补充目录，性质完全不同：`votes/` 是**权威留痕**（投票记录全文，与账本条目内嵌的 `vote_record` 以 `vote_id` 对齐，两处都进 git），`.index/` 是**唯一纯粹的派生目录**（检索索引，可从 `knowledge/` 与账本全量重建），因此进 `.gitignore`、由 `kb reindex` 重建——它不属于 SSOT，删掉不丢任何真相。

### 5.2 三层共存原理

快照文档要求「主动清理历史」，事件溯源要求「永不删历史」——表面矛盾，实际只是把两种物理形态分开：

| 层 | 文件 | 性质 | 清理策略 | 谁读它 |
|---|---|---|---|---|
| 历史层 | `events.jsonl` | append-only，永不修改 | **永不清理** | 人审计、程序查询、回放实验、`doctor` 对账 |
| 机判层 | `ledger.yaml` | 事件流的确定性投影（可重建） | 条目只增状态，不删 | 门禁、投票、防腐钩子、检索 |
| 最新层 | `prd.md` / `plan.md` / `adr.md` / `findings.md` | 人工维护 + 机器产草案 | **放心清理**（历史在事件流与 git 里） | 人、coordinator、角色 agent |

- **清理不再有心理负担**：快照文档瘦身只删显示层里的过时内容，审计线索在事件流与 git 里一条不少。
- **投影可对账**：`cord doctor` 会 fold 事件流得到期望状态并与 `ledger.yaml` 比对，不一致即报漂移；账本可整体重建，所以漂移是「修一下」而不是「数据丢了」。
- **git 是版本化权威**：谁在何时把哪条共识改成什么，由 git 提交历史 + 事件流双重可追。

### 5.3 事件流与 git：合并冲突与解法

append-only 日志与 git 有一处天然冲突：两个分支各自追加事件后合并，git 的三路合并会把同一文件末尾当冲突处理，而 `checkout --ours/--theirs` 任取一侧会**永久丢事件**（社区已有事故实录：多条工作流全部 approved，合并后状态板显示 0/N，<https://github.com/Priivacy-ai/spec-kitty/issues/569>）。解法按优先级：

1. **注册 git merge driver（默认方案）**：`.gitattributes` 把 `cord/**/events.jsonl` 指向自定义并集合并驱动，按 `event_id` 去重、按 `(seq, event_id)` 排序做并集，冲突不被静默丢弃。
2. **每事件一文件**（`events/<ulid>.json`）：git 天然无冲突，代价是可读性下降，作为需要时的降级方案。
3. **分片**：按天或按里程碑切分事件文件，降低单文件冲突概率（与方案 1 组合最省事）。

对账兜底：合并后 `cord doctor` 校验 `seq` 连续性（无空洞）与 `event_id` 唯一性——**丢事件必须可见**，这是审计系统的最低要求（ADR-0010 已否决「事件流 gitignore + 定期 checkpoint」方案）。

### 5.4 写入纪律

1. **状态机流转只能经 `append_event`**：条目状态迁移、投票、门禁判定、需求生命周期变更，全部先写事件再投影到 `ledger.yaml`；禁止任何模块直接改账本。
2. **快照文档允许人工直接编辑**（这是「主动清理」的落点），但文档里任何影响判定的结论必须同步落事件；`doctor` 检查文档中出现的条目 id / 状态是否与账本一致，不一致即告警（显示层漂移可容忍但必须可见）。
3. **frontmatter 只放显示字段**（id、状态戳、依赖文档 id），禁止放机判字段；判定一律查事件流/账本。这与「行号只作显示层、不参与判定」同源。
4. **事件流永不进 LLM 上下文**；凭证脱敏在写入前完成。

---

## 6. 协调 agent 的隔离设计（三层防御）

协调 agent 是幻觉风险最高也最关键的位置：它既要理解需求，又不能把「自己以为的历史」当成事实。它由现成 CLI 驱动，而文件系统对它天然开放——**物理上无法保证它「看不见」，所以控制点必须放在「启动时给它注入什么」**。

**第一层：注入层剪裁（主机制）。** coordinator 每轮只挂上**上下文包**（前置高信号层 + 定位符层）与当前快照的投影视图。注入：需求摘要、confirmed 条目（一句话结论 + id + 锚点）、生效知识条目（≤ 硬上限）、当前节点的待办与选择题、定位符。不注入：`events.jsonl`、完整账本原文、其他投票实例的中间推理、人工结论原话（投票场景）。**不注入就不幻觉**：问题不是模型记性好不好，而是让它只能看到最新的、带锚点的那一小撮高信号内容（依据：上下文窗口越大召回越差，JIT 检索优于全量预检索）。包内每条前置内容必须带来源锚点，agent 的结论必须回链锚点——审计发生在结论侧，不在输入侧。

**第二层：文件层只读副本（纵深）。** coordinator 的工作目录指向快照文件夹的**只读副本**（只读挂载或 `git worktree --detach` 的只读检出）。kernel 级强制、无性能代价，但它只是 belt-and-suspenders：真正起作用的是第一层，副本的存在只是让「agent 改文档」在物理上不可能。

**第三层：协议层写操作必经路由（兜底）。** coordinator 推动作必须经 daemon 的写路径（`append_event` + Draft 通道）：写事件、产草案、发选择题。它没有 SSOT 写权限、没有合入权、不能直接触达外部系统。

三层合起来把「coordinator 越权」的后果压到最小：即便注入层被绕过，它也只能说错话、产错草案——错误会以事件留痕，且必须过门禁或人才生效。同一模型对角色 agent 同样成立（生成侧在临时 worktree、只产 Draft），对投票实例则是加强版（独立进程 + 独立目录 + 净输入审计）。

---

## 7. 运行形态细节

### 7.1 daemon 无状态可重放

daemon 的**唯一状态就是快照文件夹**。内存里的东西（工作流当前节点、挂起中的门禁、待办选择题、索引）全部可从事件流折叠重建：重启 = 从文件夹重放恢复 → 跑一次 `doctor` 对账 → 继续派发，不维护任何不可重建的内存态；挂起中的门禁依事件重建（审批记录已持久化），等待的人看不出差异；重复动作被幂等键（`task_id` / `event_id`）挡住。这条设计让「常驻 daemon」与「SSOT 是文件夹」天然自洽。

### 7.2 CLI 是薄客户端

CLI 与 daemon 之间走本地 HTTP（localhost + token 文件）或 Unix socket。CLI 只做三件事：把输入交付给 daemon、把输出渲染给人、做初始化与诊断（`cord doctor`、`kb reindex`、手动回放实验）。**CLI 不承载业务逻辑**：本地接口就是核心模块的函数签名，核心代码同时以库导出（同一核心的第三种暴露形式），由此保证 CLI 与 daemon 不会各自演化成两套逻辑。分发走 npm，`npx` 免安装即跑（ADR-0016）。

### 7.3 并发控制与崩溃隔离

- **按供应商令牌桶 + 队列调度**：rate limit 即使在最高付费档也是真实瓶颈，不能假设供应商帮你扛；异构投票恰好可错峰调度（三家不同配额天然分担）。
- **worktree 并发设硬上限**（初值建议 8-10），超出排队；**同一 session 的事件由单一写入者追加**（`seq` 单调），不同 session 天然无锁（每需求一文件夹、一日志）。
- **预算熔断三层**：CLI 侧 `--max-turns` / `--max-budget-usd`、平台侧 wall-clock 心跳超时（长时间无事件即杀）、需求级 token 预算。
- **崩溃隔离**：agent 与插件都在子进程——一个 CLI 崩了、卡死或被限流只死一个任务（重试或换模型），插件崩了只死一次校验（按超时策略升级人工），daemon 不因它们而崩；daemon 自己崩了也不丢状态（状态早在事件流里），进程守护由用户侧选择（systemd / launchd / pm2）。
- **进程内防御**：Node 单线程下未捕获异常会拖垮整个 daemon，而 router 是已知单点——因此严格模式启动，把所有重活推到子进程。
- **可见性**：每次调用的 usage、CLI 版本、prompt hash、transcript 引用都落事件，出问题可回溯到「谁、用哪个 CLI 版本、基于什么上下文」。

---

## 8. 部署形态

三种形态共用同一事件模型与同一套模块，差异只在 adapter 与 ingress：

| 形态 | 适用场景 | ingress | SSOT 位置 | 说明 |
|---|---|---|---|---|
| **本地单机** | dogfooding、个人或小组试用 | IM 官方 SDK 长连接（无需公网） | 本地仓库工作区 | 默认形态；首个用例（本项目的开发管理）就走这条 |
| **团队服务器** | 团队共享一个 daemon | webhook ingress 前端（验签 + 去重 + 快速 ACK）或长连接，需公网可达 | git 仓库（共享远端） | ingress 收到事件后第一步仍是写本地事件流；本项目事件量级下不引入 MQ |
| **纯 CLI（无 IM）** | CI 集成、无 IM 环境、脚本化回放 | CLI 适配器（stdin） | 本地仓库工作区 | CLI 也是适配器：选择题渲染为编号选项，事件模型完全一致，由类型系统强制 |

三种形态都不需要中央数据库：**clone 仓库即拥有全部 SSOT**。多需求并发在单机与服务器形态下都按「每需求一文件夹 + 独立事件流」隔离，不需要跨需求锁。

---

## 9. 本章刻意留白

以下问题本章有意不解决，标出来是为了不让读者误以为它们已被设计：

1. **多需求跨仓库编排**：当前隔离单位是需求文件夹；跨仓库锚点解析与统一检索后置（ADR-0010 已否决第一阶段引入中央库）。
2. **SQLite FTS5 派生索引的启用范围**：知识库索引第一阶段即可用（条目量小），跨需求查询与账本级索引后置为可插拔增强。
3. **权限与凭证模型细节**：短时效 token、最小权限集、agent 权限分级表由 [09-security.md](./09-security.md) 展开，本章只固定「插件走环境注入、写路径必经路由」两条边界。
4. **事件类型全集**：本章给命名空间与演进策略，类型清单随实现与实验补全，每次新增走 ADR。
5. **上下文包的 token 预算与两层配比**：初值（层 1 约 2-4k token、生效知识条目 ≤ 8 条）需实验校准，见 [12-experiments.md](./12-experiments.md)。
6. **回退路径**：账本与事件流必须可导出、可脱离平台阅读——数据结构本身就是纯文本，这是刻意的设计选择。
7. **状态**：本章描述的全部机制均为设计定稿，**尚无实现代码**。

---

## 相关文档

- [ADR 索引](./adr/README.md)：20 条决策的完整论证——[ADR-0009 语言与运行形态](./adr/ADR-0009-language-runtime.md)、[ADR-0010 SSOT 存储](./adr/ADR-0010-ssot-storage.md)、[ADR-0011 agent 运行时](./adr/ADR-0011-agent-runtime.md)、[ADR-0012 事件与 IM 适配](./adr/ADR-0012-events-im-adapters.md)、[ADR-0013 投票执行器](./adr/ADR-0013-vote-executor.md)、[ADR-0014 工作流与门禁定义](./adr/ADR-0014-workflow-gate-dsl.md)、[ADR-0015 知识库](./adr/ADR-0015-knowledge-base.md)、[ADR-0016 分发与插件](./adr/ADR-0016-distribution-plugins.md)、[ADR-0017 agent 驱动协议（ACP）](./adr/ADR-0017-agent-driver-acp.md)、[ADR-0018 工作流 DSL 与编排内核实现](./adr/ADR-0018-workflow-dsl-kernel-impl.md)、[ADR-0019 插件协议（MCP）](./adr/ADR-0019-plugin-protocol-mcp.md)、[ADR-0020 事件协议与确定性 reducer](./adr/ADR-0020-event-protocol-reducer.md)
- [04-consensus-ledger.md](./04-consensus-ledger.md)：账本条目 schema、证据锚点三层结构、状态机与推翻流程
- [05-voting.md](./05-voting.md)：盲评投票、难度门、锚点独立度检查的完整设计
- [06-gates-workflow.md](./06-gates-workflow.md)：预定义有向图、gate schema、三级校验器、触发式升级
- [07-context.md](./07-context.md)：共识快照维护、协调 agent、两层上下文包、文档防腐钩子
- [08-self-evolution.md](./08-self-evolution.md)：知识条目生命周期、复述检验、bad case 回流
- [09-security.md](./09-security.md)：Draft-only 边界、凭证策略、agent 权限分级
- [INDEX.md](./INDEX.md)：文档集导航与术语索引
