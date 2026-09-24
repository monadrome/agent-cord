# 04 · 共识账本与证据锚点

> 状态：**设计定稿，代码未实现**（本文档描述的是已定型的机制设计，仓库中尚无对应实现）
> 相关章节：[`./05-voting.md`](./05-voting.md)（投票机制，账本条目 `投票记录` 字段的载体）、[`./03-architecture.md`](./03-architecture.md)（事件信封与事件家族命名、快照文件夹在架构中的位置）、[`./07-context.md`](./07-context.md)（防腐钩子的挂载与实现、锚点重锚定细节）、[`./06-gates-workflow.md`](./06-gates-workflow.md)（门禁与校验器如何消费条目状态）、[`./08-self-evolution.md`](./08-self-evolution.md)（`knowledge` 类型锚点与 KB 条目生命周期）
> 相关决策：[ADR-0003](./adr/ADR-0003-consensus-carrier.md)（共识载体=结构化快照+事件流）、[ADR-0005](./adr/ADR-0005-ledger-over-spec.md)（共识账本=证据条目集合，不做统一 Spec）、[ADR-0010](./adr/ADR-0010-ssot-storage.md)（SSOT 存储=纯文件+git+JSONL 事件流+ledger.yaml）；完整 ADR 记录见 [`./adr/`](./adr/)

---

## 本章回答什么问题

人脑里的业务模型和代码现实之间总有落差，这个落差靠"大家聊一聊觉得对上了"来消除，结果就是变更散落群聊、结论无据可查、错了也不知道错在哪。本章回答四个问题：**共识到底是什么东西**（凭什么说它不只是"感觉一致"）；**共识用什么结构承载**（账本条目的完整 schema 与三条写入规则）；**结论凭什么算有据**（证据锚点的三层结构与漂移处理）；**错了怎么办**（推翻流程、推翻率、以及被推翻的结论为什么也要留下）。

---

## 1. 共识的定义

### 1.1 什么是共识

**共识：关于「系统应该怎么表现」，且被证据支撑、可被独立复核的结论。**

定义里有三个要素，缺一不可：

| 要素 | 含义 | 反例（不算共识） |
|---|---|---|
| 关于「系统应该怎么表现」 | 结论要能落到系统行为上，可被实现或验证 | "这个需求有点复杂"——描述感受，不描述系统行为 |
| 被证据支撑 | 挂在至少一个证据锚点上（代码符号、用例、契约、知识条目） | "我记得上次也是这么做的"——无锚点，不可复核 |
| 可被独立复核 | 任何第三个人或 agent 拿着锚点能自己走一遍，得出同结论 | "评审会上大家都同意了"——过程一致，不是结论可复核 |

**为什么不统一 Spec。** 一个自然的冲动是：既然要共识，那就维护一份权威规格文档，把所有结论写进去。方案明确否决这条路（**ADR-0005**），理由不是"写文档太累"，而是统一 Spec 有四个结构性问题：

1. **同步负担：六份材料变七份。** 一个需求的现状本来就散在 PRD、UI 设计稿、接口契约、技术方案/架构记录、决策记录（ADR）、计划/任务清单里。再加一份"统一 Spec"，它不是替代任何一份，而是要求这六份的每一次变更都在第七份里同步一次——变更成本从 N 份变成 N+1 份，且第七份是唯一没有专属 owner 的那份。
2. **权威歧义。** 统一 Spec 与代码/契约冲突时谁对？实践中的默认答案是"代码对，文档改一下"——这恰好就是 R9 要禁止的"不留痕地修改共识去迁就实现"。账本约定的是另一条路：冲突时要么改实现，要么走推翻流程留痕（见 §3.2、§5）。
3. **覆盖幻觉。** 统一 Spec 声称覆盖全部，实际能维护好的只有被变更触碰过的切片；剩下的大片内容陈旧却因为"躺在一份权威文档里"而显权威。这与知识库里的"上下文腐化"是同一个病：错误或过时的信息因为被反复引用而获得权威。账本反其道而行——**只覆盖被变更触碰的切片，明确不声称自己是唯一事实来源**（唯一的权威是证据本身）。
4. **失效机制缺失。** 统一 Spec 无法"部分失效"：出一条错就得整体作废重写，成本太高，于是错被留着。账本条目可以逐条推翻、逐条过期，失效粒度天然与结论粒度对齐。

业界侧证：主流 spec 驱动工具也没解决这件事——spec-kit 官方文档明确承认"spec 变更之后怎么办没有标准答案"，把 flow-back / flow-forward / living 三种持久化模型留给团队自选；OpenSpec 用 delta + archive（以变更为单位 + 事后折叠）而非维护一份全量规格；ADR 生态数十年来的做法是"新决策 supersede 旧决策"，而不是回头改写旧记录。这几个成熟工具的共同点，正是账本要采用的形态：**以结论（变更）为单位，而不是以文档为单位。**

### 1.2 账本、快照文档、ADR 三者是什么关系

三条边界需要一次说清，否则后面所有机制都会被误解：

| 层 | 位置 | 谁维护 | 权威性 |
|---|---|---|---|
| **共识账本**（判定层） | `cord/<req-id>/ledger.yaml` | 只能经事件流写入（见 §6.3），不允许手工改状态字段 | 机判逻辑的唯一查询对象：门禁放行、投票结果、锚点求交都查它 |
| **共识快照文档**（最新层） | `cord/<req-id>/{prd,adr,plan,findings}.md` | 人可编辑、可主动清理 | 给人读的最新视图，不参与判定；frontmatter 只是显示层 |
| **事件流**（历史层） | `cord/<req-id>/events.jsonl` | append-only，永不清理 | 唯一的事实与顺序来源 |

