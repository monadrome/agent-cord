# ADR-0010 ｜ SSOT 存储与版本化：纯文件 + git + 文件夹内事件流 + 账本

- 状态：accepted（设计定稿，代码未实现）
- 日期：2026-09-24
- 关联：ADR-0003（共识载体）、ADR-0005（账本条目 schema）、ADR-0012（事件模型与分发）、ADR-0015（知识库存储）
- 补充：ADR-0020（事件协议与确定性 reducer：seq 血统语义、因果链、合并全序、投影契约，2026-09-24 拍板）
- 来源：本方案技术选型调研（2026-09，内部调研纪要）——SSOT / 共识快照的存储与版本化；落实 CP-11、CP-12、CP-18、CP-19 的相关取舍

## 背景

在已定型的设计约束下（SSOT = 共识快照文件夹、事件溯源、协调 agent 只看最新快照），本决策点实际要回答四个收窄后的子问题：

1. **快照文件夹的标准布局**：`prd.md / adr.md / plan.md / findings.md` 之外还缺什么（账本、事件流、知识条目放哪）；目录与文件名如何约定，才能让 agent 和人零培训定位。
2. **文档版本怎么表达**：git 提交历史、frontmatter 版本字段，还是两者结合——关键是「谁是权威」，防止双写漂移。
3. **事件溯源与最新快照如何共存**：领域模型要求事件溯源，快照设计又要求「主动清理历史」；append-only 事件流与「只看最新」的快照文档是两种相反的物理形态，必须决定事件流放哪、快照是手工维护还是机器投影、清理清的是哪一层。
4. **协调 agent「只看最新快照」如何技术上强制**：注入时剪裁，还是文件系统层只读。

约束条件：开源基座、不绑定厂商、首个用例是 dogfooding 自己的开发仓库、agent 通过**驱动现成 CLI** 工作（agent 天然能读整个仓库文件系统，「看不见」只能靠机制保证）、合入永远人工（diff 必须可评审）。

## 备选方案

### 备选 A：纯文件系统 + git，无独立事件流（文档即 SSOT，历史全靠 git log）

- **是什么**：快照文档就是全部状态；发生变更直接编辑文档，git 提交即历史。
- **优点**：零基建；人可读性最高；diff/PR/blame 全套现成；与文档即代码生态完全一致。
- **缺点**：无法区分「权威状态」与「演进历史」——状态机留痕（推翻、门禁拦截）没有结构化载体，只能写进散文；投票记录、锚点重合检查、门禁三态等**机判逻辑没有可查询的数据源**；「主动清理历史」会把审计线索从工作区抹掉，人审 diff 时看不到语义化留痕。
- **契合度**：低。满足「人可读」但满足不了「机器可判」，而本项目的差异化恰在机判。

### 备选 B：纯文件系统 + git + 文件夹内 append-only 事件流（事件溯源 + 投影快照）

- **是什么**：快照文件夹内除文档外还有 `events.jsonl`（append-only，每行一个 JSON 事件）与机读账本（yaml）；markdown 文档是从事件流可再生的投影，或人工维护但事件留痕的「最新视图」；git 版本化一切。
- **优点**：事件流天然满足变更写入、投票留痕、推翻单向状态机的审计需求；JSONL 可 grep / diff / PR 评审，符合「证据可机验、可复核」；快照文档主动清理无心理负担——历史永远在事件流与 git 里；与独立同类系统（本地优先、事件溯源、JSONL + Markdown、确定性投影）同构。
- **缺点**：append-only 事件流在 git 分支合并时产生内容冲突（有成熟解，见注意点 1）；需要定义事件 schema 与投影/折叠规则，比纯编辑文档多一点协议。
- **契合度**：最高。是唯一同时满足「事件溯源 + 快照主动清理 + 人可评审」的形态。

### 备选 C：SQLite 嵌入式为主存储

- **是什么**：每个需求一个 `.db`（或整库一个 db），文档、账本、事件全进表；markdown 仅作导出视图。
- **优点**：结构化查询强（状态机、锚点求交、投票统计 SQL 直出）；单文件、事务性；无服务端。
- **缺点**：二进制文件在 git 里不可评审，与「合入永远人工、diff 可评审」的安全边界直接冲突；agent 经现成 CLI 读 db 需额外工具桥接，违背「驱动现成 CLI、文件即上下文」的架构；数据被锁在 schema 后，与「人可读 SSOT」的初衷相悖。
- **契合度**：低。查询优势对本项目（单需求作用域、检索走符号/词法路线）是过剩能力，代价却是评审性与架构一致性。

