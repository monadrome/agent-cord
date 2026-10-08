# ADR 目录 ｜ 决策记录总览

> 状态：设计决策已落档；M2 最小闭环 + 控制台 MVP 已实现（2026-09-25）；独立 Context Session Agent 原型已实现（2026-10-07）｜ 更新日期：2026-10-08
> 读者：第一次接触本项目的外部开发者、后续接手的设计者与贡献者
>
> **本章回答什么问题**：agent-cord 已经拍板了哪些决策？每条决策的备选方案、理由与证据在哪？技术选型的置信度如何？新增决策该走什么流程？

---

## 1. 一句话说明

agent-cord 的设计决策分为四类，共 46 条，一条决策一个文件：

- **8 条设计决策（ADR-0001 ~ ADR-0008）**：定义「这个平台是什么、边界在哪、机制怎么组织」——定位、流程严格度、共识载体、路由拓扑、账本形态、投票机制、模型分配、原型切分。
- **8 条技术决策（ADR-0009 ~ ADR-0016）**：定义「这个平台用什么造」——语言与运行形态、SSOT 存储、agent 运行时、事件与 IM 适配、投票执行器、工作流定义语言、知识库、分发与插件。
- **30 条实现选型决策（ADR-0017 ~ ADR-0046）**：在技术决策框架内，依据开源实现调研与对抗性设计评审把具体实现选型拍板——agent 驱动协议（ACP 直连）、工作流 DSL 与编排内核、插件协议（MCP over stdio）、事件协议与确定性 reducer、控制台 server 分层、SDLC 生命周期、协调 session agent 与节点执行体、checker 参数化、run 取消与节点执行体可靠性、上下文快照 provenance 与 artifact 路径边界、工作区 agent registry 与重载、协调快照一致性与失败恢复、最新门禁与产物证据、恢复校验与版本化审批、Agent 配置身份与控制台工作台、独立 Context Session Agent、提议受控采用与协调工作台、SDLC 执行版本隔离与启动绑定事实、REST 请求身份与幂等生命周期、共享文档访问边界、Codex 非终态通知与回执、只读 worker 文本产物通道、Codex 文件变更工具事件、带输入指纹的机器验证事实、声明的源码验证范围、只读 worker 源码新鲜度、协调提议源码新鲜度、结构化机器验证上下文、验证证据一致性、独立协调文档覆盖。

设计决策先于技术决策成立：技术选型都是设计约束的推论，而不是流行度比较的结果。每份 ADR 的「理由」一节都给出从痛点出发的第一性原理推导链。

---

## 2. 决策点地图（技术决策 8 项 + 实现选型 30 项）