- **账本是 ADR 的字段增强版，不是新的文档类型。** 一条架构决策在 `adr.md` 里仍以人类可读的 ADR 段落呈现（含 supersede 链接），同时在 `ledger.yaml` 里是一条带证据锚点、状态机、投票记录和推翻记录的条目。`adr.md` 是显示层，账本是判定层——两者不是双写权威，因为一切判定只查账本与事件流。
- **frontmatter 与文档措辞都不参与判定。** `prd.md` 的 frontmatter 里放 `{id, status, 版本戳}` 这类显示性字段，供 agent 打开文件第一眼就知道"这是第几版、有多少条 confirmed"，但规则是死的：**判定一律查事件流/账本，frontmatter 只是显示层**（ADR-0010）。这与证据锚点里"行号只是显示层"是同一条原则，见 §4。
- **快照文件夹的标准布局**（与代码同仓，`clone` 即拥有全部 SSOT）：

```
cord/
├── <req-id>/                      # 一个需求一个快照文件夹 = 一个全局 session 的物化形态
│   ├── prd.md                     # 快照文档（最新层，人可编辑 + 主动清理）
│   ├── adr.md
│   ├── plan.md
│   ├── findings.md
│   ├── ledger.yaml                # 共识账本（判定层）
│   ├── events.jsonl               # 事件流（历史层，append-only）
│   └── votes/V-0007.yaml          # 投票记录全文（见 05 章）
├── knowledge/                     # 跨需求知识条目 KB-xxxx
├── .index/                        # 派生索引（可重建，gitignore；权威始终是上述文件与事件流）
└── cord.toml                      # 布局版本、事件 schema 版本、索引配置
```

---

## 2. 账本条目的完整 schema

### 2.1 schema 示例

```yaml
# cord/<req-id>/ledger.yaml
# 判定层：状态字段由事件流投影而来，禁止手工修改（见 §6.3）
schema_version: 1
req_id: REQ-2026-042

entries:
  - id: C-002                        # 账本内唯一（C-###）；跨需求引用写作 REQ-2026-042/C-002
    req_id: REQ-2026-042             # 所属需求（全局 session 的锚定单位）
    title: gate 触发条件只由 attach.triggers 声明   # 短标题，供人扫读
    statement: >                     # 结论本体：一句话，可被实现或验证
      gate 的触发条件只由 gate 自身的 attach.triggers 声明决定；workflow 节点进入不再隐式触发门禁。

    anchors:                         # 硬门槛：至少 1 条，见 §3.1
      - id: A-1
        kind: code                   # code | case | contract | knowledge | doc | report（见 §4.5）
        anchor: "src/gate/trigger-registry.ts#TriggerRegistry.resolve"  # 活锚点（参与者判定）
        snapshot:                    # 存档：入账时刻的证据现场（不可变）
          commit: 9f3c1ab7d2e5...    # 入账时刻的 commit SHA
          lines: "405-430"
          content_hash: "sha256:3b1f..."
        line_hint: "trigger-registry.ts:412"   # 仅显示层，不参与任何判定
        note: "触发器解析入口：只有它读 attach.triggers"
      - id: A-2
        kind: knowledge
        anchor: "KB-0017"
        note: "触发器清单语义：未在 attach.triggers 中声明的触发器一律不生效"

    status: confirmed                # provisional | confirmed | overturned（单向 + 机器降级，见 §3.2）
    confidence_source: vote_agreement # code_verification | vote_agreement | human_confirmation
    vote_record_id: V-0009           # 稳定引用键，指向 votes/V-0009.yaml；无投票则为 null
    vote_record:                     # 投票留痕（完整 schema 见 05 章 §6.1）；无投票则为 null
      decision_point: {id: D-0009, options: {A: 只认 attach.triggers, B: 节点进入也触发, C: insufficient_evidence},
                       machine_verifiable: true, reversible: true, difficulty_bucket: medium}
      votes:                         # 此例为 k=2：两票结论一致，且各自引了不同证据（锚点独立）
        - {agent_id: reviewer-a, provider: anthropic, model_id: "claude-sonnet-4-5-20250929",
           model_id_resolved: "claude-sonnet-4-5-20250929", prompt_hash: "sha256:1f8c...",
           option_permutation: [C, A, B], option: A,
           anchors: ["src/gate/trigger-registry.ts#TriggerRegistry.resolve"], confidence: 0.82,
           usage: {input_tokens: 12400, output_tokens: 320, cost_usd: 0.041}, request_id: "req_8c1f..."}
        - {agent_id: reviewer-b, provider: openai, model_id: "gpt-5-2026-08-01",
           model_id_resolved: "gpt-5-2026-08-01", prompt_hash: "sha256:44a0...",
           option_permutation: [B, C, A], option: A, anchors: ["TC-GATE-118"], confidence: 0.71,
           usage: {input_tokens: 11880, output_tokens: 290, cost_usd: 0.027}, request_id: "req_2b7d..."}
      statistics: {raw_agreement: 1.0, fleiss_kappa: null, gwet_ac1: 1.0, anchor_overlap: 0.0}
      decision: confirmed            # 2:1 分裂、少数派理由留痕的完整样例见 05 章 §6.1
      minority_report: null

    overturn: null                   # 被推翻时填 {at, by, reason, evidence[], superseded_by}
    actions:                         # 依赖本条目的资产；只有 confirmed 才允许驱动不可逆动作
      - {type: case, ref: "TC-GATE-118"}
      - {type: gate, ref: "contract-freeze"}

    created_at: 2026-09-24T14:02:11+08:00
    confirmed_at: 2026-09-24T14:09:40+08:00
```

被推翻后的同一账本片段（长这样）：

