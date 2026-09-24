# ADR-0017 ｜ AgentDriver 驱动协议：ACP 直连，裸 headless 为降级通道

- 状态：accepted（设计定稿，代码未实现）
- 日期：2026-09-24
- 关联：ADR-0011（agent 运行时——本 ADR **部分取代**其「驱动协议 = 裸 CLI headless 接口」的选型为 ACP 直连；每任务 subprocess、盲评隔离、超时预算等核心决策不变）、ADR-0013（投票执行器走模型 API，与本 ADR 分工不变）、ADR-0019（插件协议，同属 JSON-RPC 族）
- 来源：开源实现调研（2026-09-24，[docs/research/2026-09-24-02](../research/2026-09-24-02-headless-agent-drivers.md)）；2026-09-24 人工拍板

## 背景

ADR-0011 已定型「每任务 subprocess 驱动 headless CLI + 统一 `AgentDriver` 接口」，但驱动协议层的口径停在「裸 CLI headless 接口 + 每家一个适配器」。2026-09-24 的开源实现调研带来三个改变选型空间的事实：

1. **生态已收敛出标准驱动协议**：ACP（**Agent Client Protocol**，Zed 发起；勿与 IBM 的 Agent Communication Protocol 混淆）协议 v1 已稳定，官方 TS SDK（`@agentclientprotocol/sdk`，Apache-2.0），registry 覆盖 41 个 agent（含 Kimi 原生 `kimi acp`、官方 claude-acp / codex-acp 适配器）。协议形态正是 ADR-0011 要求的「agent 作为 client 的子进程 + JSON-RPC over stdio」，且自带 `session/request_permission`（门禁人工放行的天然挂载点）与 `session/load`（会话恢复）。
2. **统一抽象层出现但不可押注**：Vercel `@ai-sdk/harness` 与 `AgentDriver` 接口 1:1 对应，但官方标注 experimental（明确声明版本间会 breaking change）、假定 harness 运行在 sandbox 内（与本项目「本地 daemon + 用户本机工作区」模型冲突），且会把无对应类型的事件降级为动态工具部件——对 `events.jsonl` 的强类型事件模型是信息损失。
3. **PTY 抓屏路线被证伪**：该路线的代表实现 coder/agentapi 已归档 deprecated。

本决策点要回答：协议层自研还是基于 ACP；harness 层是否复用；不支持 ACP 的 CLI 怎么办。

## 备选方案

### 备选 A：纯自研裸 CLI 驱动协议（ADR-0011 原口径）

- **是什么**：对每家 CLI 的 headless 参数、结构化输出格式、resume 约定各写一个适配器。
- **优点**：控制面最全；不依赖任何第三方协议演进。
- **缺点**：每家 CLI 的事件流格式、权限请求语义、会话恢复各不相同，N 家 = N 套解析与回归测试；业界已把这些差异收敛进 ACP，自研等于重复造一遍且没有生态红利。
- **契合度**：中。保留为降级通道（见决策），不作主路径。

### 备选 B：ACP 为协议底座（AgentDriver 第一实现 = ACP client）

- **是什么**：`AgentDriver` 保持为平台自有薄接口（`run(task) → 事件流 | 结果`、`resume(session_id, fork?)`），其第一实现是 ACP client；ACP 覆盖不了的 CLI 由裸 headless 降级驱动补齐。
- **优点**：一个 adapter 覆盖 41 个 agent，「不绑定特定厂商」从承诺变成协议层保证；permission request / session load 与门禁、会话恢复语义一一对应；协议 v1 稳定且由多方共建（Zed、JetBrains 等）。
- **缺点**：ACP 是「编辑器 ↔ agent」协议，投票、证据锚点、账本语义仍需自研（本就不属于驱动层）；存在已知缺陷（子 agent 发出的 permission request 在部分实现下不转发会挂死，需防御性超时）。
- **契合度**：最高。

### 备选 C：复用 `@ai-sdk/harness` 作为抽象层

- **优点**：接口形状与 `AgentDriver` 几乎一致，adapter 生态现成。
- **缺点**：experimental 定位（无兼容性承诺）；sandbox 假设与本项目运行形态冲突；事件投影有损。
- **契合度**：低。**否决**；若未来其稳定化且 sandbox 假设可绕，可重新评估（需新 ADR）。

### 备选 D：PTY 终端模拟驱动

- **缺点**：已被 coder/agentapi 的归档证伪（转义模拟 + 屏幕快照 diff 的脆弱性无解）。
- **契合度**：否决；仅对无任何结构化接口的 agent（如闭源 Antigravity CLI 在无 ACP 前）作最后兜底。

## 决策

**`AgentDriver` 为平台自有薄接口，其第一实现 = ACP client（`@agentclientprotocol/sdk`）；裸 CLI headless 驱动为降级通道；PTY 仅作最后兜底；不复用 `@ai-sdk/harness`。**