### 备选 D：服务端数据库（PostgreSQL 等）

- **是什么**：SSOT 存服务端，文件夹只是导出物。
- **优点**：多并发写、多需求编排时一致性强；权限与备份成熟。
- **缺点**：引入部署依赖，杀死「clone 仓库即拥有全部 SSOT」的开源体验；离线不可用；文档即代码的评审链断裂；与第一阶段「作用域 = 单个需求」严重不匹配。
- **契合度**：极低，第一阶段明确否决。

### 备选 E（增强项而非平级备选）：文件为主 + SQLite 派生索引层

- **是什么**：备选 B 是权威存储；SQLite（FTS5）作为**可删除、可再生**的派生索引，服务知识库检索与跨需求查询。
- **优点**：拿到全文检索与跨需求统计，同时权威层保持纯文件；索引坏了删掉重建即可。
- **缺点**：多一个需要保鲜的组件；索引漂移风险（需每次写入或钩子触发重建）。
- **契合度**：高，但作为备选 B 的增强项——第一阶段可不上，检索需求出现时再加，接口边界不受影响（详见 ADR-0015）。

## 决策

**基座采用备选 B**：纯文件 + git + 文件夹内 JSONL 事件流 + 机读账本（`ledger.yaml`）。**备选 E 的 SQLite 派生索引作为后置的可插拔增强**。

配套决定：

1. **事件流进 git**，用 **union merge driver** 防合并丢事件（`.gitattributes` + 自定义 driver，按 `event_id` 去重、按 `(seq, event_id)` 排序做并集合并），并按日/里程碑分片降低冲突概率。**明确否决「`events.jsonl` 走 gitignore + 定期 checkpoint」方案**：可审计与「clone 即拥有 SSOT」是本项目核心卖点，事件量在单需求生命周期内是千行级，成本可接受。
2. **文档版本表达 = git 历史权威 + frontmatter 轻量状态字段**，frontmatter 非权威。规则一句话：**判定一律查事件流/账本，frontmatter 只是显示层**。
3. **协调 agent 的隔离 = 注入层剪裁（上下文包）为主，文件层只读副本/只读挂载为纵深防御，协议层写操作必经路由为兜底**。
4. **标准布局**（落在仓库根，与代码同仓，clone 即拥有全部 SSOT）：

```
cord/                              # SSOT 根目录
├── <req-id>/                      # 一个需求一个快照文件夹
│   ├── prd.md                     # frontmatter: id/状态/版本戳（显示层）
│   ├── plan.md
│   ├── adr.md                     # 决策记录，supersede 链接
│   ├── findings.md                # 调研/实验结论（快照文档，不是目录）
│   ├── ledger.yaml                # 共识账本：条目+状态机+证据锚点+投票记录（机判层）
│   ├── votes/                     # 该需求的投票与回放产物（VoteRecord 引用的 transcript）
│   └── events.jsonl               # append-only 事件流（历史层，永不编辑）
├── knowledge/                     # 跨需求知识条目（供检索与引用）
├── .index/                        # 派生索引（SQLite FTS5）：gitignore，可重建
└── cord.toml                      # 布局版本、事件 schema 版本、索引配置
```

5. **文档版本语义借用三档模型**做团队约定：`prd/adr` 用 living（现状即真相，历史在事件流）、里程碑类文档可用 flow-forward（归档即不可变历史记录），写进 `cord.toml` 供 agent 读取。

## 理由（第一性原理推导）