```yaml
  - id: C-011
    title: 投票 k 值对所有决策点统一取 3
    statement: >
      投票队列不对决策点分类，所有决策点统一使用 k=3。
    anchors:
      - {id: A-1, kind: code, anchor: "src/vote/queue.ts#VoteQueue.kFor", snapshot: {commit: 4e21b90..., lines: "88-103", content_hash: "sha256:77ac..."}, line_hint: "queue.ts:91"}
    status: overturned
    confidence_source: human_confirmation
    overturn:
      at: 2026-10-08T10:31:00+08:00
      by: <匿名主体标识>            # 人只留不可反查的 id 与角色 token，不记姓名（脱敏约定）
      reason: requirement_change    # insufficient_evidence | semantic_misunderstanding | requirement_change | external_dependency_change
      evidence:                     # 新证据锚点（推翻必须有据，不许口头推翻）
        - {kind: contract, anchor: "contracts/vote/policy.yaml#k.default"}
      superseded_by: C-014          # 取代它的新条目（保留全文，不删除旧条目）
```

### 2.2 逐字段说明

| 字段 | 类型 | 必填 | 说明与约束 |
|---|---|---|---|
| `id` | string | 是 | 账本内唯一，`C-###`；跨需求引用必须写全 `<req-id>/C-###`，禁止裸 id（防止两个需求的 C-002 混淆） |
| `req_id` | string | 是 | 所属需求 id。一个快照文件夹只属于一个需求，字段冗余存在是为了让单条被摘出后仍可自证归属 |
| `title` / `statement` | string | 是 | `title` 供扫读，`statement` 是结论本体。要求一句话、可被实现或验证；写不出可验证的一句话，说明还没形成共识 |
| `anchors` | list | **是（≥1）** | 证据锚点，见 §4。无锚点条目不许入账（§3.1） |
| `anchors[].kind` | enum | 是 | `code`（代码符号）/ `case`（用例）/ `contract`（契约）/ `knowledge`（知识条目）/ `doc`（文档块）/ `report`（产物报告，与门禁章的 checker 输出对齐）。**可机验类型 = {`code`, `case`}**，它是决策点能否进入投票队列的硬条件之一（见 [`./05-voting.md`](./05-voting.md) §2.2）；新增枚举值走 `schema_version` 演进 |
| `anchors[].anchor` | string | 是 | **活锚点**：限定符号名（`文件/包#符号路径`）或用例 id、契约字段路径、知识条目 id。参与锚点求交与锚点独立度计算 |
| `anchors[].snapshot` | object | `code` / `case` 类必填 | `{commit, lines, content_hash}`：入账时刻的证据现场，不可变，用于复核时回到原始现场、以及比对"共识是否被迁就实现修改"。它在判定中的角色见 §4.2 |
| `anchors[].line_hint` | string | 否 | `文件:行号`，**仅显示层**，任何判定（求交、独立度、覆盖率）都不读它 |
| `anchors[].note` | string | 否 | 这条锚点支撑结论的哪一部分（人复核时最有用的一行） |
| `status` | enum | 是 | `provisional` / `confirmed` / `overturned`，状态机见 §3.2 |
| `confidence_source` | enum | 是 | `code_verification`（代码验证）/ `vote_agreement`（投票一致）/ `human_confirmation`（人确认）——回答"凭什么信它"。三者不是可信度等级，而是三种证据路径，都要求锚点 |
| `vote_record_id` | string \| null | 是 | 稳定引用键，指向投票记录全文（`votes/V-xxxx.yaml`）；`confidence_source` 为 `vote_agreement` 时必须非空 |
| `vote_record` | object \| null | 是 | 投票留痕本体（完整 schema 见 [`./05-voting.md`](./05-voting.md) §6.1）。k≤3 体积很小，整体嵌入账本，让 PR diff 一次看全；全文另存于 `votes/` 并以 `vote_record_id` 对齐。`needs_verification` 时条目仍是 `provisional`，但投票记录照常写入 |
| `overturn` | object \| null | 是 | `{at, by, reason, evidence[], superseded_by}`；见 §5 |
| `actions` | list | 否 | 依赖本条目的资产（用例、门禁、下游条目）。它有两个作用：门禁放行时查"这条 confirmed 了吗"；测试失败时反查"这个用例来自哪条共识"（推翻来源之一） |
| `created_at` / `confirmed_at` | ISO 8601 | 是 | 时间戳带时区。这两个字段是事件流投影出来的冗余副本，便于人读，权威在事件流 |

**枚举值约定**：机读字段的枚举一律使用固定英文 token（`confirmed` / `vote_agreement` / `requirement_change` …），文档与界面上的中文名只是显示。这条约定让 schema 演进可校验、跨语言实现不需要本地化映射。

**字段名以本文档为准**：其他章节在叙述 schema 时用中文字段名（`id` / `需求` / `结论` / `证据` / `状态` / `置信度来源` / `投票记录` / `推翻记录` / `关联动作`），与本文档的 `id` / `req_id` / `title`+`statement` / `anchors` / `status` / `confidence_source` / `vote_record` / `overturn` / `actions` 一一对应——它们是同一 schema 的叙述形态与机读形态，不是两套 schema。`ledger.yaml` 里永远写英文 token。

---

## 3. 三条写入规则

三条规则共同解决同一个问题：**防止没有证据的东西混进共识，防止共识被悄悄改掉。**

### 3.1 无证据不入账

每条结论必须带至少一个证据锚点（代码符号、用例 id、契约字段或知识条目 id），**禁止无锚点结论**。

- 证据锚点由 agent 产出（探索/实现 agent 给出的结论必须自带锚点）、由人补齐（事实补充型介入点的答案本身就是一个锚点）、或来自知识条目（`KB-xxxx`）。
- `confidence_source: human_confirmation` 不能替代锚点——"人确认"回答的是"谁背书"，不回答"凭什么"。人确认的条目同样要挂锚点（通常是人提供的 PRD 段落、契约或知识条目）。
- 证据不足时的正确动作是**投弃权**而不是编造锚点：投票选项集里固定有兜底项 `insufficient_evidence`（见 [`./05-voting.md`](./05-voting.md) §3），该票不计入一致、不生成 confirmed 条目。
- 已知代价：门槛提高可信度，也提高入账摩擦。缓解手段不是降低门槛，而是降低补锚点的成本——探索 agent 的产出模板强制带锚点字段、评审时锚点缺失直接判不合规。