| # | 决策点 | 选型 | 一句话理由 | ADR | 置信度 |
|---|---|---|---|---|---|
| 1 | 语言与运行形态 | TypeScript + 常驻 daemon 核心 + 薄 CLI（本地 IPC/HTTP），核心同时以库导出 | 被驱动 CLI 与 IM SDK 的生态主场在 TS；协议即 schema（Zod）让演进一致性由编译器保证；daemon 承载 webhook/watcher，CLI 是 dogfooding 与开源传播的双重入口 | [ADR-0009](./ADR-0009-language-runtime.md) | 中高 |
| 2 | SSOT 存储与版本化 | 纯文件 + git + 文件夹内 JSONL 事件流 + `ledger.yaml`；frontmatter 仅显示层；SQLite 派生索引后置 | 「合入永远人工」要求每次状态变化都能以文本 diff 呈现，排除二进制与服务端；机判逻辑需要结构化层，最便宜的可评审形态就是 JSONL/YAML | [ADR-0010](./ADR-0010-ssot-storage.md) | 中高 |
| 3 | agent 运行时 | 每任务 subprocess 驱动 headless CLI，统一 `AgentDriver` 接口 | 进程边界是最便宜也最硬的隔离原语，直接兑现盲评独立性；SDK 内嵌等于重新绑定厂商，且并不真的摆脱 subprocess | [ADR-0011](./ADR-0011-agent-runtime.md) | 中高 |
| 4 | 事件与通信 + IM 适配 | 文件夹内 append-only 事件流（`events.jsonl`，唯一事实与顺序来源）+ 进程内 dispatcher 分发 + watcher 仅对账探针 + webhook 仅公网 ingress 前端；IM 用官方 SDK 薄适配器 | 事件必须同时满足落盘、单调序、与 git 同构三条，唯一同时满足的载体是文件夹内追加的事件流；单机器人路由的交互需要各家最强能力而非最小公分母 | [ADR-0012](./ADR-0012-events-im-adapters.md) | 中高 |
| 5 | 投票执行器 | `ProviderAdapter` 直连模型 API；生成侧角色 agent 才走 CLI；LiteLLM 仅可选加速件 | 投票是 k 次受控、可复现、可审计的判定调用，它需要的控制面（temperature=0、版本锁、结构化输出、逐次 usage）只有直连 API 给得全 | [ADR-0013](./ADR-0013-vote-executor.md) | 中高 |
| 6 | 工作流与门禁定义语言 | `apiVersion` 化 YAML + 三级校验器（内置枚举 / CEL 表达式 / 外部 IPC 插件）；gate 与 checker 双注册表 | 流程拓扑低频且需人审，校验逻辑高频且多变；两者分文件分注册表，才能让「新增 gate 零代码」在操作闭包上成立 | [ADR-0014](./ADR-0014-workflow-gate-dsl.md) | 高 |
| 7 | 知识库存储与检索 | Markdown + frontmatter 为唯一 SSOT + SQLite FTS5 派生索引（中文 unigram/bigram 预分词，实测校准）；起步符号/词法，embedding 后置可插拔 | 知识条目注入上下文即获得权威，「为什么注入这条」必须可解释，审计性优先于召回率；条目只经门禁写入，索引保鲜从工程难题降为一条钩子 | [ADR-0015](./ADR-0015-knowledge-base.md) | 高（存储与检索）／中（生命周期与复述检验） |
| 8 | 分发与插件机制 | npm CLI 分发；三层插件（纯配置组合 / 声明式 markdown / IPC 进程插件），协议 v1 冻结；官方插件集 + GitHub 模板市场冷启动 | 平台计算全部外置在子进程，宿主选型是生态对齐问题而非性能问题；插件的真实需求面里没有一项需要 in-process，进程隔离全是收益 | [ADR-0016](./ADR-0016-distribution-plugins.md) | 高（分发与装载）／中（冷启动策略） |
| 9 | agent 驱动协议 | ACP（Agent Client Protocol）直连为 `AgentDriver` 第一实现；裸 headless 降级、PTY 兜底；不复用 `@ai-sdk/harness` | 协议 v1 稳定、registry 覆盖 41 个 agent；`session/request_permission` 与 `session/load` 天然对应门禁人工放行与会话恢复 | [ADR-0017](./ADR-0017-agent-driver-acp.md) | 中高 |
| 10 | 工作流 DSL 与编排内核实现 | 自研 apiVersion YAML（借 OWS 事件词表与 `use` 容器结构）+ `@marcbachmann/cel-js` 端口隔离 + 自研薄执行器 + XState v5 | 所有成熟引擎状态归引擎、与文件 SSOT 冲突；CEL 无官方 JS 实现，必须端口隔离 + 官方一致性测试数据回归 | [ADR-0018](./ADR-0018-workflow-dsl-kernel-impl.md) | 中 |
| 11 | 外部校验器插件协议 | MCP over stdio（`check` / `capabilities` / `health` 映射 MCP 原生语义），不自造线协议 | 白拿 MCP 生态与标准握手；与 ACP 同属 JSON-RPC 族，平台协议数量减一 | [ADR-0019](./ADR-0019-plugin-protocol-mcp.md) | 中高 |
| 12 | 事件协议与确定性 reducer | EventEnvelope v1（ULID + 血统内 seq + prev_event_hash 因果链）+ 单写者原子追加 + reducer 带版本与输入/输出校验和 + 并发冲突转人工 | 「能演示」与「杀进程/合并后可证明正确」的差距全在协议层；全局连续 seq 与分支合并数学上不兼容 | [ADR-0020](./ADR-0020-event-protocol-reducer.md) | 中高 |
| 13 | 控制台与 server 分层 | Fastify REST 命令 + SSE 只读推送 + node:sqlite 派生索引（只存幂等键与运行登记）+ 人工 gate 经挂起 promise 桥接 REST | 凡能从事件流派生的就不允许有第二份持久化副本；幂等键不落盘则重启后无法兑现「同键不重复入账」 | [ADR-0021](./ADR-0021-console-server-layering.md) | 中高 |
| 14 | SDLC 定制模型与版本生命周期 | SDLC = 现有 WorkflowDef 的文件化封装（draft → validated → published → archived），发布版本不可原地修改，run 绑定具体版本 | 双 schema 必然漂移；SDLC 是低频人审资产，文件 + git 是最便宜的可评审形态 | [ADR-0022](./ADR-0022-sdlc-lifecycle.md) | 中高 |
| 15 | 协调 session agent 与节点执行体 | node.run 声明执行体 + NodeRunner 端口（Coordinator 为生产实现：快照剪裁 → 驱动调度 → agent.task 事件落盘 → artifact 双通道写回）+ agents.yaml 自定义 agent 注册 | 编排正确性（执行器）与协调智能（上下文剪裁/调度）是两个变化轴；恢复语义唯一要求执行必须在节点生命周期内完成 | [ADR-0023](./ADR-0023-coordinator-node-run.md) | 中高 |
| 16 | checker 参数化 | checks[].with 传入 CheckerContext.params + 参数化内置 checker 家族（file-exists/file-nonempty/doc-has-section/anchors-min-count/event-emitted）；参数非法 fail-closed | L1 档从「枚举具体判定」升级为「枚举判定种类」；CEL/插件路线不变 | [ADR-0024](./ADR-0024-checker-params.md) | 中高 |
| 17 | run 取消与节点执行体可靠性 | `workflow.run.cancelled` 事件（先落事实再控制）+ AbortSignal 贯穿执行器/协调 agent/driver + `node.run.retry`（max_attempts/backoff_ms，重试上下文附上次失败摘要） | 取消是事实不是控制消息——不落事件则重启后 run 永远是 running；重试带退避与失败回灌是智能层的变化轴，不属薄执行器 | [ADR-0025](./ADR-0025-run-cancel-retry.md) | 中高 |
| 18 | 上下文快照 provenance 与 artifact 边界 | 动态采集 workflow 声明的 artifact + snapshot_id / event chain provenance + session 目录内路径校验 | 自定义 SDLC 必须把声明的产物带入上下文；输入版本要可审计；workflow 写回不能越出需求目录 | [ADR-0026](./ADR-0026-snapshot-provenance-artifact-boundary.md) | 中高 |
| 19 | 工作区 agent 配置与重载 | 独立 resolver + 公开清单 + 显式串行重载 + run 固定配置 | agent 参数属于工作区，不能通过全局可变表互相覆盖；重载只能改变后续 run | [ADR-0027](./ADR-0027-workspace-agent-registry.md) | 中高 |
| 20 | 协调快照一致性与失败恢复 | 同次事件投影 + workflow 隔离 + 文档文件边界 + failure_stage/retryable | 不能从滞后的账本和其他流程构建当前上下文；准备与写回故障必须落终态，存储故障不能伪造持久化 | [ADR-0028](./ADR-0028-coordinator-snapshot-failures.md) | 中高 |
| 21 | 最新账本门禁与当前产物证据 | 最新事件投影排除冲突 + artifact 前后 hash + 乐观写回检查 + 辅助输出不参与产物 | 旧共识与旧文件不能冒充当前放行证据；空结果和协议日志不是产物 | [ADR-0029](./ADR-0029-gate-artifact-evidence.md) | 中高 |
| 22 | 恢复输入校验与版本化审批 | execution_input_hash + completion 复用校验 + gate evaluation_hash + waiting ULID 版本 | 成功任务必须仍匹配当前输入，人工选择只能批准该次证据状态 | [ADR-0030](./ADR-0030-checkpoint-approval-freshness.md) | 中高 |
| 23 | Agent 配置身份与控制台 | 有效启动 configuration_hash + run 固定身份 + 公开 Agent 清单/诊断与重载页 | agent 别名不证明角色和模型相同，恢复必须包含实际执行定义；console 只展示宿主投影 | [ADR-0031](./ADR-0031-agent-configuration-identity.md) | 中高 |
| 24 | 独立 Context Session Agent | 新会话最新快照 + 严格 JSON Draft 提议 + 来源/依赖校验 + 在途新鲜度重检 + 轮次事件与 REST | 协调智能可以提出下一步，但推进与审批权必须留在确定性执行器和人手里 | [ADR-0032](./ADR-0032-context-session-agent.md) | 中高 |
| 25 | 提议受控采用与协调工作台 | server 新鲜度 + 运行槽位内重检 + adopted 事实 + 恢复绑定校验 + console 协调视图 | 查询有效不代表写入有效，人工采用不能形成绕过事实与 gate 的第二条执行路径 | [ADR-0033](./ADR-0033-coordination-adoption-console.md) | 中高 |
| 26 | SDLC 执行版本隔离 | workflow_revision + 统一作用域匹配 + started 发布绑定事实 + 索引重建 | 同名不同发布版本不能共享退出/审批事实，版本归属不能只保存在派生索引 | [ADR-0034](./ADR-0034-workflow-execution-revisions.md) | 中高 |
| 27 | REST 幂等生命周期 | 请求输入 hash + 共享 owner + 业务前持久 pending + 成功缓存 + 未确认阻断 | 同键必须证明同请求，崩溃后的未知结果不能当作未执行而盲目重放 | [ADR-0035](./ADR-0035-rest-idempotent-operations.md) | 中高 |
| 28 | 共享文档访问边界 | core 文档 helper + no-follow/普通文件 + 原子写 + REST 错误分类 | 文件证据与需求快照必须接受相同材料，读故障不能冒充未生成 | [ADR-0036](./ADR-0036-shared-document-boundary.md) | 中高 |
| 29 | Codex 非终态通知与回执 | 结构化通知 metadata + 流级 session ID + 当前审批配置 | 非终态通知不能成为产物，终态未重复 ID 不代表没有会话身份 | [ADR-0037](./ADR-0037-codex-runtime-notifications.md) | 中高 |
| 30 | 只读 worker 报告 | output=text + 宿主原子代写 + 报告后态恢复校验 | 保存报告不需要扩大 worker 权限，自己的输出不能使 checkpoint 自失效 | [ADR-0038](./ADR-0038-readonly-report-artifacts.md) | 中高 |
| 31 | Codex 文件变更工具事件 | file_change 保持 tool_use + changes/status 原文 | 文件操作通知不是最终报告，工具结果不能替代产物证据 | [ADR-0039](./ADR-0039-codex-file-change-events.md) | 中高 |
| 32 | 机器验证证据 | `verification.completed` + 当前 `input_hash` + `verification-passed` checker + 幂等 REST | 机器结果必须绑定执行输入，报告文本和旧成功事件不能替代当前验证 | [ADR-0040](./ADR-0040-machine-verification-evidence.md) | 中高 |
| 33 | 验证源码输入 | 显式 inputs + 文件清单/内容 hash + gate/审批共享输入身份 | 未提交代码和目录增删必须使旧测试结果失效 | [ADR-0041](./ADR-0041-verification-source-inputs.md) | 中高 |
| 34 | 只读 worker 源码新鲜度 | 宿主摘要钩子 + v3 执行身份 + 任务 source_hash + 写回前重检 | 旧代码的报告不能在恢复时冒充当前评审 | [ADR-0042](./ADR-0042-readonly-worker-source-freshness.md) | 中高 |
| 35 | 协调提议源码新鲜度 | 流程声明范围并集 + 协调 input v2 + 完成/查询/采用重检 | 代码变更后旧提议不能继续可采用 | [ADR-0043](./ADR-0043-coordination-source-freshness.md) | 中高 |
| 36 | 协调机器验证上下文 | 受限当前观察 + input v3 + 结果事件引用 + 完成/采用重检 | 模型应区分未验证与当前失败，日志不作为事实注入 | [ADR-0044](./ADR-0044-coordination-verification-context.md) | 中高 |
| 37 | 验证证据一致性 | 共享结果契约 + 严格事件读取 + 最新结果校验 + 取消失效 | 门禁与协调观察必须接受相同材料，坏的最新事实不能回退旧通过 | [ADR-0045](./ADR-0045-verification-evidence-consistency.md) | 中高 |
| 38 | 独立协调文档覆盖 | 首尾采集 + 均衡预算 + 字符范围/省略索引 + input v4 | 完整 hash 不代表模型看到末尾变更，后续报告不应被长前缀挤掉 | [ADR-0046](./ADR-0046-coordination-context-coverage.md) | 中高 |