1. **从「合入永远人工」反推**：人工合入的载体是 PR/diff，因此 SSOT 的每一次状态变化必须能以文本 diff 呈现。这直接排除 C/D，锁定文件系统——这是硬约束，不是偏好。
2. **从「机判逻辑」反推**：投票、锚点重合检查、推翻状态机、门禁放行都需要程序查询「谁、何时、对哪条、投了什么、锚点是什么」。散文 markdown 做不到，因此必须有结构化层；结构化层若要可评审，最便宜的形态就是 JSONL/YAML，即备选 B。
3. **从「主动清理历史」与「事件溯源」的表面矛盾反推**：两者冲突只发生在「同一层既当历史又当现状」时。分层即化解：**事件流 = 永远只增的历史层（不可变，永不清理）；快照文档 = 主动维护的最新层（放心清理，因为历史在事件流 + git 里）**。这正是事件溯源的经典模式（快照是为避免全量重放的优化，log 仍是权威）；本项目把它反过来用：事件流保真，快照层允许人工编辑与主动瘦身——因为权威已在事件层。
4. **从「协调 agent 只看最新快照」反推**：协调 agent 由现成 CLI 驱动，文件系统对它是开放的，物理隔离不可靠；唯一可靠的控制点是**它启动时注入什么**。因此强制手段放在注入层（剪裁注入），文件层手段（只读副本/只读挂载）作纵深防御——kernel 级只读挂载无性能代价，但仍属兜底而非主机制。
5. **从「frontmatter 的价值与风险」反推**：frontmatter 放状态/版本戳的价值是**给 agent 读**（打开 prd.md 第一眼看到「本文档 v3、confirmed 条目 12」，而不是去跑 git log）。但绝不能让它参与判定——它与 git 真实历史可能漂移。因此规则是「显示层不参与判定」，与证据锚点中「行号只作显示层」结构同构。
6. **从「原生 git 生态」反推**：复用 `.gitattributes`、merge driver、blame、blame-ignore-revs 等既有能力，比自己发明一套版本与合并机制便宜一个数量级；「每事件一文件」虽无冲突但对象数量爆炸，分片 + merge driver 是成本与收益的平衡点。

## 被否方案的否决理由（逐一）

- **备选 C（SQLite 为主存储）**：否决于「diff 可评审」硬约束——二进制 db 无法 PR 评审，人工合入边界形同虚设；且 agent 经现成 CLI 读文件是最短路径，db 需桥接层，违背架构。其查询能力由账本 YAML + 可选派生索引（备选 E）以更小代价获得。
- **备选 D（服务端数据库）**：否决于开源定位与第一阶段作用域——引入部署依赖即杀死「clone 即拥有 SSOT」；单需求作用域下并发写冲突几乎不存在（append-only 事件流本身无写冲突语义）；多需求编排是第二阶段的事，届时也优先用「每需求一文件夹 + git」的隔离，而非中央库。
- **备选 A（纯文档无事件流）**：作为目标形态否决——机判逻辑无结构化载体，投票/锚点/状态机/门禁中至少五条需求无法落地。它可作为早期脚手架的退化形态，但不是设计目标。
- **「frontmatter 版本字段为权威」**：否决——双写权威必然漂移；且与「显示层不参与判定」的原则冲突。文档持久化的语义本身就没有无副作用的默认值，业界成熟工具的官方立场也是「留给团队约定」，因此我们显式约定：git 与事件流权威，frontmatter 只显示。
- **「`events.jsonl` gitignore + 定期 checkpoint 提交进 git」**：**明确否决**。理由有三：① 可审计性是本项目的核心卖点，把事件流排除在版本控制之外意味着 clone 得到的不是完整 SSOT，审计链要依赖外部产物；② checkpoint 是派生视图，用它替代事件流就等于把「历史层」降级为「定期快照」，丢失事件级顺序与幂等语义；③ 成本论证不支持——单需求生命周期内事件量在千行级，文本 JSONL 的 git 体积与 diff 成本可接受，而合并冲突有成熟工程解（union merge driver + 分片）。checkpoint 仍作为**回放优化**保留（见注意点 9），但它是派生品，不是替代品。
- **「每事件一个文件（`events/<ulid>.json`）」**：不作为主方案。它确实消除合并冲突，但对象数量膨胀、目录噪声大、grep 与 diff 的可用性差；保留为极端冲突场景下的备选形态（在 `cord.toml` 中可切换）。

## 关键实现注意点