### 3.2 状态机单向流转

```
   provisional ─────────► confirmed ─────────────► overturned
  (调查结论：不可驱动      (可驱动门禁与不可逆动作)     (保留全文：原因 + 新证据
   不可逆动作，拿到证据                                 + 取代者 superseded_by)
   或投票一致后晋升)

                       │
                       │  唯一例外：锚点失效（重锚定三级全失败）
                       ▼  机器触发的降级，必然写入事件流、必须重验
                 provisional（挂起效力，结论内容不变）
```

- 只能向前：`provisional → confirmed → overturned`。**人工不允许静默回退**，`confirmed` 不能因为"代码改成这样了"而变回 `provisional`（这正是 R9 要防的：不留痕地修改共识去迁就实现）。要改，只有两条路——改实现，或走推翻流程留痕。
- **唯一例外是机器触发的锚点失效降级**（图中向下那条）：入口代码被重构/删除导致活锚点重锚定失败时，条目自动降回 `provisional` 并触发重验。它不是"迁就实现改共识"，因为：(1) 它由机器检测、必然写入事件流留痕；(2) 它不修改结论内容，只把结论的效力挂起；(3) 它是信号而非结论（"这条共识现在无法被证据支撑了"），见 §4.4。
- 回退后重新 confirmed 必须补新证据或新的投票记录，不允许"点一下恢复"。事件流里因此能看到完整的 `confirmed → anchor_drifted(provisional) → reverified(confirmed)` 轨迹。

### 3.3 临时（provisional）身份默认

调查结论、探索发现、历史偶然行为，在得到证据支撑之前一律先以 `provisional` 入账，不得直接晋升为既定事实。

这条规则针对的是**认知洗白**：把一次实现里的偶然选择，事后追述成"当初就是这么设计的正式需求"，于是偶然性获得了权威性，之后所有人（和人机）都照着这个"历史事实"推理。判断"是不是洗白"的标准很简单——**它有没有证据锚点？** 没有就是临时（`provisional`）。

- 临时（`provisional`）条目不能被门禁当作放行依据，也不能驱动不可逆动作（`actions` 字段只在 confirmed 时生效）。
- 临时条目是允许存在的、也是常态：探索阶段的结论先落 `provisional`，拿到代码/用例证据或投票一致后再晋升。
- 临时的身份标签是给 agent 看的（写进上下文包），防止下游 agent 把未验证结论当事实引用——这与知识库"知识条目入库必须过复述检验"是同一条防线。

---

## 4. 证据锚点的三层结构

### 4.1 为什么「文件:行号」不能单独作主锚点

草案里最初写的是 `锚点: "path/File.java:412"`。它有一个致命问题：**行号是文本坐标，不是语义坐标**，而代码重构恰恰会大量移动文本坐标。

| 锚点形式 | 抗行号漂移 | 抗文件移动 | 抗符号重命名 | 抗格式化 | 失效语义 | 实现成本 |
|---|---|---|---|---|---|---|
| `文件:行号` | ✗ | ✗ | ✗ | ✗ | 漂移即失效，无法区分"只是挪了位置"与"语义真的变了" | 极低 |
| 内容 hash | ✗（改一字符即失效） | ✓ | ✗ | ✗ | 过于敏感，误伤率高 | 低 |
| **符号锚点**（限定名/签名） | ✓ | ✓ | ✗ | ✓ | 重命名/删除才失效——**失效有语义** | 中（需符号索引） |
| AST 路径锚点 | ✓ | ✓ | 部分 | ✓ | 语法结构变化才失效 | 高（需 parser） |
| commit 固定快照（SHA+行范围） | ✓ | ✓ | ✓ | ✓ | 永不失效，但指向历史快照，**不是活代码** | 低 |

两种失效都会伤人：

- **漏检**：锚定了第 412 行，重构后真实语义变更发生在第 380-400 行，求交没命中，钩子放行——防腐失效。
- **误伤**：只是文件顶部加了几行 import，行号整体下移，求交命中，人被迫确认一条根本没变的共识——流程税。GitHub PR 评论用「diff hunk + 行号」定位、代码一动就整 hunk 标 outdated（社区大量抱怨"没被碰的注释也被判 outdated"），正是这种误伤的现成反面教材。

结论：**没有任何单一锚点形式同时满足"活锚点 + 全重构存活 + 低成本"，必须分层组合。**

### 4.2 三层结构

| 层 | 内容 | 回答什么问题 | 参与判定？ |
|---|---|---|---|
| **① 符号锚点（活锚点）** | 限定符号名 + 签名指纹 + 所在文件，如 `src/gate/trigger-registry.ts#TriggerRegistry.resolve`；用例 id、契约字段路径、KB id 同理 | "这条共识现在锚在代码/用例的哪个语义单元上" | **是（主判据）**——锚点求交、锚点独立度、覆盖率都以这一层为准 |
| **② commit SHA + 内容 hash（存档）** | 入账时刻的 `{commit, lines, content_hash}` | "当初是哪一版代码的哪几行支撑了这个结论" | **仅兜底**——符号索引不可用（离线/回放）时，覆盖率以 `commit` + `content_hash` 匹配替代；`lines` 不参与 |
| **③ 行号（显示层）** | `trigger-registry.ts:412` | "给人看，从哪一行开始读" | **否**——任何判定都不读它（漂移 + 巧合重合，两个理由都足以排除） |