**置信度的含义**：高 = 有多条独立一手来源互证，方向性风险低；中高 = 推导链完整且有一手来源，个别参数需试点校准；中 = 方向由推理得出，无同构先例或需实验数据确认。所有 8 项决策的共同前提是：本平台的负载是 I/O 编排而非高并发服务，token 成本是噪声级（约占人力基线 2% 以内；换算口径：按配套调研（2026-09）Q8 的成本模型，把每需求的 token 费用按当时费率折算为等效人力分钟数，再除以人力基线），真正的成本是固定建设成本与人工介入时间——技术选型一律按这个前提取舍。

---

## 3. 设计决策一览（ADR-0001 ~ ADR-0008）

| ADR | 决策 | 一句话理由 |
|---|---|---|
| [ADR-0001](./ADR-0001-positioning.md) | 定位 = 人机协作效率放大器，不做激进全自动 | 验证环节已高度自动化而共识环节没有；需求天然模糊，自动化程度越高错误被放大得越大。人只做四件事：兜底、补充事实与上下文、决策、纠偏 |
| [ADR-0002](./ADR-0002-lightweight-default.md) | 默认轻量通道 + 触发式升级 | 重型流程平台的典型死法是「默认重型、用户可以逃」；AI 已解决大部分编码效率，新流程若只带来限制，用户会退回手动模式。升级由系统提议、人一键确认；降级不需要理由 |
| [ADR-0003](./ADR-0003-consensus-carrier.md) | 共识载体 = 结构化快照 + 事件流，群聊只是交互捕获层 | 群聊非结构化、易失、有噪声，把群聊当档案等于延续「变更散落群聊无统一载体」的现状；协调 agent 只持最新快照以防幻觉，历史留在永不清理的事件流 |
| [ADR-0004](./ADR-0004-single-bot-routing.md) | 单机器人路由：角色 agent 做后端 worker | 每角色一个机器人前期繁琐、维护成本高；人的认知负担收敛为一；且与「agent 不直接互聊、统一经结构化状态中介」的业界收敛方向一致 |
| [ADR-0005](./ADR-0005-ledger-over-spec.md) | 共识账本 = 证据条目集合，不做统一 Spec | 统一 Spec 会制造「六份材料变七份」的同步负担；账本只覆盖被变更触碰的切片、不声称自己是事实来源（证据才是），且有明确的失效机制 |
| [ADR-0006](./ADR-0006-blind-voting.md) | 独立盲评投票，不辩论 | 系统 benchmark 表明辩论不能稳定跑赢盲评投票且对超参敏感；理论上辩论不改善期望正确率（信念轨迹为鞅）；辩论成本显著更高 |
| [ADR-0007](./ADR-0007-asymmetric-model-allocation.md) | 非对称模型分配：生成弱、判定强；判定与生成必异构 | 弱模型跑不通的根因是认知超载、不知道自己不知道、犯错后无法自愈——三者都可被结构兜住；LLM 评委系统性偏爱自己模型的输出，因此判定侧必须异构 |
| [ADR-0008](./ADR-0008-prototype-split.md) | 原型两分：开源基座 + 内部 SDLC 示例实现 | 开源基座保证通用能力与社区可复用；示例实现提供真实场景验证与可参考的接入样例，其他团队参考或热插拔自己的工作流 |