1. **JSONL 事件流 × git 合并冲突（最大的坑）**：两个分支各自追加事件后 merge，git 按文本三路合并必出内容冲突，而任取一侧都会**永久丢事件**（已有生产事故先例：多个工作包全部 approved，合并后状态板显示 0/N）。解法按推荐度：(a) 注册 git merge driver（`.gitattributes` + 自定义 driver），按 `event_id` 去重、按 `(seq, event_id)` 排序做并集合并；(b) 每事件一文件（git 天然无冲突）；(c) 事件按日/按里程碑分片降低冲突概率。本项目采用 **(a) + (c) 组合**。
2. **写入路径收敛**：所有写事件（CLI、git hook、IM 路由、agent 工具调用）必须汇聚到单一 `append_event` 函数——只有集中写路径才能保证脱敏、时间戳规范化、状态流转逻辑不被某个入口绕过。特别注意**凭证脱敏默认开启**（事件流会进 git，一次粘贴的 token 会永久留在历史里）。
3. **事件 schema 必须带 `schema_version` 字段**：布局会演进，解析器按版本分派；`cord.toml` 记录当前布局版本，提供 `doctor` / `upgrade` 命令做迁移。
4. **快照文档与事件流的边界**：`prd.md` 等允许人工直接编辑（这是「主动清理」的落点），但凡是状态机流转（confirmed / overturned）、投票、门禁判定，**只能经 `append_event` 写事件流**，再投影/同步进 `ledger.yaml`；否则事件流与现状漂移，审计链断裂。建议提供确定性检查命令（fold 事件流得到的期望状态 vs ledger 实际状态）并纳入 CI。
5. **事件流不进 LLM 上下文**：协调 agent 与各角色 agent 只消费投影（快照文档 + 上下文包）；事件流是人审计与程序查询用的。别让「我们有完整历史」变成「把历史全塞进 prompt」——那是上下文腐化的直接来源。
6. **协调 agent 隔离三层防御的逐条落实**：(1) 注入层——coordinator 只挂载上下文包（前置高信号层 + 定位符层），会话里不给快照文件夹路径的写权限，可给 JIT 读白名单；(2) 文件层——本地运行时把快照文件夹以只读方式提供（只读挂载或只读 checkout 副本），kernel 级强制、无性能开销；(3) 协议层——agent 要推动作必须经路由写入。三层是纵深，不是三选一。
7. **frontmatter 规范**：只放 `{id, status, 版本戳, 依赖文档 id}` 等显示性字段，禁止放机判字段；CI 可加一条「frontmatter 与 ledger 状态不一致即告警」——显示层漂移可容忍但应可见。
8. **知识库位置与索引边界**：`cord/knowledge/` 是唯一跨需求目录；需求归档后其 confirmed 条目的**抽取**（不是移动）入 knowledge。索引层（SQLite FTS5）只索引 `knowledge/` + 各 `ledger.yaml`，标记为 derived，进 git 或 gitignore 均可，但必须提供 `cord index --rebuild` 全量重建命令——再生成本高的索引不允许存在。索引实现细节见 ADR-0015。
9. **体量控制与快照事件**：单需求事件流预计千行级，无需快照折叠；若长期项目膨胀，定义一条 `snapshot` 事件类型（「截至此事件的折叠状态」），回放从最近 snapshot 起——标准事件溯源做法，不需要自定义机制。
10. **证据锚点的三层结构（与账本 schema 联动）**：**符号锚点（活，参与判定）+ commit SHA 与内容 hash（存档）+ 行号（仅显示层）**。防腐求交在符号级做，行号不参与判定（漂移与巧合重合都会污染）。配套降误伤手段：符号级求交、格式化提交豁免清单（`.git-blame-ignore-revs` 式）、`git blame -M -C` 内容追踪。三级解析全部失败才判定锚点失效，条目降回「临时」——锚点失效本身是信号。
11. **git union 合并的实测边界（2026-09-24 校准，复现记录见 [docs/research/2026-09-24-04](../research/2026-09-24-04-event-sourcing-file-ssot.md)）**：
    - union 是 git **内建** driver，但不去重、不排序（官方文档明示合并后行序随机），且对「一侧原地修改 + 对侧追加」会无冲突地产生重复记录——已实测复现。因此注意点 1 的自定义 driver（按 `event_id` 去重 + 按 `(seq, event_id)` 排序覆写 `%A`）是必需项，不是可选项；读侧一律按逻辑时钟排序，不依赖文件行序。
    - **`ledger.yaml` 及任何结构化文件严禁挂 union**：原地修改 + union = 重复记录；结构化文件双侧同改时 union 还会产出语法无效的 YAML。`ledger.yaml` 必须是 `events.jsonl` 经确定性 reducer 派生的产物（与注意点 4 的投影关系一致），合并只发生在事件流层、由 merge driver 解决。
    - **`event_id` 必须全局唯一（ULID），禁止由内容哈希派生**：两侧追加逐字节相同的行会被三路合并静默折叠成一条——两个投票 agent 投出内容相同的票若共用 ID 会被合并成一票，共识计数直接错。
    - 自定义 merge driver 定义在 `.git/config`，**不随仓库分发**：`cord init` 负责注册 `.gitattributes` 与 driver，`cord doctor` 必须检测「当前 clone 是否已挂上 driver」，否则新克隆会静默退回文本合并。

