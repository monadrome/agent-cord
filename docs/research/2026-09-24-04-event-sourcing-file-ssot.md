---
title: 事件溯源与文件型 SSOT 存储
date: 2026-09-24
type: research-archive
status: 调研结论均为 2026-09-24 当日实测，时效性敏感（star 数、版本、license 可能变化）
---

研究完成。以下是完整报告。

---

# agent-cord 可复用开源实现调研：事件溯源与文件型 SSOT 存储

**调研方法**：全部结论来自实测或一手来源。我用 `gh api` / npm registry 拉了仓库元数据（star、license、最后提交、最后发布），在本地 Node v25.8.0 上跑了 6 组实验验证关键假设（FTS5 中文检索、YAML 注释往返、Markdown 往返、git union 合并四种冲突形态、并发 JSONL 追加、zod/ajv 校验），并读了 SQLite / git 官方文档与三项同类项目的 issue。

---

## 0. 先说三个必须修正的设计假设

这三条是本次调研最有价值的产出，都经过实测复现，建议直接回写设计文档：

**① `merge=union` + 原地修改 = 静默产生重复记录。** 我实测复现：一侧把 `{"id":"e1","seq":1}` 改写成 `{"id":"e1","seq":1,"status":"confirmed"}`，另一侧追加 `{"id":"e2","seq":2}` —— git 用 union 合并**成功退出、无冲突**，结果文件里 e1 出现了两条（旧版 + 新版）。这正是 [DEV 上那篇 append-only ledger 实战复盘](https://dev.to/rulestack/two-writers-one-append-only-ledger-the-git-conflict-one-gitattributes-line-fixed-and-the-files-55j0) 说的"union 是重复记录生成器"。
→ **结论：`ledger.yaml` 绝不能挂 `merge=union`。** 它必须是从 `events.jsonl` 派生的产物（reducer 输出），或者用"每条目一文件"的布局从根上消除冲突。

**② trigram 分词器不支持 2 字中文查询。** 实测：`tokenize='trigram'` 下 `MATCH '智能体'`、`MATCH '证据锚点'` 命中，但 `MATCH '锚点'`、`MATCH '评审'` **恒为 0 命中**（SQLite 官方文档明确："少于 3 个 unicode 字符的子串不匹配任何行"）。而 `unicode61` 更糟：整串汉字是**一个 token**，`MATCH '"证据锚点"'` 也是 0。
→ **结论：设计里的"trigram 中文分词"不足以支撑中文检索**，需要补一层短查询策略（见 §6，我实测了两套可用方案）。

**③ 两侧追加逐字节相同的行，会合并成一条。** 实测：A、B 两分支各自追加完全相同的 `{"id":"e9","seq":9}`，合并后文件里 e9 **只有一条**。这是三方合并本身的性质（不是 union 驱动的锅），意味着"同一个事件被两个 agent 独立写出"会被静默折叠。
→ **结论：`event_id` 必须全局唯一（ULID/UUID），绝不能由内容哈希派生** —— 否则两个 agent 投出同样的票会被合并成一票，共识计数直接错。

另外两条运营层面的发现：git 官方文档对 union 的描述是"结果文件里追加的行**顺序是随机的**"，所以读侧不能依赖文件顺序表达因果，必须按逻辑时钟排序；而自定义 merge driver 只能配在 `.git/config`（**不随仓库分发**），所以 agent-cord 必须提供安装 + 自检命令（`cord init` / `cord doctor`），否则新克隆的人静默退回文本合并。

---

## 1. 事件溯源库（TypeScript）

| 库 | 仓库 / license | 活跃度 | 提供什么 | 匹配度 |
|---|---|---|---|---|
| **Emmett** | [event-driven-io/emmett](https://github.com/event-driven-io/emmett) · 539★ · **无 license** | 极活跃（今日仍有提交），npm 0.42.4 / 2026-08-12，11.4k 周下载 | `EventStore` 抽象、聚合、投影、命令处理、多后端（postgres / sqlite / mongodb / esdb） | **不匹配（法律风险）** |
| **Castore** | [castore-dev/castore](https://github.com/castore-dev/castore) · 276★ · MIT | **停滞**：最后提交 2025-10-12，最后发布 2.4.2 / 2025-04-18，2k 周下载 | EventStore + 聚合 + 事件携带状态转移 + DynamoDB adapter | 只能借鉴 |
| **@ocoda/event-sourcing** | [ocoda/event-sourcing](https://github.com/ocoda/event-sourcing) · 270★ · MIT | 低：最后提交 2026-04-17（只有 dependabot），701 周下载 | NestJS 绑定的 event sourcing 三件套 | 不匹配（框架绑定） |
| **@nestjs/cqrs** | [nestjs/cqrs](https://github.com/nestjs/cqrs) · 941★ · MIT | 活跃，425k 周下载 | CQRS 模块，**不含事件存储** | 不匹配 |
| **LiveStore** | [livestorejs/livestore](https://github.com/livestorejs/livestore) · 3715★ · Apache-2.0 | 极活跃，@livestore/livestore 0.4.0 / 2026-06-02 | **事件日志为 SSOT → materializer → SQLite 物化视图**，带事件 schema 版本迁移与 reactive 查询 | **只能借鉴（架构最贴合）** |
| **KurrentDB 客户端** | [kurrent-io/KurrentDB-Client-NodeJS](https://github.com/kurrent-io/KurrentDB-Client-NodeJS) · 177★ · Apache-2.0 | 活跃，16.7k 周下载 | EventStoreDB（已更名 KurrentDB）官方客户端 | 不匹配（需外部服务） |
| **@alcalzone/jsonl-db** | [AlCalzone/jsonl-db](https://github.com/AlCalzone/jsonl-db) · 18★ · MIT | 中等：4.0.2 / 2025-10-15，24.8k 周下载，依赖维护到 2026-09 | append-only JSONL 文件 + **lockfile 并发保护** + 原子写 + 压缩 + 自动 compaction | **适配后复用** |
| **Dolt** | [dolthub/dolt](https://github.com/dolthub/dolt) · 24505★ · Apache-2.0 | 极活跃 | "git for data"：SQL 表级三方合并，冲突可 `SELECT * FROM dolt_conflicts` | 架构备选（放弃"纯文件"约束时） |

**Emmett 的 license 是个硬结论**：仓库无 LICENSE 文件，npm 包无 `license` 字段，README 里有一节标题就是 [**"Why there's no license?"**](https://github.com/event-driven-io/emmett#why-theres-no-license) —— 作者明说未来大概率走 **AGPLv3 和/或 SSPL** + open-core 模式（[RFC: PR #260](https://github.com/event-driven-io/emmett/pull/260)）。对 Apache-2.0 项目来说，"无 license" = 保留所有权利，**代码层面完全不可复用**，只能做 clean-room 的 API 形状借鉴。这条建议直接写进 ADR。

**Dolt 值得单独提示**：同类项目 beads 原本用 SQLite + `.beads/issues.jsonl` 进 git，现在已迁到 Dolt 后端（其 `.agent/workflows/resolve-beads-conflict.md` 把 JSONL 冲突处理标记为 **"Legacy"**）。原因正是 §0① 那类问题：**可变的记录型数据放在 git 文件里合并不可靠**。如果 agent-cord 的 ledger 冲突率在生产中失控，Dolt 是"整体换底座"的退路，代价是引入 Go 二进制、违背"纯文件+git"的定位。

---

## 2. Git 合并驱动 / append-only JSONL 的实践

这一节是 agent-cord 的**核心机制**，也是"必须自研"最确定的一块。

**git 内建的 `union` 驱动**：`.gitattributes` 写 `*.jsonl merge=union` 即可，无需 `.git/config`。官方文档（[gitattributes#built-in-merge-drivers](https://git-scm.com/docs/gitattributes#_built_in_merge_drivers)）原文警告："这往往会让追加的行在结果文件中顺序随机，使用者应自行验证结果。**如果你不理解其含义，不要使用。**"

**自定义 merge driver 机制**（官方文档已核实）：
```gitconfig
[merge "cord-event-log"]
    name = agent-cord event log union merge
    driver = cord merge-driver-event-log %O %A %B
    recursive = binary
```
占位符 `%O`(共同祖先) `%A`(当前) `%B`(对方) `%L`(冲突标记大小) `%P`(结果路径)；**驱动必须把结果覆写进 `%A` 并 exit 0**。关键限制：定义在 `.git/config`，**不进版本控制**。

**理想驱动的规格可以照抄 [spec-kitty issue #569](https://github.com/Priivacy-ai/spec-kitty/issues/569)**（[spec-kitty](https://github.com/spec-kitty/spec-kitty) 1641★ MIT，极活跃，与 agent-cord 问题域几乎重合）：读三份 JSONL → 以 `event_id` 去重 → 按 `at` 排序 → 覆写 `%A` → exit 0，并由 `spec-kitty upgrade` 自动注册 `.gitattributes` 与 `.git/config`。这个 issue 还把当前痛点写得很清楚："用 `--theirs` 解决后，7 个已批准的 WP 全部显示为 Planned，审计链丢了一半。"

**npm 生态现状：没有现成实现。** 我搜了 `merge driver` / `json merge driver` / `git merge driver` 三组关键词，全部结果如下，无一可用：
- `git-json-merge` 1.0.0 / 2023-01-26（npm，未维护）和 [`@patdx/git-json-merge`](https://jsr.io/@patdx/git-json-merge) 0.1.3 / 2025-12-31（JSR）—— 做的是**整个 JSON 文件**的三方合并，不是 JSONL 逐行去重
- `merge-drivers` 1.0.4 / 2025-08-29 —— 只是安装器
- `npm-merge-driver`、`sf-git-merge-driver` 等 —— 领域专用（lockfile / Salesforce XML）

→ **自研，约 100 行**，没有替代方案。

**另外两条值得知道的架构备选（都来自真实项目）：**
- [git-bug](https://github.com/git-bug/git-bug)（10068★ GPL-3.0，活跃）：数据存在 **git 对象**里（Lamport 时钟 + CRDT 操作），工作区根本没有会冲突的文件。因 GPL + Go，只能借鉴思路。
- [git-appraise](https://github.com/google/git-appraise)（5309★ Apache-2.0，2023-08 后停滞）：结构化记录存 **git refs/notes**，同样从根上避免工作区文件冲突。
- [jj](https://github.com/jj-vcs/jj)（31732★ Apache-2.0，极活跃）：op log（追加操作日志）+ 冲突记录在 commit 内不阻塞操作 —— 对 agent-cord 的"ledger 冲突不该阻塞工作流"很有启发。

这三个项目的共同信号值得记一笔：**当"纯文件+git"撞上可变结构化数据时，成熟项目的出路都是把数据挪出工作区（git 对象 / refs），或者换成理解结构的后端（Dolt）。** agent-cord 选择把 ledger 从事件派生，本质是第三条路，也成立，但要接受 reducer 常驻。

**git 调用库**：

| 库 | license | 活跃度 | 说明 |
|---|---|---|---|
| [simple-git](https://github.com/steveukx/git-js) 3.36.0 | MIT | 2026-04-12，8.6M 周下载 | 包装系统 git CLI，本地开发工具最省事 |
| [@napi-rs/simple-git](https://github.com/Brooooooklyn/simple-git) 1.2.0 | MIT | 2026-09-21，251k 周下载 | 原生绑定，最快 |
| [isomorphic-git](https://github.com/isomorphic-git/isomorphic-git) 1.42.2 | MIT | 活跃，1.26M 周下载 | 纯 JS，功能是子集；**注意它不支持自定义 merge driver** |
| [dugite](https://github.com/desktop/dugite) 3.2.3 | MIT | 2026-08-11 | GitHub Desktop 打包的 git 二进制，免装 git |
| nodegit 0.27.0 | MIT | **死**（2020-07） | 不要用 |

→ 建议 **simple-git**（或 @napi-rs/simple-git 做性能敏感路径），因为自定义 merge driver 必须由**系统 git** 执行。

---

## 3. 文件型 SSOT / git-based CMS 参考

| 项目 | 仓库 / license | 活跃度 | 与 agent-cord 的关系 |
|---|---|---|---|
| **TinaCMS** | [tinacms/tinacms](https://github.com/tinacms/tinacms) · 13803★ · Apache-2.0 | 极活跃 | **最有参考价值**：Markdown 留在 git 仓库，另建只读 **Data Layer（把仓库索引成查询数据库）** —— 这就是"文件 SSOT + 派生索引"的成熟范例 |
| **Decap CMS** | [decaporg/decap-cms](https://github.com/decaporg/decap-cms) · 19401★ · MIT | 活跃 | 内容即仓库文件、编辑即 commit；只读其取舍 |
| **Keystatic** | [Thinkmill/keystatic](https://github.com/Thinkmill/keystatic) · 2410★ · MIT | 活跃（2026-09-08），@keystatic/core 0.6.9 / 2026-08-26，88k 周下载 | **适配后复用**：TS-first、**无 DB**、Markdown+YAML/JSON，schema 驱动的 collection reader —— 可直接用作知识库层（frontmatter schema + 类型化读取）的参考或零件 |
| **Nuxt Content** | [nuxt/content](https://github.com/nuxt/content) · 3669★ · MIT | 极活跃 | 文件型 CMS + 查询层，借鉴 |
| NocoDB | [nocodb/nocodb](https://github.com/nocodb/nocodb) · 65061★ · **license = Other（NOASSERTION）** | 极活跃 | **不是文件后端**（SQLite/Postgres/MySQL）。UX 参考；非 OSI 标准许可，不建议依赖 |

行业共识也值得记录：多篇 2026 年的对比文章都指出 git-backed 模型在**大体量内容、复杂关系、非技术用户工作流**上会失效（[TinaCMS alternatives](https://unfoldcms.com/blog/tina-cms-alternatives)、[Markdown as CMS 的取舍](https://blog.openreplay.com/markdown-cms-pros-cons/)）。agent-cord 是开发者工具 + 单需求小文件夹，属于该模型的最佳适用区间，但"知识库全量 markdown 进单一 git 仓库"这个假设会随规模退化，建议在设计文档里标注容量假设。

---

## 4. Frontmatter / Markdown 解析

| 库 | license | 活跃度 | 结论 |
|---|---|---|---|
| **gray-matter** [jonschlinkert/gray-matter](https://github.com/jonschlinkert/gray-matter) 4.0.3 | MIT | **冻结**：最后发布 2021-04-24，代码 2021 年后无实质变更（2025-06 只改了 README）；7.08M 周下载 | 能用但是维护风险 |
| **@11ty/gray-matter** 3.0.0 | MIT | **2026-07-29 发布**，429k 周下载，[11ty/gray-matter](https://github.com/11ty/gray-matter) | **推荐替代**：11ty 维护的 fork |
| front-matter [jxson/front-matter](https://github.com/jxson/front-matter) 4.0.2 | MIT | **死**（2020-05-29），2.82M 周下载 | 不要用 |
| remark-frontmatter 5.0.0 / remark-parse·stringify 11.0.0 / unified 11.0.5 / micromark 4.0.2 | MIT | 稳定但节奏慢（remark-frontmatter 最后提交 2023-10） | **只在"读"结构时用**（见下方实测警告） |
| [markdown-it](https://github.com/markdown-it/markdown-it) 15.0.2 | MIT | 极活跃（2026-09-11），20.7M 周下载 | 渲染优先，不做 AST 往返 |

**Markdown 往返实测（重要）**：我用 `remark-parse → remark-stringify` 跑了往返测试。

- 一份"常规"文档（ATX 标题、`**粗体**`、`*` 列表、表格、围栏代码块、YAML frontmatter）→ **字节级完全一致** ✅
- 一份"手写风格"文档 → **被静默改写**：

| 原文 | remark 输出 |
|---|---|
| `Setext Heading\n===` | `# Setext Heading` |
| `1) item` | `1. item` |
| `_emphasis_` | `*emphasis*` |
| `- item` | `* item` |
| `Trailing whitespace line␣␣`（双空格硬换行） | `Trailing whitespace line` ← **硬换行直接丢失** |

→ **建议：永远不要用 remark-stringify 覆盖人工编写的 `cord/<req-id>/*.md`。** 那类文档应当"只读 + 按行区间外科手术式修改"，或者用 `yaml` 的 CST 思路单独处理 frontmatter 区。remark/unified 只用于查询、抽取锚点、生成索引。

---

## 5. YAML 与 Schema 校验

| 库 | 仓库 / license | 活跃度 | 匹配度 |
|---|---|---|---|
| **yaml** (eemeli) 2.9.1 | [eemeli/yaml](https://github.com/eemeli/yaml) · 1691★ · ISC | **极活跃**（2026-09-23 仍有提交），149.5M 周下载 | **直接复用（核心依赖）** |
| **zod** 4.6.5 | [colinhacks/zod](https://github.com/colinhacks/zod) · 44005★ · MIT | 极活跃，211.9M 周下载 | **直接复用** |
| **ajv** 8.20.0 | [ajv-validator/ajv](https://github.com/ajv-validator/ajv) · 14839★ · MIT | 活跃（2026-09-06），287.3M 周下载 | **直接复用** |
| valibot 1.5.0 | [open-circle/valibot](https://github.com/open-circle/valibot) · 9023★ · MIT | 活跃，13.4M 周下载 | 可选（在意体积时替代 zod） |
| **@marCBachmann/cel-js** 8.0.0 | [marcbachmann/cel-js](https://github.com/marcbachmann/cel-js) · 193★ · MIT | 活跃（2026-09-05），286k 周下载 | **直接复用（CEL 唯一选择）** |
| ~~cel-js~~ 0.8.2 | [ChromeGG/cel-js](https://github.com/ChromeGG/cel-js) · 125★ · MIT | ⚠️ **仓库已归档（archived=true）**，78k 周下载 | 不要用，迁移到上面那个 |
| @kubernetes-models/validate 5.0.2 | [tommy351/kubernetes-models-ts](https://github.com/tommy351/kubernetes-models-ts) · MIT | 2026-05-06，105k 周下载 | 借鉴：**按 apiVersion/kind 分派 schema 的 registry 现成实现** |

**实测验证（这几条直接支撑三级校验器设计）：**

1. **`yaml` 保留注释与键序** —— `parseDocument` → `setIn(['entries',0,'status'],'confirmed')` → `toString()`，输出的 YAML **保留了行尾注释 `# decision point`、文件头注释、以及原有键顺序**，同时正确插入了新键。这正是机器改写人工维护的 `ledger.yaml` / workflow YAML 所需要的。`js-yaml` 做不到（不保注释），所以**不要用 js-yaml 做写路径**。
2. **zod 4 自带 `z.toJSONSchema()`** —— 实测输出标准 draft 2020-12 JSON Schema（`{"$schema":"https://json-schema.org/draft/2020-12/schema", "properties":{"apiVersion":{"type":"string","const":"cord/v1"}...}}`）。**一套 zod schema 同时产出运行时校验和对外 JSON Schema**，天然适配"内置枚举 / CEL / 外部 IPC 插件"三级校验器 —— zod 是作者层，JSON Schema 是交换格式，ajv 是第三方 schema 的执行器。
3. **ajv 校验 YAML 派生对象** —— 实测错误路径清晰可用：`/entries/0/status must be equal to one of the allowed values`。这是给 LLM 反馈校验失败原因的良好格式。
4. **CEL**：`@marcbachmann/cel-js` 支持宏、**自定义函数与自定义类型**、optional chaining、Environment 类型检查，且 README 明确写了 "Migrating from cel-js" —— 说明旧包已被官方取代。gate 条件里要注入 `anchors`、`votes` 之类的上下文变量并注册自定义函数，这个包能满足。

**可选表达式引擎**（若不想用 CEL）：jsonata 2.2.2 MIT 活跃（1.26M 周下载，查询/转换强）；json-rules-engine 7.3.1 ISC（252k 周下载，规则+事件模型）；json-logic-js 2.0.5 MIT（1.7M 周下载，纯 JSON 可序列化规则，适合"规则可被 LLM 生成"的场景）。jexl 2.3.0 自 2020 停更，不用。

---

## 6. SQLite FTS5 中文检索（全节为实测结论）

### 6.1 环境事实

- **node:sqlite 内置模块可用**：实测 Node v25.8.0 内置 SQLite **3.51.2**，`CREATE VIRTUAL TABLE ... tokenize='trigram'` 建表成功 → **零依赖可用**（Node ≥22.5 引入，早期为实验 API）。
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) 13.0.3（7495★ MIT，7.36M 周下载）编译时带 FTS5，同步 API，仍是生产首选。
- 备选：@libsql/client 0.18.0 MIT（2.0M 周下载）、node-sqlite3-wasm 0.8.60 MIT（无原生编译）、@sqlite.org/sqlite-wasm Apache-2.0。
- 建表/查询构建：drizzle-orm 0.45.3 Apache-2.0（35.9k★，16.3M 周下载）或 kysely 0.29.6 MIT（12.0M 周下载）—— 可选，不是必需。

### 6.2 分词器实测对比

对文本 `投票执行器要求证据锚点可机验，锚点重合度高则判疑似同源错误。`

| 查询 | `unicode61` | `trigram` |
|---|---|---|
| `证据锚点`（4 字） | ❌ 0 | ✅ 1 |
| `证据锚点可机验`（7 字） | ❌ 0 | ✅ 1 |
| `智能体`（3 字） | ❌ 0 | ✅ 1 |
| **`锚点`（2 字）** | ❌ 0 | ❌ **0** |
| **`证据`（2 字）** | ❌ 0 | ❌ **0** |
| `search` / `full text`（英文） | ✅ | ✅ |

原因：`unicode61` 把连续的汉字序列当成**一个 token**，所以只有前缀匹配（`证据锚点*`）才能命中；`trigram` 按 3 字滑窗建索引，**短于 3 字的查询根本进不了索引**。

其他实测结论：
- `LIKE '%锚点%'` 在 trigram 表上**能返回正确结果**（FTS5 回退到全表线性扫描），20k 行耗时 3ms。可用作短查询兜底，但**是 O(n)、无法用 bm25 排序**。
- **bm25 在 trigram 上无区分度**：同一命中行得分量级为 `-1.07e-6`，bigram 方案下同样只有 `-3e-6`。已有公开 issue 报告 CJK + trigram 场景 "textScore=0，全文检索分量对最终得分毫无贡献"。→ **不要把 bm25 当作中文相关性排序的主力**。

### 6.3 两套实测可用的替代方案（都不需要引入新依赖）

**方案 A：`Intl.Segmenter('zh-CN')` 双向分词 + unicode61 短语查询**
索引侧和查询侧都用同一个分词器切词，再用短语查询匹配。实测 **`证据锚点`、`锚点`、`投票`、`执行器`、`同源错误`、`盲评投票`、`智能体` 全部命中 ✅**。
零依赖（Node 自带 full-icu）。风险：ICU 词典质量一般，会把「锚点」切成「锚 | 点」、「执行器」切成「执行 | 器」——只要**两侧用同一分词器**，精确匹配仍然正确，但跨版本 ICU 升级可能改变分词结果，导致索引/查询不一致（需要重建索引）。

**方案 B：应用侧 unigram + bigram 预分词 + unicode61 FTS5**
把 `证据锚点` 写成 `证据 据锚 锚点` 存索引，查询侧同样展开成 `证据 AND 据锚 AND 锚点`。实测 **`锚点`、`错`（单字！）、`投票`、`同源错误`、`盲评投票`、`智能体` 全部命中 ✅**。
完全确定、无词典依赖、支持 1–2 字查询。代价是索引体积约翻倍。

**若要真词级分词（可选）**：[@node-rs/jieba](https://github.com/napi-rs/node-rs) 2.0.3 MIT（2026-09-10，257k 周下载，Rust/jieba-rs 绑定，最快，但需原生编译）；nodejieba 3.5.8 MIT（3235★，2026-03-23，但需编译）；jieba-wasm 2.4.0 MIT（无编译）；segmentit 2.0.3 **已停滞**（2019）。

**不想依赖 SQLite 的话**：[MiniSearch](https://github.com/lucaong/minisearch) 7.2.0 MIT（2.03M 周下载，**支持自定义 tokenizer，可挂中文分词器**，纯 JS，是 FTS5 之外最合适的替代）；FlexSearch 0.8.212 Apache-2.0（904k 周下载）；@orama/orama 3.1.18 Apache-2.0（825k 周下载）；lunr 自 2020 停更，不用。
（sqlite-vec 8133★ Apache-2.0 —— 将来上向量检索时再用，本期不需要。）

---

## 7. 并发与文件写入

**实测：8 个进程各自 `appendFileSync` 1500 行到同一文件**（每行是完整 JSON），行大小分别为 ~200B / ~2000B / 8KB / 64KB：

| 行大小 | 期望行数 | 实际行数 | 可解析 | 损坏 |
|---|---|---|---|---|
| ~200B | 12000 | 12000 | 12000 | 0 |
| ~2000B | 12000 | 12000 | 12000 | 0 |
| ~8KB | 3200 | 3200 | 3200 | 0 |
| ~64KB | 3200 | 3200 | 3200 | 0 |

→ 在本地文件系统（APFS）上，单行 JSONL 追加**没有观察到交错或丢失**。agent-cord 有常驻 daemon 作为**单写者**，这个结论足够支撑"不需要 lockfile"的设计（跨网络盘不在保证范围内）。

相关工具：
- [write-file-atomic](https://github.com/npm/write-file-atomic) 8.0.0 ISC（76.3M 周下载）—— 整文件原子替换，适合写 `ledger.yaml`
- [chokidar](https://github.com/paulmillr/chokidar) 5.0.0 MIT（160.9M 周下载）—— 派生索引的文件监听
- [async-mutex](https://github.com/DirtyHairy/async-mutex) 0.5.0 MIT（8.8M 周下载）—— 进程内串行化
- [proper-lockfile](https://github.com/moxystudio/node-proper-lockfile) 4.1.2 —— **2021 年 1 月后未更新**，如需要锁请参考 @alcalzone/jsonl-db 的做法或直接用 flock
- matcher：picomatch 4.0.7 MIT（361M 周下载）；**注意 minimatch 10.x 的 license 是 BlueOak-1.0.0**（非 MIT/Apache），若在意许可纯洁性用 picomatch

**相似度（锚点 Jaccard）**：**没有值得依赖的现成包**（`string-similarity` 2021 停更、`dice-coefficient` 用途不符、`minhash` 2018 停更）。Jaccard 本身约 20 行 → **自研**。若需辅助，[natural](https://github.com/NaturalNode/natural) 8.1.1 MIT（912k 周下载，2026-02-27）含 TF-IDF/相似度工具集；fastest-levenshtein 1.0.16 MIT（18.8M 周下载，编辑距离）。

---

## 8. 主题外但高度相关的同类项目（值得立刻看）

| 项目 | 仓库 / license | 为什么重要 |
|---|---|---|
| **OpenSpec** | [Fission-AI/OpenSpec](https://github.com/Fission-AI/OpenSpec) · **70182★ · MIT** · 极活跃 · npm `@fission-ai/openspec` 1.13.2 / 2026-09-23 | **与 agent-cord 的文件夹 SSOT 几乎同构**：`openspec/changes/<change-id>/` 下放 `proposal.md` + `specs/` + `design.md` + `tasks.md`，完成后 archive；需求用 ADDED/MODIFIED/REMOVED 增量表达。这是**验证 `cord/<req-id>/` 布局已被大规模采用**的最强证据，MIT 许可下目录约定/CLI 交互模式可部分复用。它**没有** ledger、events.jsonl、投票、gate |
| **spec-kitty** | [spec-kitty/spec-kitty](https://github.com/spec-kitty/spec-kitty) · 1641★ · MIT · 极活跃 | 有 `status.events.jsonl` 追加事件日志、`.gitattributes` merge driver 注册、git worktree 并行、审计追踪。**issue #569 就是 agent-cord merge driver 的现成规格书** |
| **beads** | [gastownhall/beads](https://github.com/gastownhall/beads) · **27397★ · MIT** · 极活跃 | 本地优先 issue tracker，"SQLite 本地存储 + JSONL 导出进 git"，是"派生索引 + 可合并文本导出"的工业级范例。**它的 JSONL→Dolt 迁移是最有价值的负面案例**（见 §0①） |
| **github/spec-kit** | [github/spec-kit](https://github.com/github/spec-kit) · 138721★ · MIT | spec-driven development 的主流实现，可对比其 SSOT 文件约定 |
| **BMAD-METHOD** | [bmad-code-org/BMAD-METHOD](https://github.com/bmad-code-org/BMAD-METHOD) · 53419★ · 自定义许可 | 多 agent 敏捷工作流方法论；**license 非标准（NOASSERTION）**，只能借鉴方法论 |

---

## 9. 造轮子 vs 复用：明确建议

### 必须自研（没有现成实现，或语义是 agent-cord 独有的）

| # | 组件 | 理由 |
|---|---|---|
| 1 | **JSONL 事件日志存储层** | 无 TS 库提供"git 可见的 JSONL 事件存储"。Emmett/Castore 全是 DB 后端；@alcalzone/jsonl-db 是 KV 且有 compaction（会重写文件，破坏 git 历史与审计） |
| 2 | **JSONL union merge driver** | npm/JSR 上零可用实现（§2）。约 100 行：按 `event_id` 去重 + 按逻辑时间排序 + 覆写 `%A` |
| 3 | **merge driver 的安装与自检** | `.git/config` 不随仓库分发；必须有 `cord init` 注册 + `cord doctor` 检测"当前 clone 是否已挂上 driver" |
| 4 | **events.jsonl → ledger.yaml 的 reducer / 物化器** | 幂等、可重放、校验和、schema 版本迁移。这是 §0① 的根本解法，且没有任何库提供 |
| 5 | **YAML `apiVersion` 化的 schema registry + gate 语义 + 三级校验器编排** | zod/ajv/CEL 是零件，"哪一级校验什么、错误如何归一化、gate 放行条件如何求值"必须自研（可参考 @kubernetes-models/validate 的 registry 设计） |
| 6 | **证据锚点模型**（锚点语法、解析、Jaccard 相似度、可机验） | 生态里没有对应概念；Jaccard 自研约 20 行 |
| 7 | **中文检索策略层** | 分词/短查询回退/排序融合是策略，不是库。零件（FTS5、jieba、Intl.Segmenter）现成 |
| 8 | **派生索引一致性协议** | 增量更新、失效、`cord index --reindex`、与 git checkout/merge 的联动 |

### 直接复用（用现成的，不要自己写）

- **`yaml`（eemeli/yaml）** —— YAML 读写 + **注释/键序保留**（实测通过）。这是 ledger/workflow 机器改写的唯一正确选择。
- **`zod` + `z.toJSONSchema()`** —— 单一 schema 来源同时产出运行时校验与 JSON Schema。
- **`ajv` (+ ajv-formats)** —— JSON Schema 执行器与错误路径（外部插件互操作格式）。
- **`@marcbachmann/cel-js`** —— CEL 表达式（旧 `cel-js` 仓库已归档）。
- **`@11ty/gray-matter`** —— frontmatter 解析（不要用自 2021 冻结的 gray-matter）。
- **`better-sqlite3`** 或 **`node:sqlite`** —— SQLite/FTS5。
- **`simple-git`** 或 **`@napi-rs/simple-git`** —— git 调用（必须走系统 git 才能执行自定义 merge driver）。
- **`chokidar`** —— 文件监听；**`write-file-atomic`** —— 整文件原子写。
- **`@node-rs/jieba`**（要真词级）**或 `Intl.Segmenter`/bigram**（要零依赖）—— 中文分词。
- **`MiniSearch`** —— 若不想引入 SQLite。

### 适配后复用

- **@alcalzone/jsonl-db 的 lockfile + 原子追加实现思路**（复用它做本地状态/缓存的并发保护；不要用它承载 events.jsonl）
- **Keystatic 的 schema → 类型化读取**（知识库层的 frontmatter schema 与 reader）
- **LiveStore 的 eventlog → materializer → SQLite + 事件 schema 版本迁移**架构（最贴合 agent-cord 的"事件 SSOT + 派生索引"，但它的日志在 SQLite 里，需把存储层替换成 JSONL+git）
- **spec-kitty issue #569 的 merge driver 规格**（照抄设计）
- **@kubernetes-models/validate 的 apiVersion/kind registry**

### 只能借鉴思路 / 不匹配

- **Emmett**（无 license，未来 AGPL/SSPL → **代码不可复用**，只可 clean-room 借鉴 API 形状）
- **Castore**（停滞）、**@ocoda/event-sourcing**、**@nestjs/cqrs**（框架绑定）
- **TinaCMS Data Layer / Decap / Nuxt Content / NocoDB**（CMS/DB 场景，非文件后端）
- **git-bug / git-appraise / jj**（把数据放 git 对象或 refs 的另一条路）
- **hypercore / @peerbit/log**（分布式 p2p 日志，与 git 单主模型不符）
- **KurrentDB / EventStoreDB / Dolt**（需外部服务或放弃"纯文件"约束；Dolt 仅作为 ledger 冲突失控时的换底座退路）

---

## 10. 复用优先级清单

**P0 —— 立刻落地，直接决定核心机制能否成立**

1. **`yaml` (eemeli/yaml)** —— ledger.yaml / workflow YAML 的读写，注释与键序保留（已实测）。*替代方案：无。*
2. **`zod` 4 + `z.toJSONSchema()`** —— 所有 schema 的单一来源。*替代：valibot（在意体积）。*
3. **`ajv`** —— JSON Schema 执行器，用于外部 IPC 插件校验与错误归一化。
4. **`@marcbachmann/cel-js`** —— CEL 二级校验器。*替代：json-logic-js（若规则需由 LLM 生成）。*
5. **`simple-git`**（或 @napi-rs/simple-git）+ **系统 git** —— 一切 git 操作，含自定义 merge driver。
6. **自研：JSONL merge driver**（`event_id` 去重 + 逻辑时钟排序 + 覆写 `%A`）**+ `cord init`/`cord doctor` 安装自检**。规格照抄 spec-kitty #569。
7. **自研：events → ledger reducer**，并**在 `.gitattributes` 中显式排除 `ledger.yaml` 走 union**（§0①）。

**P1 —— 紧随其后，影响可检索性与知识库体验**

8. **`better-sqlite3`** 或 **`node:sqlite`**（已实测可用）—— SQLite 底座。
9. **中文检索策略层（自研）+ 分词零件**：trigram 主索引 + **bigram 预分词或 Intl.Segmenter 短语匹配**解决 2 字查询；**不要依赖 bm25 做中文排序**（§6）。
10. **`@11ty/gray-matter`** —— frontmatter 解析（**不要用**自 2021 冻结的 gray-matter，也不要用 2020 年停更的 front-matter）。
11. **自研：证据锚点模型 + Jaccard**（无可用现成包）。
12. **`chokidar`** + **`write-file-atomic`** + **`async-mutex`** —— 索引失效与原子写。
13. **`remark-parse`/`unified`（只读！）** —— 抽取结构、生成锚点；**禁止 remark-stringify 覆盖人工文档**（§4 实测会丢硬换行）。

**P2 —— 规模上来或需要交互界面时再上**

14. **drizzle-orm** 或 **kysely** —— 建表与迁移。
15. **@node-rs/jieba** —— 若 ICU 分词质量不达标，换真词级分词。
16. **MiniSearch / FlexSearch / Orama** —— 若想彻底摆脱 SQLite。
17. **Keystatic reader** —— 知识库的类型化读取。
18. **sqlite-vec** —— 将来上向量检索。

**明确排除**：Emmett（无 license）、gray-matter 4.0.3 主仓（冻结）、js-yaml 写路径（不保注释）、nodegit（2020 死亡）、`cel-js`（仓库已归档）、NocoDB（非文件后端 + 非标准许可）、minimatch（BlueOak 许可，用 picomatch 替代）。

---

## 附：我的验证方式

所有"实测"结论可在本地复现，脚本留在 `/tmp`（`ftstest.mjs`、`ftstest2.mjs`、`seg2.mjs`、`cordtest/t.mjs`、`cordtest/md2.mjs`、`gittest2/`、`appendtest/`）。环境为 Node v25.8.0 / SQLite 3.51.2 / git 2.50.x / macOS APFS。star 数与 license 通过 `gh api repos/<owner>/<repo>` 拉取，npm 元数据通过 registry.npmjs.org 与 api.npmjs.org/downloads 拉取，均为调研当日（2026-09-24）数据。SQLite trigram 与 git 合并驱动的行为结论分别对照 [SQLite FTS5 官方文档](https://sqlite.org/fts5.html#the_trigram_tokenizer) 和 [gitattributes 官方文档](https://git-scm.com/docs/gitattributes#_built_in_merge_drivers) 交叉验证。

**未覆盖/留给后续**：投票执行器的结构化输出库（instructor-js、Vercel AI SDK 等）和 AgentDriver 的 headless CLI 适配不在本次主题范围内，我没有深入查证；IM 适配器同理。另外 `events.jsonl` 里事件 schema 演进策略（LiveStore 的 event schema versioning 值得细看）我只做了架构层面的提示，没有做实现级调研，如果决定自研 reducer，这一块值得单独一轮。
