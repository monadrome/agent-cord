# 核心 Feature：自主 Draft 交付与 Agent 启动能力

> 状态：已采纳的产品与架构基线（2026-10-09）；节点内 Goal、自动卡点升级、人工续跑/恢复与声明验收覆盖原型已实现，业务覆盖充分性与资源治理待完善。当前能力见 [当前架构](./current-architecture.md)，原则见 [ADR-0055](./adr/ADR-0055-goal-driven-draft-delivery.md)，原型协议见 [ADR-0056](./adr/ADR-0056-goal-node-execution.md)。

## 1. 默认认知

**用户交给 agent-cord 的是交付目标。系统在约定的权限与预算内，自主完成调研、计划、实现、自测、失败修复和交付整理，直到形成可供 human review 的 Draft。**

典型目标：实现一项功能，交付代码变更、针对当前代码的实际自测证据和 human review 指南。目标与验收边界明确、必要输入和依赖可用时，happy path 的中途人工干预次数应为 **0**。普通测试失败可在授权范围内自行修复时，也继续自动执行。

人保留最终 review、合入、发布、契约冻结及关键权限决策。日常节点推进、继续执行、测试与可修复失败无需逐次人工确认；必要事实、产品取舍或授权缺失时再升级。目标交付就绪与人工验收通过是两个不同结果。

这项原则覆盖 ACP、headless CLI 和自定义 agent。ACP 是通信协议；底层 agent 可以提供自己的持续执行能力，宿主仍负责目标生命周期、完成审计、恢复与权限控制。平台语义不依赖某家 CLI 是否有名为 `goal` 的原生模式。

## 2. 目标与交付契约

开始执行前，确定以下内容；可从 PRD、仓库规范和已发布的 SDLC 派生已有约定，无需让用户重复填写：

| 项目 | 最低要求 |
|---|---|
| 目标 | 预期行为、范围、明确的验收条件与已知限制 |
| 输入身份 | 需求、工作流版本、agent 配置身份、实际源码与依赖范围 |
| 执行权限 | 可读写的工作区、工具/命令和可逆操作范围；外部副作用与关键权限单列 |
| 验证要求 | 必需的测试、类型检查、构建或场景验收；按风险选择，已有团队最低集必须执行 |
| 资源边界 | 总时长、尝试次数、连续无进展上限；有可靠计量时再声明 token/费用预算 |
| 交付产物 | 代码变更、自测证据、human review 指南及它们对应的版本身份 |

默认代码交付包包含：

1. **代码 Draft**：可定位的分支或隔离工作区、变更 diff、相关测试和必要文档；标明提交基线及未提交变更。
2. **自测证据**：实际执行的命令、工作目录、排除凭据的环境摘要、退出状态、结果摘要及日志定位；绑定被测输入与源码内容身份。测试没有执行、失败、超时、被取消或证据过期时均不得标为通过。
3. **Human review 指南**：目标与完成项、主要行为变化、重点文件/符号、验收条件对应的测试证据、复现与操作路径、风险、未覆盖项和待人决定事项。涉及 UI 时附实际截图或操作路径，涉及协议时链接 ADR。

review 指南用于降低审查定位成本，不能代替代码与证据。产物路径由工作流声明，代码 Draft 可以在隔离检出中；不把示例文档名当作已实现的固定协议。

## 3. 宿主负责目标闭环

逻辑执行顺序如下；这些名称描述设计职责，不是新增事件或 API：

```mermaid
flowchart LR
    input["最新目标与输入"] --> implement["实现 Draft"]
    implement --> verify["宿主验证"]
    verify -- 可修复失败 --> implement
    verify -- 通过 --> audit["完成审计"]
    audit -- 缺交付项 --> implement
    audit -- 就绪 --> review["最终人工 review"]
```