## 证据来源

1. 本方案技术选型调研（2026-09，内部调研纪要）：备选 A–E 对比、布局建议、版本语义、被否理由含「frontmatter 权威」否决、9 条实现注意点。
2. 与本推荐几乎逐项同构的一手系统论文（本地优先、事件溯源、JSONL + Markdown、确定性投影、单一写路径、脱敏默认开启）：projectmem（arXiv 2606.12329, 2026）https://arxiv.org/html/2606.12329
3. JSONL 事件流在 git merge 下丢事件的完整事故记录与 union merge driver 方案：spec-kitty issue #569 https://github.com/Priivacy-ai/spec-kitty/issues/569
4. 事件溯源经典文献（append-only store + 快照作为回放优化，log 仍是权威）：Martin Fowler, *Event Sourcing* https://martinfowler.com/eaaDev/EventSourcing.html ；Microsoft Azure, *Event Sourcing Pattern* https://learn.microsoft.com/en-us/azure/architecture/patterns/event-sourcing
5. 文档持久化语义三档模型（官方明确「无默认答案、留给团队约定」——本项目因此显式约定版本语义）：GitHub spec-kit, *Spec Persistence Models* https://github.com/github/spec-kit/blob/main/docs/concepts/spec-persistence.md
6. 目录约定先例（按需求/变更分目录 + delta 折叠进主文档）：OpenSpec https://github.com/Fission-AI/OpenSpec/blob/main/docs/getting-started.md ；https://github.com/Fission-AI/OpenSpec/blob/main/openspec/specs/openspec-conventions/spec.md
7. 「SQLite 是可再生派生索引」的形态先例：memweave https://levelup.gitconnected.com/memweave-zero-infra-ai-agent-memory-with-markdown-and-sqlite-no-vector-database-required-cf3869efc840 ；kbx https://github.com/tenfourty/kbx
8. kernel 级只读挂载强制 agent 文件访问、实测无性能开销：https://swarmz.net/blog/restrict-an-ai-coding-agents-file-system-access
9. 决策记录入仓 + supersede 链接 + 状态机流转的实践：MADR https://github.com/adr/madr ；log4brains https://github.com/thomvaill/log4brains
10. 证据锚点三层结构与降误伤手段：配套调研（2026-09）Q3（五种锚点形式对比、`git blame -M -C` 内容追踪与 LLVM 的跨项目移动约定 https://releases.llvm.org/7.0.1/docs/Proposals/GitHubMove.html 、`.git-blame-ignore-revs` 豁免、difftastic AST diff https://github.com/Wilfred/difftastic 、SWHID 内容寻址标识符 https://swhid.org/swhid-specification/v1.2/6.Qualified_identifiers/ ）。
11. 项目内部：2026-09-24 项目协作群关于共识快照与 SSOT 维护的讨论；方案提案 §6.1（账本 schema 与证据锚点）、§6.4（防腐钩子与行号漂移风险）；工作清单 W1.3（事件溯源、可中断恢复）、W3.1。
12. 开源实现调研归档（2026-09-24）：git union 合并的实测复现（原地修改产生重复记录、行序随机、逐字节相同行被折叠）、merge driver 配置不随仓库分发、「`ledger.yaml` 严禁 union、由事件流经 reducer 派生」的结论：[docs/research/2026-09-24-04-event-sourcing-file-ssot.md](../research/2026-09-24-04-event-sourcing-file-ssot.md)