三个层次的判定权限一次说清：**符号锚点层是唯一的主判据**；锁定 commit 上的**内容 hash** 是它在"符号索引不可用"（离线/回放）时的兜底；**行号只是显示层**——无论写在 `line_hint` 里还是 `snapshot.lines` 里，任何判定（含 §4.5 的有效性判据）都不读它。

这个分层与 Software Heritage 的 SWHID 是同一套思路：SWHID 用「内容 hash + `path`/`lines` 限定符 + `anchor`（指向某个 commit）」表达一个不可变的软件制品标识（SWHID 已于 2025 年成为 ISO/IEC 18670 标准）。本方案借用它的语义，但用途不同——SWHID 式的快照用来**存档**，判定必须用能跟上代码演进的**活锚点**。

### 4.3 锚点求交怎么发生（L2 防腐钩子）

本节只说明求交**依据锚点的哪一层**；钩子的三级设计、挂载位置与误伤率校准见 [`./07-context.md`](./07-context.md)。

1. 从本次 diff 提取**变更符号集合**（AST 级 diff 直接给出；`difftastic` 一类语法树 diff 工具能区分"重命名/格式化"与"真实语义变更"）；
2. 与账本里所有条目的**符号锚点**求交，文件路径只做粗筛（文件命中但符号未命中 → 静默放行，这是压低误伤的主要手段）；
3. 命中则要求确认该条目仍成立，或走推翻流程（命中事件记 `anti_rot.hit`）；
4. 纯格式化/批量重构提交通过**豁免清单**跳过求交（`.git-blame-ignore-revs` 模式：git 官方支持一份"blame 时跳过这些提交"的清单，业界已有现成实例）。豁免清单直接把误伤率的分子压下来，但它本身是有权力的东西——必须约定谁登记、谁审核，否则就是绕过防腐钩子的后门。

### 4.4 漂移即信号：重锚定与降级

锚点失效不是故障，是**信号**——它说明"这条共识所依赖的代码现场已经变了"。处理三级逐级尝试，全部自动化：

1. **符号重锚定**：用重构检测（如 RefactoringMiner 类工具）或"旧符号名在新 commit 中消失 + 同签名新符号出现"的启发式，把锚点迁到新符号上——覆盖重命名与移动。
2. **内容追踪**：符号没变（或找不到同名新符号）但内容挪了位置，用 `git blame -M -C`（它本来就用内容相似度跨提交、跨文件追踪行来源）配合 commit 快照里的 `content_hash` 反查内容去了哪。
3. **AST 结构比对**：前两级都无法确认时，用语法树 diff（§4.3 求交用的同一套工具）在候选位置比对结构——符号名变了但结构同形的判为新锚点。
4. **三级全失败 → 判定锚点失效**：条目自动从 `confirmed` 降回 `provisional`（§3.2 的唯一降级路径），写入 `ledger.entry.anchor_drifted` 事件（对应门禁章的 `anchor.drifted` 触发器），触发重验——通常派一个探索 agent 带着上下文包重新确认结论是否仍成立，或直接把重验结论作为选择题推给人。

这条机制顺带解决了文档漂移检测：文档块边界由锚点切分，锚点失效即块失效，"哪一段文档需要重看"是机器直接给出的，而不是靠人读完整个仓库。

### 4.5 锚点类型与"可机验性"

锚点类型是**决策点能否进入投票队列**的硬条件之一（见 [`./05-voting.md`](./05-voting.md) §2.2），所以枚举必须是闭合的：

| `kind` | 指向 | 可机验 | 典型形态 |
|---|---|---|---|
| `code` | 代码符号 | **是** | `src/gate/trigger-registry.ts#TriggerRegistry.resolve`（符号路径格式随语言栈，实现章给定） |
| `case` | 用例 | **是** | `TC-GATE-118` |
| `contract` | 接口契约字段 | 否（可作为人工裁决依据） | `contracts/gates/trigger-registry.yaml#attach.triggers` |
| `knowledge` | 知识条目 | 否 | `KB-0017` |
| `doc` | 文档块 | 否 | `prd.md#<块id>` |
| `report` | 产物报告（门禁 checker 的输出，与 [`./06-gates-workflow.md`](./06-gates-workflow.md) 的锚点枚举对齐） | 否 | 一致性截图报告、测试报告 id |

规则：**可机验类型 = {`code`, `case`}**——只有它们背后存在可机器执行的验证信号（跑用例、读符号）。据此推出的两条后果：

1. 一条条目只挂 `contract` / `knowledge` / `doc` 锚点时，它所在决策点不满足可机验性硬条件，**不进投票队列**（语义类决策，见 05 章 §2.2、§3.3），直接落 `needs_verification` 转人工；
2. 证据覆盖率（三指标之一，见 [`./12-experiments.md`](./12-experiments.md)）统计的是"带 ≥1 个**有效**锚点"的比例。有效性判据只看**符号锚点层**与**锁定 commit 的内容快照**：`code`/`case` 看符号能否解析，或（离线/回放场景下符号索引不可用时）比对锁定 commit 上的 `content_hash`；**行号不参与判定**（§4.2③）；其余类型看锚点能否被定位到（文件或条目是否仍存在）。

新增类型（例如接入新的验证产物）走 `schema_version` 演进，并由 ADR 记录；不允许在配置里就地发明私有类型——那会让"可机验"这个安全判据失效。

---

## 5. 推翻流程与推翻率

### 5.1 推翻流程

推翻是**唯一允许改变已 confirmed 结论状态的路径**，它必须比"改一条笔记"更麻烦，但比"重开一轮评审"轻：