---

## 4. 建议阅读顺序

1. 想快速理解「这是什么、为什么这么做」：ADR-0001 → ADR-0003 → ADR-0005；
2. 想动手接入或扩展：ADR-0014（gate 怎么定义）→ ADR-0011（agent 怎么跑）→ ADR-0016（插件怎么装）；
3. 想核对证据与文献：ADR-0006（投票）、ADR-0007（模型分配）、ADR-0010（存储）、ADR-0015（知识库）的证据来源最厚；
4. 想评估风险与未定项：每条 ADR 的「关键实现注意点」一节列出了参数初值与待校准项。

---

## 5. ADR 读写约定

### 5.1 文件与编号

- 文件名：`ADR-XXXX-kebab-case-title.md`，编号四位数字、从 `0001` 递增、**永不复用**（被否决的决策也占编号，避免引用歧义）。
- 每份 ADR 固定七节：`背景` / `备选方案` / `决策` / `理由（第一性原理推导）` / `被否方案的否决理由（逐一）` / `关键实现注意点` / `证据来源`。
- 头部固定四行：`状态` / `日期` / `关联` / `来源`（`关联` 列出相关 ADR，`来源` 标注决策所依据的调研与提案章节）。日期取**决策日**（人工拍板日），不是最后修改日。
- 时长上限 200 行。超限说明应拆分为新 ADR 或在正文外引用设计文档，不允许 ADR 变成散文。