- driver 的 `end_turn`、退出码 0 或 `agent.task.completed=ok` 只说明一次调用结束；宿主审计尚未通过时继续执行。
- 宿主观察验证器的实际执行结果，核验必需检查、当前源码/依赖身份及交付产物。模型回复“已通过”或一份测试报告不能独立放行。
- 完成判定必须同时满足约定验收条件、当前验证通过、交付包齐备、权限与新鲜度检查通过；无法判断时 fail-closed。机器验证证明声明范围内的结果，不能证明全部业务正确或代替最终人审。
- 普通测试失败、缺文档或 Draft 不完整时，把结构化失败摘要和相关日志定位反馈给 worker，在剩余预算内修复，再运行受影响检查及要求的回归。不能靠删除必需测试、降低验收条件或把失败改成 warning 达成目标。
- 验证器和完成判定由宿主控制；实现者不能自行改写通过事实。若 agent 与验证器共享可写环境，仍需补充隔离与证据完整性保障，不能仅凭 hash 声称抗篡改。
- 各次尝试使用最新快照与自包含上下文；必要时新建 agent 会话。目标可跨会话持续，外部 session ID 仅为执行回执，不是恢复事实来源。
- 代码或必要输入变化后旧验证、报告与交付就绪状态重新核验；人工 review 绑定具体交付版本，旧选择不能批准新代码。

执行状态与检查结果仍经 `session.events.append` 留痕。确定性的宿主决策位于现有 workflow/NodeRunner 生命周期内；不得额外建立一套独立推进 SDLC 的状态机，也不得伪造或回滚已退出节点。

## 4. 什么情况下升级人工

| 情况 | 自动处理边界 | 人收到的内容 |
|---|---|---|
| 缺必要事实或存在实质歧义 | 先检索授权范围内资料；无法确定且会影响验收时升级，不猜业务结论 | 缺什么、影响、有限选项与推荐理由 |
| 需要新的权限或关键决策 | 既有授权范围内操作自行推进；越界操作等待明确授权，关键 gate 保留人工 | 所需权限/决策、范围、后果与替代方案 |
| 外部依赖不可用 | 做有界重试和允许的恢复；凭据缺失、服务持续不可用等无法本地修复时升级 | 实际错误、已尝试措施、最小所需帮助 |
| 持续无进展 | 按验收条件推进、未解决失败集合和产物变化判断；不能仅以模型声称有进展续跑 | 重复失败、尝试历史、剩余工作与建议 |
| 资源预算耗尽 | 停止新增尝试、保留 checkpoint；不冒称完成，不自动扩预算 | 已交付部分、未完成项、消耗与续跑所需预算 |

“本轮回复结束”“一个常规测试首次失败”“进入下一个节点”都不是独立的人工升级理由。ACP permission 请求应按宿主已有授权策略处理；协议请求本身不等于必须找人，未知或超范围请求仍拒绝或升级，不能全量自动批准。

升级只挂起受影响的执行范围，避免重复提问；有独立且仍获授权的工作时可继续。人工答复进入事实与最新输入后，重新核验再续跑。没有答复、没有授权或等待超时均不视为同意。

用户始终可取消或纠偏。恢复以事件流与当前输入/产物为依据，不重复执行仍有效的工作；副作用结果未知时先对账，不盲目重放。交付就绪后停止执行并等待最终 review，不自行扩展目标。

## 5. 验收与度量

1. ACP 与 headless 在输入充足的真实开发目标上，从启动到交付就绪均无中途人工操作；最终 review 单独计数。
2. 植入普通测试失败后，系统自动修复并重新验证；若持续失败达到声明上限，则保留证据并发起明确升级。
3. driver 提前结束、空产物、测试未执行、伪造“全绿”文本或缺 review 指南时，完成审计拒绝交付就绪。
4. 代码、依赖或目标变更使旧证据失效；中断/冷恢复不重复有效工作，部分验证与未知副作用不能冒充成功。
5. 权限越界、外部阻塞、无进展、预算耗尽与取消均能结束活动调用并保留可恢复状态；不生成虚假人工批准。
6. 人工 reviewer 能从指南找到变更与实际证据；未经人工决定不合入、不发布、不通过关键 gate。

关注目标交付率、首次交付的人审接受率、过期/错误放行率、每目标成本和耗时、中途干预率与干预原因。按任务风险/难度分桶，单列最终 review；“大多数是 happy path”是待真实样本验证的产品假设，不能以隐藏失败或绕过授权来压低干预率。

## 6. 当前基础与实现差距