1. **提交推翻申请**（人可直接提；agent 可基于采集信号提议）：必须附**新证据锚点**与**原因分类**，以及影响面清单（`actions` 字段反查得到的下游资产）。没有新证据的推翻申请不受理——否则推翻会退化成情绪表达。
2. **写事件流留痕**：`ledger.entry.overturn_requested`。状态暂不变，条目进入人工裁决队列（介入点类型 = 风险仲裁型：并列原证据与新证据，人选边）。
3. **人工确认后写 `ledger.entry.overturned`**：原条目 `status: overturned`，填 `overturn` 字段，**保留全文不删除**，并可用 `superseded_by` 指向取代它的新条目。
4. **下游联动**：`actions` 里已驱动过的不可逆动作（如已合入的代码、已冻结的契约）不自动回滚，而是生成一条"需要复核"的清单推给人；未执行的依赖则该条目的 `provisional`/失效状态直接阻断其放行。
5. **知识回流**：推翻记录进入知识库回流管道——同类结论此后自动降置信度、强制投票。

### 5.2 三个自动采集来源

推翻不能只靠人偶然想起来。三个来源全部**回链条目 id** 自动采集：

| 来源 | 触发信号 | 自动动作 |
|---|---|---|
| 测试失败 | 用例失败 → 按用例 id 反查其来源条目（`actions` 字段反向索引） | 生成推翻申请候选（附失败输出作为新证据），推给对应角色 |
| 线上问题归因 | 问题单关联需求 id → 定位相关条目 | 生成推翻申请候选 |
| 后续需求探索 | 探索 agent 发现历史结论与新证据冲突 | 提交推翻申请（附新证据锚点） |

三个来源都**只生成申请、不自动改状态**：状态变更一律经人工确认（§5.1 第 3 步）。这条约束保证了"推翻"始终是一个留痕的、有据的动作。

### 5.3 推翻率：定义、分类与解读

**推翻率 = 观察期内被标记 `overturned` 的条目数 ÷ 同期 `confirmed` 条目数。**

它是共识质量三指标之一，也是 bad case 回流的量化形态。按原因四分类统计，每一类指向不同的改进动作：

| 原因分类（token） | 含义 | 指向的改进 |
|---|---|---|
| `insufficient_evidence`（证据不足） | 当时的锚点不足以支撑结论 | 提高入账门槛的落地质量：证据覆盖率检查、锚点粒度校准 |
| `semantic_misunderstanding`（语义理解错） | 对需求/契约的理解本身就错了 | 难度门收紧、语义类决策强制落 needs_verification（见 [`./05-voting.md`](./05-voting.md) §3）、知识条目复述检验 |
| `requirement_change`（需求变更） | 需求本身改了，结论没有错 | 不计入机制失败：单独计数，用于校准触发式升级与变更影响分析 |
| `external_dependency_change`（外部依赖变化） | 上游接口/第三方/环境变了 | 扩展锚点覆盖面（依赖面锚点）、外部依赖监控接入 |

**推翻不追责。** 指标用于改进机制，不用于评价个人或 agent。这不是道德要求而是机制要求：一旦推翻被追责，理性行为就是"把条目标低置信度逃避责任"或"干脆不入账"，指标会在半年内变成全绿而机制已死（指标博弈）。对抗性设计是**抽查审计"应被推翻而未被发现"的条目**，而不是惩罚推翻者。

**被推翻的结论本身也是知识。** 原条目保留全文（statement + 原锚点 + 推翻原因 + 新证据），检索时标注"已推翻（原因：X，取代者：C-014）"。理由有二：其一，它记录了"我们当初为什么会这么想"，这是最便宜的组织记忆；其二，防止同一形态的错误在下一个需求里重新长出来——这也是知识库复述检验所防的"错误信息被反复引用获得权威"的镜像用法：错误信息被反复引用时应当看到它的失效标记。

**零推翻率是警报，不是满分。** 观察到推翻率为零时，先排除三种假健康：

1. **验证信号太弱**：测试与线上监控根本覆盖不到这些结论，所以永远不会失败；
2. **观察期太短**：需求刚上线，问题还没暴露；
3. **摩擦太高**：推翻流程比"忍着"更贵，人选择不记——这时条目状态与真实信任度已经脱钩。

于是"推翻率多少算健康"没有固定区间，正确解读方式是与独立一致度**联合分桶**看（见 [`./05-voting.md`](./05-voting.md) §7），并在观察期口径确定后校准。

---

## 6. 账本、事件流与 git 的关系

### 6.1 分工

| 载体 | 角色 | 可变性 | 谁读它 |
|---|---|---|---|
| `events.jsonl` | **历史层**：唯一的事实与顺序来源 | append-only，永不清理 | 程序（审计、对账、投影）；**永不进 LLM 上下文** |
| `ledger.yaml` | **判定层**：事件流折叠出的当前状态投影 | 只经事件流更新（禁手工改状态字段） | 机判逻辑（门禁放行、锚点求交、投票写回） |
| 快照文档（`prd/adr/plan/findings.md`） | **最新层**：给人读的最新视图 | 人可编辑 + 主动清理 | 人与 agent 的上下文包来源 |
| git | **版本化权威**：所有上述文件的版本与 diff | 提交即历史 | 人工合入评审（diff/PR） |

为什么必须把"历史"和"现状"拆成两层：两者在物理形态上是矛盾的——事件溯源要只增不减，快照要主动瘦身。矛盾只发生在"同一层既当历史又当现状"时，**分层即化解**：事件流保真，快照层放心清理（历史永远在事件流与 git 里）。这也让"人要看到"和"机器要能查"两个需求各自拿到合适的形态。

### 6.2 与账本相关的事件类型

事件信封（`event_id` / `seq` / `type` / `schema_version` / `timestamp` / `actor{kind,id}` / `session_id` / `correlation_id` / `source{adapter}` / `payload`）与事件家族的完整定义属架构章（[`./03-architecture.md`](./03-architecture.md) §3.1 为权威定义）；本节只列账本相关的子集。事件类型是**闭合目录**：家族命名（`ledger.*` / `vote.*` / `gate.*` …），新增类型走 ADR，改字段走 `schema_version`。