1. **ACP 覆盖优先**：凡 registry 内或支持 `acp` 子命令的 agent 一律走 ACP；Claude / Codex 可额外保留直连适配器（`claude -p` stream-json / `codex app-server` JSON-RPC）作为能力上限通道。
2. **事件采集挂在 ACP 原始事件层**（`session/update` 通知流），不经任何投影层，保证 `events.jsonl` 的强类型事件不损失粒度。
3. **门禁人工放行桥接 `session/request_permission`**：权限请求转成平台事件，经单机器人路由推回 IM 选择题；审批决策状态机自研。
4. **agent 清单以 ACP registry 为准**，不为每家手工维护安装与版本信息。

## 理由（第一性原理推导)

1. **从「不绑定厂商」反推**：ADR-0011 要求驱动层是 CLI 无关的通用原语。自研协议（A）只能做到「我们的接口无关」，ACP（B）做到「整个生态已经无关」——绑定面收敛到一个开放协议，比自己维护 N 套适配器便宜一个数量级。
2. **从「门禁需要机器可介入的审批点」反推**：盲评与门禁要求「人审的权限请求转成平台事件」。ACP 的 `session/request_permission` 是现成的结构化挂载点；裸 CLI 的权限提示是终端交互文本，机器介入要靠抓屏——这正是被证伪的路线。
3. **从「协议稳定性」反推**：harness 层（C）的接口贴合度最高，但「experimental + 每周发版 + sandbox 假设」意味着把它放进核心依赖等于把发布节奏与运行形态的决定权交给第三方；协议层（ACP v1 稳定）与抽象层（harness experimental）的风险等级不同，选型按风险等级而非接口贴合度。
4. **从 ADR-0011 的兼容性反推**：ACP 的部署形态（agent 是 client 的子进程、JSON-RPC over stdio）就是「每任务 subprocess」的协议化，采纳它不改动 ADR-0011 的任何核心决策，只把「裸接口」升级为「标准接口」。

## 被否方案的否决理由（逐一）

- **备选 A 作为主路径**：否决于生态红利缺失与 N 套适配器的维护负担；保留为降级通道（ACP 未覆盖的 CLI）。
- **备选 C（@ai-sdk/harness）**：否决于 experimental 定位、sandbox 运行假设、事件投影有损三条；不进入依赖树，仅作接口设计参照。
- **备选 D（PTY）**：否决于路线已被公开归档项目证伪；仅作无结构化接口 agent 的最后兜底。
- **「等待 ACP v2 再采纳」**：否决——v1 已稳定且覆盖当前所需全部基线方法；v2 的实验性扩展（`experimental/v2` 显式开启）不影响 v1 承诺。

## 关键实现注意点

1. **术语消歧**：文档与代码中一律写全称「Agent Client Protocol」，避免与 IBM Agent Communication Protocol 混淆。
2. **防御性超时**：对 permission request / prompt 全程挂 wall-clock 超时（沿用 ADR-0011 的三层防线），因子 agent 的 permission request 在部分实现下不转发会挂死。
3. **Claude 许可边界**：Claude Agent SDK / claude-code 为专有许可——仅作为用户本机 BYO 凭证的可选适配器，不进核心依赖树；daemon 不代管任何厂商凭据；品牌上不得自称 "Claude Code"。
4. **盲评隔离不变**：每票 = 独立进程 + 独立临时 worktree + 独立 env（ADR-0011 注意点 2 原样适用）；ACP 的 `session/load` 只允许用于执行类长任务恢复，投票任务永远起全新 session。
5. **降级通道的探测顺序**：ACP → 厂商直连协议（stream-json / app-server）→ 裸 headless 参数拼装 → PTY（最后兜底，需显式配置开启）。
6. **registry 缓存**：ACP registry 为远程清单，daemon 启动时拉取并本地缓存，离线时用缓存；清单变更写事件流。

## 证据来源

1. 开源实现调研归档（2026-09-24）：ACP 协议/registry 现状、各家 CLI headless 能力矩阵、harness 风险评估、PTY 路线证伪：[docs/research/2026-09-24-02-headless-agent-drivers.md](../research/2026-09-24-02-headless-agent-drivers.md)
2. ACP 协议仓库与 TS SDK：https://github.com/agentclientprotocol/agent-client-protocol （Apache-2.0）；registry：https://github.com/agentclientprotocol/registry
3. ACP 已知缺陷（子 agent permission request 不转发）：https://github.com/anomalyco/opencode/issues/12133
4. PTY 路线证伪（已归档）：https://github.com/coder/agentapi
5. 统一驱动接口设计的参照样本（Session/Run/Item 模型、Authority/Preview 双层）：codex app-server 文档；`@mosoo/agent-driver`（仅借思路）；`zzjas/caw`（仅借思路）
6. 多 agent 统一 session 层的工程实证（各家集成方式矩阵；AGPL 仅读不抄）：https://github.com/tiann/hapi