| 能力 | 当前状态 |
|---|---|
| ACP/headless、自定义 agent、节点执行与取消 | 已实现 |
| 最新快照、输入/产物指纹、checkpoint 校验、版本化审批 | 已实现 |
| Goal ready 来源与当前新鲜度 | 已实现；恢复/协调共用 worker/宿主验证来源，过期/不可读/取消不冒称当前交付 |
| `verification.completed`、源码范围、验证 checker 与证据新鲜度 | 已实现；接入结果事实不等于自动运行并可信观察测试 |
| `run.retry` 的失败摘要、次数与退避 | 已实现；成功任务后的验证失败尚不会自动触发实现修复闭环 |
| 节点内 Goal、宿主实际验证/修复、指南结构审计与实际证据、次数/时长/无进展边界 | 原型已实现；显式 run.goal，推荐 Agent 模板默认采用 |
| 声明验收条件覆盖 | 原型已实现；acceptance 绑定已发布检查，宿主生成逐项实测矩阵与事件引用，恢复/协调共用核验；不证明业务测试充分性（[ADR-0064](./adr/ADR-0064-goal-acceptance-coverage.md)） |
| 宿主源码变更清单 | 原型已实现；`review_changes` 在推荐模板默认开启，首次实际源码作为基线，指南列出声明范围内的增改删/权限/类型变化，ready/恢复/协调/人审共用完整 delta 重算；不推断作者归属或范围外变更（[ADR-0071](./adr/ADR-0071-goal-source-change-evidence.md)） |
| 人工卡点处理后的续跑 | 原型已实现；有效答复后独立授权原发布预算与当前输入，新 run 重新自测；授权绑定实际 worker 配置，冷漂移拒绝，配置还原后显式恢复原 run/预算，保留旧失败和最终 review（[ADR-0062](./adr/ADR-0062-goal-retry-agent-identity.md)） |
| 原授权 Goal 恢复 | 原型已实现；GET/POST 恢复依据绑定原授权、checkpoint、当前输入和配置身份，持久化请求后恢复同一 run；保留原 deadline/次数，幂等/冷恢复 fail-closed（[ADR-0063](./adr/ADR-0063-goal-recovery-command.md)） |
| ACP 文件操作范围预授权 | 已实现可写任务 read/edit 的结构化位置核验与 allow_once；未知/越界拒绝，只读不变 |
| 全部 PRD 语义覆盖判定、跨 driver execute/网络权限、费用/token 动态额度调整 | 待完善；显式矩阵只证明声明条件到检查事件的关联，readonly 工具审计与 ACP read/edit 策略不覆盖 execute/网络或替代 OS 沙箱 |
| blocked Goal 自动协调升级 | 原型已实现；显式 supervisor_agent 触发一次 ask_human/wait Draft，重启/并发去重 |
| Goal 升级协调重试 | 原型已实现；修复配置/事实后按最新 token 重试同 blocker，持久父子来源/单子请求、冷恢复不重放，未答复问题仍可进入独立 Goal 授权（[ADR-0065](./adr/ADR-0065-goal-coordination-retry.md)） |
| Goal 可观测 usage 预算 | 原型已实现；可选 input/output token 与 cost 上限，宿主累计 task usage，超限或声明预算下 usage 未知时保留 budget 证据并 fail-closed，不把未知 usage 当零（[ADR-0066](./adr/ADR-0066-goal-usage-budget.md)） |
| 当前 Goal 资源观察 | 原型已实现；server 提供当前 run 的逐指标 totals/budget/unknown/exceeded/invalid，协调模型与控制台消费同一投影，冷恢复和来源跳转保持绑定（[ADR-0067](./adr/ADR-0067-goal-usage-observation.md)） |
| 跨 driver 只读 worker 审计 | 原型已实现；readonly worker 的明确读工具/安全命令通过，写入/未知/危险工具 fail-closed 为不可重试 driver failure，不保存工具输入；不替代 OS 沙箱（[ADR-0068](./adr/ADR-0068-readonly-tool-audit.md)） |
| 同 workspace agent lease | 原型已实现；单 RunService 只允许一个含 `node.run` 的活动执行器，启动冲突 409，冷恢复释放后自动续跑原 run/预算，执行收束或启动失败才释放；不冻结 review 版本，不替代 worktree 或 OS sandbox（[ADR-0069](./adr/ADR-0069-workspace-agent-lease.md)） |
| 本地跨实例执行锁 | 原型已实现；SQLite 跨进程互斥，busy 原授权恢复自动重检，正常收束清 owner 标记，宿主崩溃/未知副作用保留标记并阻断派发；不保证同需求多 daemon 事件写入安全（[ADR-0070](./adr/ADR-0070-cross-process-workspace-lease.md)） |
| 独立 Context Session Agent | 已实现最新快照提议、人工采用与受限 Goal 观察；声明 supervisor 后自动解释 blocker 并生成人工卡点，完整监督续跑仍待完善 |