| 事件类型 | 触发 | 关键 payload |
|---|---|---|
| `ledger.entry.proposed` | 新条目入账（默认 `provisional`） | `entry_id, title, statement, anchors[], status` |
| `ledger.entry.confirmed` | 晋升 confirmed | `entry_id, confidence_source, vote_record_id?` |
| `ledger.entry.anchor_drifted` | 重锚定三级全失败 | `entry_id, anchor_id, attempt[]` |
| `ledger.entry.reconfirmed` | 重验通过（回到 confirmed）或重锚定成功（携带新锚点） | `entry_id, anchors[], evidence[]` |
| `ledger.entry.overturn_requested` | 提交推翻申请 | `entry_id, reason, evidence[], impact[]` |
| `ledger.entry.overturned` | 人确认推翻 | `entry_id, reason, evidence[], superseded_by?` |
| `vote.completed` | 一次投票完成 | `entry_id, vote_id, decision, anchor_overlap` |
| `gate.passed` / `gate.blocked` / `gate.escalated` | 门禁放行 / 阻断 / 升级（判定结果三态 `pass` / `block` / `warn-and-continue` 由 `result` 区分；`escalate` 是 `on_fail` 的动作，不是第四种结果） | `gate_id, entry_ids[], result` |

```jsonl
{"event_id":"01J9Z3K7...","seq":41,"type":"ledger.entry.proposed","schema_version":"1","timestamp":"2026-09-24T14:02:11+08:00","actor":{"kind":"agent","id":"explore-agent"},"session_id":"REQ-2026-042","correlation_id":"01J9Z3K7...","source":{"adapter":"cli"},"payload":{"entry_id":"C-002","title":"gate 触发条件只由 attach.triggers 声明","status":"provisional","anchors":[{"kind":"code","anchor":"src/gate/trigger-registry.ts#TriggerRegistry.resolve","snapshot":{"commit":"9f3c1ab7d2e5","lines":"405-430","content_hash":"sha256:3b1f..."},"line_hint":"trigger-registry.ts:412"}]}}
{"event_id":"01J9Z3K8...","seq":44,"type":"vote.completed","schema_version":"1","timestamp":"2026-09-24T14:09:38+08:00","actor":{"kind":"system","id":"voting"},"session_id":"REQ-2026-042","correlation_id":"01J9Z3K7...","source":{"adapter":"system"},"payload":{"entry_id":"C-002","vote_id":"V-0009","decision":"confirmed","anchor_overlap":0.0}}
{"event_id":"01J9Z3K9...","seq":45,"type":"ledger.entry.confirmed","schema_version":"1","timestamp":"2026-09-24T14:09:40+08:00","actor":{"kind":"system","id":"voting"},"session_id":"REQ-2026-042","correlation_id":"01J9Z3K8...","source":{"adapter":"system"},"payload":{"entry_id":"C-002","confidence_source":"vote_agreement","vote_record_id":"V-0009"}}
```

### 6.3 写入路径收敛

**所有状态机流转只能经单一 `append_event` 写入函数，投影进 `ledger.yaml`；不允许任何入口直接改 `ledger.yaml` 的状态字段。**

理由：写路径一旦分散（CLI 一处、git hook 一处、IM 路由一处、agent 工具调用一处），就必然出现绕过脱敏、时间戳不规范、状态机被跳过的入口，事件流与现状随即漂移，审计链断裂。收敛到单一函数后，下面三件事才有保证：

- 状态机校验（非法流转直接拒绝写入）；
- 时间戳规范化与 `event_id` 唯一性（用于合并去重）；
- **凭证脱敏默认开启**——事件流会进 git，一次误粘贴的 token 会永久留在历史里。

### 6.4 防漂移检查

`ledger.yaml` 是投影，投影就可能与源头漂移。提供一条确定性检查命令（`cord doctor`），做三件事：

1. **fold 对账**：从事件流折叠（fold）出每个条目的期望状态，与 `ledger.yaml` 实际状态逐条比对，不一致即告警；确认投影有误时，直接由事件流**重建** `ledger.yaml`（投影可再生，这是它敢被称为派生层的底气）。
2. **事件流完整性校验**：校验 `seq` 连续性（无空洞）与 `event_id` 唯一性——**丢事件必须可见**，这是审计系统的最低要求。
3. **显示层漂移可见化**：比对 frontmatter/文档描述与账本状态是否一致，不一致只告警不阻断（显示层漂移可容忍，但必须可见）。

该命令可挂进提交前置钩子与 CI，与防腐钩子共用同一套锚点索引。

### 6.5 事件流进 git 的合并问题

事件流必须进 git（它是权威历史，不能 gitignore），但 append-only 的 JSONL 在分支合并时会踩一个已知的坑：两个分支各自追加事件后 merge，git 的三路合并按散文处理必出内容冲突，而无论选 `--ours` 还是 `--theirs` 都会**永久丢事件**。采用的做法：

- **union merge driver**：在 `.gitattributes` 中为 `cord/**/events.jsonl` 注册自定义合并驱动，按 `event_id` 去重、按 `(seq, event_id)` 排序做并集合并（这是 spec-kitty 等项目的生产事故与修复方案给出的路子）；合并后由 `doctor` 校验 `seq` 连续性与 `event_id` 唯一性（§6.4）。
- 备选（事件量增长后启用）：每事件一文件（`events/<ulid>.json`，git 天然无冲突），或按里程碑/按日分片以降低冲突概率。

被否决的方案是把事件流 `gitignore` 掉、只定期提交 checkpoint——它会让"事件流是唯一事实与顺序来源"在分支场景下失效，也让事件流失去 diff/PR 可评审性。

### 6.6 事件流永不进 LLM 上下文