### 5.2 状态枚举

| 状态 | 含义 | 本目录现状 |
|---|---|---|
| `proposed` | 已提出、待人工拍板。允许出现在草稿分支，不进入主干 | 无 |
| `accepted` | 已拍板，作为实现的约束 | **ADR-0001 ~ ADR-0044 全部为此状态** |
| `rejected` | 明确否决。文件保留，正文写明否决理由，供后人避免重复提议 | 无（被否的**备选方案**写在对应 ADR 内，不单独占 ADR 编号） |
| `superseded` | 已被后续 ADR 取代。文件保留全文，不再作为实现依据 | 无 |

**所有 ADR 的 `accepted` 都不表示功能已实现**：本项目当前状态是设计定稿 + M2 最小闭环已实现（2026-09-24），其余部分未实现。任何 ADR 若与实现现状不符，以 ADR 为准，实现按 ADR 补齐。

口径澄清：本目录的 `accepted` 一律指**设计定稿**（M2 范围已实现，其余未实现）；各 ADR 绑定的确认点（CP-xx）的拍板状态与归属里程碑，以 [docs/11-risks.md §3](../11-risks.md) 为准，本目录不重复维护。

### 5.3 superseded 规则

1. **不删、不重写历史**。推翻一条已接受的决策时，新建 ADR（新编号），写明新决策、推翻理由与迁移影响；
2. 在原 ADR 头部追加一行 `- 被取代：ADR-XXXX`，并把状态改为 `superseded`；原文其余内容一字不改；
3. 更新本 README 的两张表，把链接指向新 ADR，并注明取代关系；
4. superseded 链条必须保持单向可追溯：`ADR-A → ADR-B → ADR-C`，禁止环形取代；
5. 与共识账本的对应关系：账本条目的状态机是「临时（provisional）→ confirmed → overturned（单向）」，ADR 的 superseded 是同一原则在**设计决策层**的落实——两者都不允许「静默回退去迁就现状」。

### 5.4 修改已接受 ADR 的边界

- **允许**：修正错别字、补充证据来源 URL、在「关键实现注意点」补记试点校准后的参数取值（需注明日期与依据）。
- **不允许**：修改「决策」与「理由」两节的实质内容。任何实质变化都必须走新建 ADR + superseded 流程。

---

## 6. 与术语表的关系

本目录所有文档统一使用方案术语表，不自造别名：共识快照 / 全局 session / 协调 agent（coordinator）/ 共识账本（ledger.yaml）/ 事件流（events.jsonl）/ 快照文档 / 证据锚点 / 门禁（gate）/ 校验器（checker）/ 触发式升级 / 盲评投票 / 难度门 / 锚点独立度 / 上下文包 / 知识条目（KB-xxxx）/ 复述检验 / 单机器人路由。

- 目录 `cord/<req-id>/` 指**共识快照**在仓库内的物理形态，即「一个需求一份文件夹」；
- 文档中出现的 `C-xxx`（共识条目 id）、`KB-xxxx`（知识条目 id）、`CP-xx`（历史确认点编号）均为引用材料中的原生标识，保留以便溯源。