真实 agent 开发流程的设计默认是 Goal；“Agent 协作 · Goal”模板与 [goal-sdlc.yaml](../examples/goal-sdlc.yaml) 提供当前原型。零外部依赖的离线 `simple-sdlc` 继续用于验证平台内核，既有发布版本与人工 gate 保留原语义。后续按 [路线图](./10-roadmap.md) 继续完善，跨模块协议先更新 ADR。

## 7. 原子 Agent 能力与启动控制

**平台先识别可用能力，再编译明确的启动配置。用户选择的能力必须生效；不支持时直接拒绝，不能告警后悄悄使用默认模型或开启新会话。** 这项原则覆盖内置 CLI、自定义 wrapper 和 ACP，协议见 [ADR-0073](./adr/ADR-0073-agent-launch-capabilities.md)，配置与 human review 指南见 [启动能力验收](./research/2026-10-10-agent-launch-capabilities.md)。

| 维度 | 当前控制与边界 |
|---|---|
| 通道 | `kind: acp/headless` 或显式 driver 前缀；裸 agent 名遵循 registry 选择规则 |
| 上下文 | Claude `launch.bare` 明确关闭部分自动加载；会改变仓库指令/认证加载，不默认开启 |
| 执行生命周期 | `run.goal` 由宿主控制代码、自测、修复与 review 交付；普通单次调用仍可显式配置 |
| 自主权限 | Claude `launch.auto` 使用厂商 auto 审批；ACP 使用协商 mode/文件范围预授权；readonly 优先，最终 gate 仍人工 |
| 只读任务映射 | headless 能力分别声明 `readonly_launch/readonly_resume`；自定义 wrapper 用完整参数分支或 `{{readonly}}` 显式消费任务模式，缺只读恢复映射时启动前拒绝 |
| 节点能力准入 | `run.require_readonly_mapping: true` 要求 `readonly=true` 且当前 headless 能力声明 `readonly_launch=mapped`；协调、派发和 checkpoint 复用共同 fail-closed |
| LLM 路由 | `launch.provider/model/effort` 是独立维度；headless 仅使用显式 argv 映射，ACP 使用 `option_ids` 和完整配置回执；内置 CLI 未声明 provider 时拒绝 |
| 角色与资源 | Claude 支持 `launch.agent/agents_json/system_prompt/max_turns/budget_usd`；Goal 有宿主时长、尝试、无进展和可靠 usage 预算 |
| 原生会话恢复 | 必须显式 session ID；内置 headless 模板、ACP 协商 loadSession、自定义 `resume_args` 分别负责 |
| 固定流程节点恢复 | 原授权 Goal recovery 加 `node_id`，限定原 token 绑定的未退出节点；保持 checkpoint、输入/配置身份、原预算和人工 gate |
| 扩展 | ACP `config_options` 支持 select/boolean；自定义 argv 显式绑定 model/effort/session；外部行为变化用 `context_revision` |

`GET /agents` 给出适配器声明的能力表，安装状态为 unchecked。`POST /agents/:name/inspect` 可核验 ACP initialize/session/new 和启动配置，不发送 prompt；返回有界 mode、配置 ID、模型/effort 候选及省略数，绑定查询使用的 revision/configuration_hash。内置headless模板另提供固定版本/帮助查询，明确CLI不可用/超时/无法识别和逐项帮助证据；自定义原始args不猜测探测命令。

控制台 Agent 页提供能力筛选、逐 Agent 声明与显式 ACP 查询。协议观察与静态声明分别呈现；查询后的最新清单核对、失败/重试、过期及移除后的历史材料已接通，不将注册状态表示成验证通过。查询返回时和消费时都核对配置身份，协议协商仍不证明模型访问或额度可用（[ADR-0074](./adr/ADR-0074-agent-capability-console.md)）。