协调 agent（coordinator）与各角色 agent 只消费投影后的产物：快照文档 + 上下文包 + 账本条目摘要。**事件流只给人审计、给程序查询用**（ADR-0003）。

原因与上下文剪裁是同一个：上下文窗口是稀缺资源，把完整历史塞进 prompt 只会引入噪声和漂移，还给了 agent 一个"用历史细节自我说服"的机会。纪律需要强制：事件流文件不在任何 agent 的可见路径白名单里，而不是靠提示词叮嘱。

---

## 7. 本章小结与待校准项

已定型的部分：共识定义与三要素、账本条目 schema、三条写入规则、证据锚点三层结构、推翻流程与四类原因分类、账本/事件流/git 三层分工与防漂移检查。

以下参数是**初值，需要实验校准**（不影响机制形状）：

| 待校准项 | 当前初值 | 校准方式 |
|---|---|---|
| 锚点失效判定阈值（重锚定的相似度门限） | 待定 | 实验四（防腐钩子误伤率） |
| L2 锚点求交的误伤率上限 | 待定 | 实验四；同时用符号级求交 + 格式化豁免清单压低 |
| 推翻率观察期时长 | 未定义；建议初值 = 覆盖同一业务线连续 10 个需求（待校准，非依据） | M3 试点 + 上线后观察数据；观察期口径未定前，推翻率只作描述性统计 |
| 哪些提交可进豁免清单、由谁审核 | 未定 | 团队约定 + 审计抽查 |
| 事件流分片策略的启用时点 | 单文件 | 事件量增长后切换（不影响 schema） |

需要外部输入的部分：已人工确认的历史决策集（含被推翻的）用于回放实验；仓库的符号索引能力评估（决定动态语言栈上是否允许降级为「文件 + 内容 hash」锚点）。

---

## 8. 参考来源

本章的外部依据（结论性主张均指向下列一手来源，供独立复核）：

| # | 来源 | 用于本章的哪条主张 |
|---|---|---|
| 1 | [GitHub spec-kit《Spec Persistence Models》](https://github.com/github/spec-kit/blob/main/docs/concepts/spec-persistence.md) | spec 变更后的持久化策略无标准答案，官方把 living / flow-back / flow-forward 留给团队约定——统一 Spec 的同步负担是真实痛点 |
| 2 | [OpenSpec 目录约定与 delta/archive 机制](https://github.com/Fission-AI/OpenSpec/blob/main/docs/getting-started.md) | "以变更为单位 + 事后折叠"与账本的推翻留痕同构 |
| 3 | [MADR](https://github.com/adr/madr) / [adr-tools](https://github.com/npryce/adr-tools) / [Log4brains](https://github.com/thomvaill/log4brains) | 决策记录入仓 + supersede 链接 + 状态机流转是数十年的成熟实践 |
| 4 | [SWHID 规范（限定符 `anchor`/`path`/`lines`）](https://swhid.org/swhid-specification/v1.2/6.Qualified_identifiers/)与 [SWHID 教程](https://www.softwareheritage.org/2025/06/13/software-hash-identifier-swhid-tutorial/) | 内容寻址 + commit 锚定 + 行范围限定符是学术级、标准化的证据存档形式（ISO/IEC 18670）；但它不是活锚点 |
| 5 | [difftastic](https://github.com/Wilfred/difftastic) 与 [AST diff 工具重构精度 benchmark（TOSEM）](https://arxiv.org/pdf/2403.05939v2) | 语法树 diff 能区分"格式化/重命名"与真实语义变更，是锚点求交的实现基础 |
| 6 | [RefactoringMiner](https://github.com/tsantalis/RefactoringMiner) | 符号重命名/移动的检测，用于重锚定 |
| 7 | [git blame 文档与 `.git-blame-ignore-revs`](https://git-scm.com/docs/git-blame) | 内容追踪（`-M -C`）与格式化豁免清单都是 git 内置能力，不需要新基建 |
| 8 | [spec-kitty issue #569：JSONL 事件流在 git 合并下丢事件](https://github.com/Priivacy-ai/spec-kitty/issues/569) | 事件流进 git 的合并事故与 union merge driver 方案 |
| 9 | [projectmem（arXiv 2606.12329）](https://arxiv.org/html/2606.12329) | 事件溯源 + JSONL + Markdown 投影 + 单一写路径 + 脱敏默认开启的同构系统实践 |
| 10 | [Martin Fowler《Event Sourcing》](https://martinfowler.com/eaaDev/EventSourcing.html) 与 [Azure《Event Sourcing Pattern》](https://learn.microsoft.com/en-us/azure/architecture/patterns/event-sourcing) | 快照是回放优化而非对 log 的替代——"事件流保真、快照可清理"的依据 |

上述第 8-10 条的机制细节与布局论证见 [`./03-architecture.md`](./03-architecture.md)；锚点重锚定的三级路径与误伤率校准见 [`./07-context.md`](./07-context.md) 与 [`./12-experiments.md`](./12-experiments.md)。

---

**交叉引用**：[`./05-voting.md`](./05-voting.md) 定义写进 `vote_record` 字段的 VoteRecord schema 与放行规则；[`./07-context.md`](./07-context.md) 定义防腐钩子的三级挂载与锚点重锚定的实现细节；[`./06-gates-workflow.md`](./06-gates-workflow.md) 定义 gate 如何消费条目状态放行；[`./08-self-evolution.md`](./08-self-evolution.md) 定义 `knowledge` 类型锚点与 KB 条目的生命周期；[`./12-experiments.md`](./12-experiments.md) 给出推翻率与锚点相关参数的校准实验协议。

**本文档与相邻章节的分工**：04 章负责"账本与锚点**是什么**"（数据结构、状态机、失效语义）；07 章负责"锚点**怎么被用**"（防腐钩子求交、上下文剪裁共用同一套索引）；12 章负责"这些参数**怎么被校准**"。