ACP 启动选择持续一致性已接通：`option_ids.mode` 支持仅提供新 configOptions 的 agent，按 mode 后的实际候选选择模型；当前 session 明确选择被更新、移除或改变类型时，以不可重试配置错误取消，不形成 Goal ready 或协调提议。旧 set_mode 兼容空成功回执，同值/未显式选项/外部 session 更新不误冻结（[ADR-0075](./adr/ADR-0075-acp-launch-state-consistency.md)）。

等待最终人审期间，活动run查询/控制台与协调Agent都从当前gate事实显示waiting_human，避免SQLite操作登记running掩盖等待。有效输入后仍需gate重检；active槽位和workspace占用不因等待状态释放（[ADR-0076](./adr/ADR-0076-active-run-wait-projection.md)）。

Headless运行时能力查询已接通，CLI版本、任务/恢复帮助、已配置项与帮助是否展示分别呈现。帮助未展示不等于不支持；Codex effort配置键、模型访问/权限/额度和真实session恢复均不能由帮助证明。查询不执行prompt或改变启动身份，整体超时/输出限量并清理进程树（[ADR-0077](./adr/ADR-0077-headless-cli-inspection.md)）。

能力查询受单服务实例生命周期控制：相同快照和timeout的并发查询共享一次探测，不同查询冲突返回稍后重试；完成结果不缓存。server关闭前取消在途ACP/CLI查询并等待进程收束，关闭后新查询返回service_closing，不占用worker执行槽位（[ADR-0079](./adr/ADR-0079-agent-inspection-lifecycle.md)）。

自定义 headless 现已明确选择可写/只读与新会话/原生恢复四种完整 argv；模型/effort 映射须一致，恢复分支须绑定指定 session，替换一次且不经 shell。控制台与协调输入共用能力声明。旧新任务 argv 保留，旧无只读恢复映射的显式 resume 改为拒绝，配置身份可能变化；映射不证明 wrapper 已实施权限或工具执行前拦截，宿主只读审计继续生效（[ADR-0080](./adr/ADR-0080-custom-readonly-launch.md)、[配置与人审指南](./research/2026-10-10-custom-readonly-launch.md)）。

Provider 是独立的 LLM 路由选择：ACP 必须通过 `option_ids.provider` 绑定真实 session 配置项并核验候选/回执；自定义 headless 在所有 argv 分支使用 `{{provider}}`；内置 CLI 没有统一 provider 旗标，配置会直接拒绝。它不从 model、环境变量或 prompt 推断，也不证明模型权限、额度或输出质量（[ADR-0082](./adr/ADR-0082-provider-launch-selection.md)）。

ACP路由切换先于扩展/model/effort设置，逐步使用最新回执，并在最终和运行中核验全部显式选择。新路由解锁的选项可用，反向重置仍拒绝；provider配置绑定新顺序身份，旧未声明配置保持兼容。provider仅为启动控制，Goal测试证据、最新需求/源码与人审仍独立核验（[ADR-0083](./adr/ADR-0083-provider-configuration-order.md)、[配置与人审指南](./research/2026-10-10-provider-launch.md)）。

流程节点可以显式要求 `require_readonly_mapping`。这不是把所有 readonly 节点强行升级，而是给安全敏感流程一个可验证的准入条件：未解析、无稳定配置身份、ACP 通道或未映射 headless agent 只能生成 wait/ask_human，不能 advance；实际派发前和完成复用时仍会重检，修复配置后以最新快照重新协调。该字段只验证启动参数映射，不提供 OS 沙箱或模型权限证明（[ADR-0081](./adr/ADR-0081-node-readonly-mapping-requirement.md)）。

独立协调已默认读取完整流程worker/supervisor配置身份和有界能力声明；worker模型、角色、通道或context_revision改变会使旧提议不可采用。未知/缺稳定身份的next worker不能advance，只能解释配置卡点；采用固定实际resolver并重检，冷恢复也验证原完成来源与同一身份，不自动换Agent或放行gate（[ADR-0078](./adr/ADR-0078-coordination-agent-context.md)）。

待扩展维度包括内置 CLI 的 provider 路由、MCP/工具集、网络与沙箱、隔离 worktree、CLI 精确版本探测、原生 fork/turn checkpoint；应按厂商真实能力逐项映射。任意历史 workflow rewind、跨 agent 的原生 session 迁移不在当前保证内，不能通过清除已退出节点事实实现。
