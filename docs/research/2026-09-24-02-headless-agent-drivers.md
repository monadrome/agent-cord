---
title: Headless coding agent CLI 统一驱动
date: 2026-09-24
type: research-archive
status: 调研结论均为 2026-09-24 当日实测，时效性敏感（star 数、版本、license 可能变化）
---

调研完成。以下是完整报告。

---

# agent-cord：Headless coding agent 统一驱动 —— 可复用开源实现调研

调研时间 2026-09-24。所有 star/活跃度均通过 GitHub API 与 npm registry 实时核验。

## 0. 核心结论

1. **不需要为每家 CLI 手写 subprocess 驱动。** agent-cord 设想的 `AgentDriver` 抽象在 2026 年已有**三层现成实现**，而且互相兼容：ACP 协议层（41 个 agent 已注册、官方 TS SDK）、AI SDK Harness 层（与 `AgentDriver` 近乎 1:1 对应）、各家官方 SDK。建议：**协议用 ACP，抽象层复用 `@ai-sdk/harness`，只对未被覆盖的 agent 自写 adapter**。
2. **"投票执行器直连模型 API" 与 "agent 运行时驱动 headless CLI" 是两条完全不同的技术栈**，不要用同一层抽象。前者用 AI SDK provider 层（`generateText` + `Output.object`），后者用 ACP/Harness 层。用一个库同时包两者会导致结构错位。
3. **三个必须在设计文档里改掉的事实**（见第 1 节）：Gemini CLI 已停服、Aider 维护停滞、`coder/agentapi` 已归档废弃。

---

## 1. 时效性警告：三个颠覆既有假设的事实

| 事项 | 现状 | 对 agent-cord 的影响 |
|---|---|---|
| **Gemini CLI** | 2026-06-18 起停止为免费/Pro/Ultra 消费者账号服务，官方指定后继为 **Antigravity CLI（`agy`，闭源 Go 二进制）**。`google-gemini/gemini-cli`（107,147★，Apache-2.0）仓库仍在、npm `@google/gemini-cli@0.61.0` 仍在发版，但**只能用付费 Gemini API key 驱动** | 设计文档里"claude / codex / kimi / gemini"四家并列的前提已失效。要么改成 **`agy`**，要么保持 gemini-cli 但明确限定为 BYO-API-key 场景。`agy` 闭源 → **只能通过 ACP 或子进程驱动，不能当库调用** |
| **Aider** | 49,154★ / Apache-2.0，但**最后一次 push 是 2026-05-22**；release 节奏崩塌（v0.86.2 是 2026-02），社区在 issue #5647 公开质疑维护状态；另有 **CVE-2026-10175（RCE，无厂商补丁）** | 不建议列入首版驱动支持列表。Python `Coder` API 官方明确声明"不保证向后兼容、非官方支持" |
| **`coder/agentapi`** | 1,500★，MIT，**2026-09 已 archived**，README 首行标注 deprecated | 这是"PTY + 终端模拟"路线的代表实现，它的死亡说明**终端屏幕解析路线是死路**，agent-cord 应走结构化协议而非 PTY 抓屏 |

---

## 2. 候选分组

### A 组：统一驱动抽象层（`AgentDriver` 的直接对标物）

#### A1. Vercel AI SDK Harness 层 —— **直接复用（首选）**

- 仓库：`vercel/ai`（26,928★，pushed 2026-09-24）；npm 包 `@ai-sdk/harness` + 11 个 adapter，全部 **Apache-2.0**
- 提供什么：`HarnessAgent` 统一接口，`createSession()` / `generate()` / `stream()`；输出投影为 AI SDK 的 `GenerateTextResult` / `StreamTextResult`。已有 adapter：

  | adapter | 运行时 |
  |---|---|
  | `@ai-sdk/harness-claude-code` | Claude Code |
  | `@ai-sdk/harness-codex` | Codex |
  | `@ai-sdk/harness-opencode` | OpenCode |
  | `@ai-sdk/harness-cursor` | Cursor |
  | `@ai-sdk/harness-cline` / `-github-copilot` / `-grok-build` / `-grok-build` / `-deepagents` / `-fx` / `-pi` | 其余运行时 |
  | **`@ai-sdk/harness-acp`** | **元 adapter：只要是 ACP 兼容 agent 就能包** |
  | 即将支持 | Amp、Goose、Mastra |

  另有 `packages/workflow-harness`（把 harness 轮次做成可持久化工作流，正好对应 daemon 的长任务需求）
- **与 agent-cord 的匹配度：直接复用，且是最贴合的候选。** `HarnessAgent` ↔ `AgentDriver`、harness adapter ↔ driver 实现、`@ai-sdk/harness-acp` ↔ "一个 adapter 覆盖所有 ACP agent"、session 的 `detach()`/`stop()` 返回 resume state ↔ 事件流与快照持久化。
- **风险（必须写进 ADR）**：
  1. 官方文档明确标注 **experimental，"Expect breaking changes between releases"**，版本号 1.0.x 每周发版（claude-code adapter 已到 1.0.127）。
  2. 它假定 harness **运行在 sandbox 里**（"all AI SDK agent harnesses operate in a sandbox"）。agent-cord 是本地常驻 daemon + 用户本机仓库，需要确认是否可用本地 sandbox provider 或绕过，否则模型/工具生命周期绑定方式会与设计冲突。
  3. 已知短板：`claude-code` adapter 不支持 user message 的 `file`/image part（[issue #17082](https://github.com/vercel/ai/issues/17082)），vision 输入走不通。
  4. 它把 harness 的输出事件投影为 AI SDK 类型，"工作区文件变更 / compaction"等无对应类型的事件被降级为 dynamic tool part → **对 `events.jsonl` 的强类型事件模型是信息损失**，需要额外从 adapter 原始层取事件。

#### A2. ACP（Agent Client Protocol）+ 官方 TS SDK —— **直接复用（协议底座）**

- 协议仓库：`agentclientprotocol/agent-client-protocol`（4,319★，Apache-2.0，Rust，**pushed 2026-09-24**，即今天）；协议版本 **v1 稳定**，v2 为草稿（`@agentclientprotocol/sdk` 需 `import .../experimental/v2` 显式开启）
- TS SDK：`@agentclientprotocol/sdk@1.5.0`，**Apache-2.0**。提供了 client/agent 两端 helper（`client({name})` + `connectWith(stream, ...)` 直接写客户端）
- Registry：`agentclientprotocol/registry`（407★，Apache-2.0），CDN 索引 `https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`，**实测 41 个 agent 已注册**，每小时 cron 自动升版本
- 协议内容（对 agent-cord 极其重要）：
  - 传输：JSON-RPC 2.0 over stdio，agent 作为 client 的子进程
  - Baseline：`initialize`、`authenticate`、`session/new`、`session/prompt`；可选 `session/load`（**恢复原生会话**）、`session/set_mode`
  - Agent→Client：`session/request_permission`（**这是 gate/人工放行的天然挂载点**）、`session/update` 通知流、`fs/read_text_file`、`fs/write_text_file`、`terminal/*`
  - 扩展机制：`_meta` 字段 + `_` 前缀自定义方法 + capabilities 协商
  - 约定：所有路径必须绝对路径，行号 1-based
- Registry 实测条目（节选）：`claude-acp` 0.81.2、`codex-acp` 1.13.1、`kimi` 1.52.0、`opencode` 1.18.32、`qwen-code` 0.24.4、`cursor`、`github-copilot-cli`、`grok-build`、`gemini` 0.61.0、`antigravity-acp` 1.2.1、`cline`、`goose`、`amp-acp`、`mistral-vibe`、`factory-droid`、`devin`、`junie`、`qoder`、`pi-acp` 等
- **匹配度：直接复用。** 建议 agent-cord **把 ACP client 作为 `AgentDriver` 的默认实现**，`agent-cord` 自身作为 ACP client，把每个 coding agent 作为 ACP subprocess 拉起。这样：
  - 一个 adapter 覆盖 41 个 agent，其中 claude/codex 通过官方 adapter（`@agentclientprotocol/claude-agent-acp` 0.81.2、`@agentclientprotocol/codex-acp` 1.13.1，均 Apache-2.0，当天在更新）
  - `session/request_permission` 天然对应 agent-cord 的 gate 人工放行
  - `session/load` 天然对应 `cord/<req-id>/` 的会话恢复
- **局限**：ACP 是"编辑器↔agent"协议，**不覆盖**投票、证据锚点、共识账本、gate 校验器——这些仍需自研（见第 3 节）。另有已知缺陷：子 agent（如 opencode 的 Task subagent）发出的 permission request 在 ACP 下不转发会挂死（[opencode#12133](https://github.com/anomalyco/opencode/issues/12133)、[zed#62015](https://github.com/zed-industries/zed/issues/62015)），需要防御性超时。

#### A3. `acpx`（openclaw/acpx）—— **适配后复用（可选，补 ACP 运行时缺口）**

- 3,278★，**MIT**，`acpx@0.19.2`，pushed 2026-09-24（今天）
- 提供什么：ACP 的 headless CLI，且**导出 `acpx/runtime` 和 `acpx/flows` 供库内嵌**：
  - `acpx/runtime`：会话与工作流原语，`createSharedAcpRuntime()` 让 CLI 与宿主共享同一个本地 session owner
  - `acpx/flows`：**TypeScript 工作流**，把 ACP turn 与确定性动作、判定、计算、checkpoint 组合起来
  - `--format json` 输出 NDJSON 结构化 ACP 事件；permission mode 分级；`--cwd` 定义文件系统边界；session 状态存于 `~/.acpx/`
- **匹配度：适配后复用。** `flows` 与 agent-cord 的"预定义有向图 + gate"概念高度重叠，`acpx/runtime` 与"daemon 内嵌驱动"重叠。若不想从零写 ACP 客户端和 session owner，acpx 是最省事的起点。
- 注意：**pre-1.0，CLI 与 runtime 接口明确声明会演进**。

#### A4. `langgenius/mosoo-agent-driver`（`@mosoo/agent-driver`）—— **只能借鉴思路**

- 74★，Apache-2.0，pushed 2026-09-13。**注意：npm 上 `@mosoo/agent-driver` 查询返回 Not found**（未发布或已下线），只能读源码
- 提供什么：名字就是 "Agent Driver"。Driver Kernel 把三种传输 `openai-app-server`（Codex）、`claude-agent-sdk`、`acp-fallback` 投影到**单一 Driver 命令/事件协议**；定义了 `Session → Run → Item` 的稳定模型、Authority/Preview 双通道、单写者、单调生命周期状态机、有界恢复、ULID
- **匹配度：只能借鉴思路。** 理由：
  1. **仅面向 Bun**（自建 process runner、Vite+ 工具链），与 agent-cord 的 TS/npm 栈不兼容
  2. 强绑定 mosoo 自己的沙箱 + Cloudflare Durable Object + ORPC WebSocket 拓扑，不是通用库
  3. 74★、单公司维护、共享的实验性 CMA 适配器明确标注 unsupported
- **但它的架构设计值得直接抄进 agent-cord 的 ADR**：`Session/Run/Item` 三层模型、Authority 为唯一持久真相 + Preview 为可丢弃流式覆盖层、单调单向状态机（终态不可重开）、ULID + 带时区 ISO8601。这套模型和 agent-cord 的 `ledger.yaml` 条目状态机 + `events.jsonl` 是同一个问题，抄模型比抄代码划算。

#### A5. Lite-Harness SDK（`LiteLLM-Labs/lite-harness`）—— **只能借鉴 / 观望**

- 92★，pushed **2026-06-03**（近 4 个月无更新），GitHub API 未识别到 SPDX license 文件（文章自称 MIT）
- 提供什么：TS + Python，**暴露成 Claude Agents SDK 的 API 形状**（`query({prompt, options:{harness}})`），支持 Claude Code / Codex / Pi 三个 harness；可选经 LiteLLM Gateway 代理
- **匹配度：只能借鉴思路。** 它的核心洞察值得采纳——"**harness 是继模型之后的下一个厂商锁定点，统一的是调用方式，不是运行时行为**"。但活跃度和成熟度都不适合作为依赖。

#### A6. `zzjas/caw`（Coding Agent Wrapper）—— **只能借鉴**

- 12★，Apache-2.0，pushed 2026-09-13，Python，PyPI `coding-agent-wrapper`
- 提供什么：`Agent` / `Session` 统一 API 包 Claude Code / Codex / opencode；`CAW_PROVIDER` 环境变量切 provider；fallback 顺序 `Agent(provider=["claude","codex","opencode"])`；结构化 `Trajectory`（turns/content blocks/token usage/cost）；`@tool` 装饰器自动起 MCP tool server；`resume_handle` 跨进程恢复；trajectory viewer
- **匹配度：只能借鉴。** 语言不对（Python），星数太低，但它的 API 设计（统一 Trajectory + usage/cost + resume_handle + provider fallback）是 agent-cord `AgentDriver` 接口设计的**最佳参考样本**。

#### A7. HAPI（`tiann/hapi`）—— **只能借鉴（且注意 license）**

- 5,124★，**AGPL-3.0**，pushed 2026-09-24（今天），TypeScript
- 提供什么：一个"包住各家 coding agent 的统一 session 层"，本地 TUI wrapper + 远程控制（web/PWA/Telegram）。**它的 supported agents 矩阵是本次调研中最有价值的工程实证**：

  | Agent | 集成方式 |
  |---|---|
  | Claude Code | 本地 TUI wrapper + 远程 **Claude Agent SDK** |
  | Codex | TUI wrapper + 远程 **`codex app-server` JSON-RPC** |
  | Cursor / Grok / Copilot / Kimi / OpenCode | **ACP**（`agent acp` / `grok agent stdio` / `copilot --acp --stdio` / `kimi acp` / `opencode acp`） |
  | Antigravity (`agy`) | **交互式 PTY + hook 桥接**（因为没有 ACP 之前的兜底） |
  | Pi | `pi --mode rpc`（JSON-line RPC over stdio） |
  | Gemini | **已移除**（tombstone 命令） |

- **匹配度：只能借鉴，不要复用代码（AGPL-3.0 与 Apache-2.0 不兼容）。** 但它证明了：**结构化协议（ACP / app-server JSON-RPC / SDK）是主流路线，PTY 是最后兜底**，且每个 agent 的 permission mode 语义各不相同需要 per-agent 映射。

#### A8. `coder/agentapi` —— **不匹配（已废弃）**

1,500★，MIT，**已 archived**，README 首行 deprecated，建议改用 "Coder Agents"。技术路线是**内存终端模拟器**（起 PTY、转义成按键、diff 终端快照切分消息、再剥 TUI 元素）。roadmap 里的"MCP 支持""A2A 支持"永远没做。**明确不要参考这条路线。**

#### A9. `inovacc/corral` —— **不匹配**

provider-abstracted Go runtime，0★。概念对（warm session pool、rate-limit awareness、pluggable providers），但不成熟、非 TS。

---

### B 组：各家 headless CLI 现状矩阵（被驱动的对象本身）

| CLI | 非交互入口 | 结构化输出 | 常驻/会话模式 | 原生 ACP | License | 活跃度 |
|---|---|---|---|---|---|---|
| **Claude Code** | `claude -p` / `--print`；`--input-format stream-json --output-format stream-json`（双向流式）；`--permission-mode` | `--output-format json`（返回完整 `SDKResultMessage`）或 `stream-json` | Agent SDK（TS/Python）；`--resume <session-id>` | 否，需 adapter | **专有**（`SEE LICENSE IN README.md`，GitHub 仓库无 license） | 147,920★，当日 push |
| **Codex CLI** | `codex exec "task"`（可 `exec resume`） | `--json`（JSONL 事件）+ `--output-schema`（严格结构化） | **`codex app-server`**：JSON-RPC 2.0，Thread / Turn / Item 三层，stdio（WebSocket 标为实验性） | 否，有 `codex-acp` adapter | Apache-2.0 | 126,315★，当日 push |
| **Gemini CLI → Antigravity CLI** | `gemini -p` / **`agy -p`**（`--input-format stream-json --output-format stream-json --dangerously-skip-permissions`） | 有 | 有限 | `antigravity-acp`（registry） | CLI 仓库 Apache-2.0；**`agy` 闭源 Go 二进制** | gemini-cli 107,147★ 但**消费者渠道已停服** |
| **Kimi Code** | **`kimi -p --output-format stream-json`**；`kimi -r` 恢复 | `--output-format stream-json`（JSONL） | 持久 session + `kimi acp` | **是，原生**（`kimi acp`，覆盖 10/11 reverse-RPC，含 `session/request_permission`、`fs/*`、`terminal/*`） | MIT | 7,660★，当日 push，npm 2.1.1 |
| **OpenCode** | `opencode run`（`--auto` 免权限确认） | JSON event 输出 | **`opencode serve`**（HTTP API，可远端驱动）；`opencode acp` | **是，原生** | MIT | **209,830★**，当日 push，`@opencode-ai/sdk` 1.18.32 |
| **Qwen Code** | `qwen -p "..." --output-format stream-json -y` | stream-json | **ACP daemon** | **是**（registry `qwen-code`） | Apache-2.0 | 28,110★，当日 push |
| **Aider** | `--message` / `--yes`；Python `Coder` API（官方声明非兼容保证） | 弱 | 无 daemon | 无 | Apache-2.0 | **49,154★，最后 push 2026-05-22，维护停滞 + CVE** |
| **Cursor** | `agent -p`（legacy） | stream-json | **`agent acp`** | **是** | 闭源 | 活跃 |
| **GitHub Copilot CLI** | — | — | `copilot --acp --stdio` | **是** | 闭源 | 活跃 |
| **Grok Build** | — | — | `grok agent stdio`（ACP） | **是** | 闭源 | 活跃 |
| **goose** | — | — | ACP | **是** | Apache-2.0 | 54,613★（repo 已迁至 `aaif-goose/goose`） |
| **Pi** | — | — | `pi --mode rpc`（JSON-line RPC，非 ACP）；另有 `pi-acp` | 通过 `pi-acp` | — | 活跃 |

关键观察：
- **Claude Code 和 Codex 是仅有的两家提供"一等公民进程级/协议级编程接口"的**：Claude 有 Agent SDK（但专有许可，见下）；Codex 有 `app-server` JSON-RPC + 官方 Apache-2.0 SDK。这两家**应该走直连适配器**，其余走 ACP。
- **其余所有主流 agent（含 Kimi、OpenCode、Qwen、Cursor、Copilot、Grok、goose、Amp）都原生说 ACP。** 这是 agent-cord "不绑定特定厂商"约束的最强实现路径。
- **`codex app-server` 的 Thread/Turn/Item 三层模型与 `@mosoo/agent-driver` 的 Session/Run/Item、AI SDK Harness 的 session/turn 高度一致**——说明业界已收敛到这套模型，agent-cord 的设计文档应直接采用。

**license 与合规要点（容易被忽略但很关键）：**
- `@anthropic-ai/claude-agent-sdk` 与 `@anthropic-ai/claude-code` 的 npm license 字段都是 `SEE LICENSE IN README.md`，README 声明"**Use of this SDK is governed by Anthropic's Commercial Terms of Service, including when you use it to power products and services that you make available to your own customers**"。同时 Anthropic 明确"**除非事先获批，不允许第三方开发者把 Claude.ai 的订阅限额用于其产品**"。
  - 对 Apache-2.0 的 agent-cord 的含义：**可以**在用户本机以子进程方式驱动用户自己安装并认证的 `claude`；**不可以**把订阅 OAuth 凭据当作自己产品的内置能力分发。设计文档里应显式写明"BYO credential，agent-cord 不代管任何厂商凭据"。
  - 另有品牌限制：基于 Claude 的集成不得自称 "Claude Code"，只可用 "Claude Agent" / "{YourAgentName} Powered by Claude"。
- Codex（Apache-2.0）、OpenCode（MIT）、Kimi Code（MIT）、Qwen Code（Apache-2.0）、ACP 全栈（Apache-2.0）、AI SDK 全栈（Apache-2.0）**均与 agent-cord 的 Apache-2.0 兼容**。
- **HAPI 是 AGPL-3.0，只能读不能抄代码。**

---

### C 组：投票执行器所需的模型 API 层（不要用 Harness 层做投票）

agent-cord 的投票要求是"锁模型版本、temperature=0、结构化输出、盲评"，这**本质是模型 API 调用，不是 agent 运行时**，用 harness 层是严重过度设计（会带上整个 workspace/工具/权限模型）。

| 候选 | 说明 | 匹配度 |
|---|---|---|
| **Vercel AI SDK provider 层**（`ai@7.0.113`，Apache-2.0，26,928★） | 统一多模型网关。**注意：`generateObject`/`streamObject` 在 v6 起已 deprecated**，新写法是 `generateText({ model, output: Output.object({ schema }) })`。已有结构化输出的重试/校验语义 | **直接复用** |
| 各厂商原生 SDK（`@anthropic-ai/sdk` MIT、`openai`、`@google/genai`） | 绕开 AI SDK 抽象时可直连，但要多写 N 套 | 适配后复用 |
| **LiteLLM / OpenRouter** 作网关 | 解决"锁模型版本"：用带日期的 model id（如 `claude-3-5-sonnet-20241022`）+ 统一 key/预算/日志 | **直接复用**（做版本锁定与会话审计的外层） |
| `baml` / `instructor-js` 等结构化输出框架 | 若只需严格 JSON schema 出参，可作 AI SDK 的替代 | 可选 |

**关键提醒**：`temperature=0` 并不保证确定性（多家 API 仍非完全确定），"锁模型版本 + 结构化输出 + 多次投票一致性" 是更可靠的组合。这属于另一条调研线，此处仅标注。

---

### D 组：进程与会话管理基础设施（能不用就不用）

| 库 | 现状 | 建议 |
|---|---|---|
| `execa@10.0.1`（MIT） | 进程执行，超时/取消/stdio 处理 | 若确实要写某家 CLI 的 subprocess 驱动，用这个，不要用 `child_process` 裸写 |
| `node-pty@1.1.0`（MIT） | 伪终端 | **仅作最后兜底**。`coder/agentapi` 的废弃证明 PTY 抓屏路线脆弱；仅在 `agy` 等无结构化接口的 agent 上退化使用（HAPI 也是这么做的） |
| 子进程树清理 | 无统一库 | **必须自研**：Codex 在非交互模式下 MCP 工具调用会因无人审批而被自动取消，"唯一 workaround 是 `--dangerously-bypass-approvals-and-sandbox`"——**这个 flag 绝不能出现在 daemon 里** |

**结论：优先用 JSON-RPC/stdio 结构化协议（ACP、`codex app-server`），把 PTY 降级为最后的兼容层。**

---

### E 组：邻近协议（相关但**不是** AgentDriver 的替代品）

| 协议 | 解决的问题 | 与 agent-cord 的关系 |
|---|---|---|
| **MCP**（`modelcontextprotocol/typescript-sdk@1.30.1`，**MIT**，13,451★，当日更新） | Agent ↔ 工具/资源/上下文 | **不解决驱动问题**，但 agent-cord 需要 MCP client 侧能力（把 workflow gate 校验器暴露成 MCP 工具给 agent 用，或聚合子 agent 的工具）。若要接 "外部 IPC 插件" 校验器，MCP 是比自造 IPC 更省事的选项 |
| **A2A**（Linux Foundation） | Agent ↔ Agent，发现与互调 | 与 agent-cord "多 agent 圆桌" 部分重叠。若未来要做跨组织 agent 互调可关注，现阶段不必 |
| **AG-UI**（CopilotKit，`docs.ag-ui.com`） | Agent ↔ 用户界面，事件流（token 流/工具可视化/中断审批/共享状态 diff） | **对 IM 入口那一条线有参考价值**：agent-cord 需要把 IM 群消息规范化并向外推送结构化事件，AG-UI 的事件分类（17 种事件类型，含 interrupt/approval pause）可作为 `NormalizedEvent` 的设计参考 |

**重要：不要混淆。** MCP 让 agent 用工具，ACP 让宿主驱动 agent，A2A 让 agent 找 agent，AG-UI 把 agent 事件送给界面。agent-cord 的 `AgentDriver` 属于 ACP 这一格。

---

### F 组：本次未深挖但已顺带核实（工作流 / 校验器 / 检索）

这些属于另外的调研线程，仅记录核实结果，避免重复挖：

| 组件 | 库 | License / 版本 |
|---|---|---|
| YAML workflow 图 | `yaml@2.9.1` | ISC |
| CEL 表达式校验（"校验器二级"） | `@marcbachmann/cel-js@8.0.0`（零依赖 JS CEL 实现） | MIT |
| JSON Schema 校验（内置枚举/结构校验） | `ajv@8.20.0` | MIT |
| 状态机（节点状态机） | `xstate@5.33.2` | MIT |
| SQLite FTS5 trigram 中文检索 | SQLite **内置** trigram tokenizer（[sqlite.org/fts5.html](https://sqlite.org/fts5.html)），Node 侧用 `better-sqlite3` / `node:sqlite` | — |

即"Markdown+frontmatter + SQLite FTS5 trigram"的技术选型**有官方依据、无需 embedding**，可以放心写进设计文档。

---

## 3. 造轮子 vs 复用：组件级建议

| agent-cord 组件 | 建议 | 依据 |
|---|---|---|
| `AgentDriver` 抽象接口 | **不造**，复用 `@ai-sdk/harness` 的 `HarnessAgent` 接口契约；若嫌它 experimental，则**对着它的接口形状自研一层薄接口**，实现委托给 ACP | A1 + A2 |
| ACP client / session 管理 | **不造**，用 `@agentclientprotocol/sdk`（Apache-2.0），或直接用 `acpx/runtime`（MIT） | A2 + A3 |
| 41 个 ACP agent 的接入 | **不造**，ACP registry 覆盖 | A2 |
| Claude / Codex 两家直连适配 | **不造**，用 `@ai-sdk/harness-claude-code`、`@ai-sdk/harness-codex`（或 `@agentclientprotocol/claude-agent-acp`、`@agentclientprotocol/codex-acp`）。**注意 Claude 侧许可** | A1 + A2 |
| agent 认证 / 凭据管理 | **不造**，用 agent 自身的 OAuth/device flow；daemon 只传路径与 env | B 组；Anthropic 条款要求 BYO credential |
| 权限放行（gate 的"人工放行"那一半） | **不造协议**，把 ACP `session/request_permission` 桥接到 IM 群审批；但**审批决策状态机要自研** | A2 |
| 子进程生命周期 / 崩溃恢复 / 树杀 | **必须自研**（可基于 `execa`）。没有现成库做这件事，`@mosoo/agent-driver` 的"有界恢复 + 单调生命周期"是最佳参考模型 | A4 + D 组 |
| 投票执行器（k=2~3 盲评、锁版本、temperature=0、结构化输出） | **必须自研**（用 AI SDK provider 层 + `Output.object` 作底座）。没有任何现成库做"多模型盲评 + 一致性判定" | C 组 |
| 证据锚点机验 + Jaccard ≥ 0.5 同源升级 | **必须自研**。无任何现成实现 | — |
| 共识账本 `ledger.yaml` 条目状态机 | **必须自研**。可参考 mosoo 的 Session/Run/Item + Authority/Preview 双层模型 | A4 |
| `events.jsonl` append-only + git union merge | **必须自研**。ACP `session/update` / Codex `app-server` notification 可作为事件源，但规范化与持久化格式要自定 | A2 |
| 工作流 DAG + YAML 定义 + apiVersion | **必须自研**。`acpx/flows` 和 `@ai-sdk/workflow-harness` 可参考（前者是 TS 工作流、后者是可持久 harness 轮次），但"YAML + apiVersion + 三级校验器"是 agent-cord 特有的，无现成实现 | A1 + A3 |
| IM 群适配 / NormalizedEvent | **必须自研**（IM SDK 层用官方 SDK）。AG-UI 的事件分类可作参考 | E 组 |
| MCP client 能力 | **不造**，用 `@modelcontextprotocol/sdk`（MIT） | E 组 |
| 知识库检索 | **不造**，SQLite FTS5 trigram 是内置能力 + `yaml`/`gray-matter` 解析 frontmatter | F 组 |

---

## 4. 复用优先级清单

| 优先级 | 组件 | 动作 | 理由 |
|---|---|---|---|
| **P0** | `@agentclientprotocol/sdk`（Apache-2.0, 1.5.0） | 立即纳入技术选型 | agent-cord 的 AgentDriver 底座；协议 v1 稳定；41 个 agent 已覆盖 |
| **P0** | ACP registry（`cdn.agentclientprotocol.com/.../registry.json`） | 作为 agent 清单的唯一来源 | 避免手工维护 agent 版本/安装方式；小时级自动更新 |
| **P0** | `@ai-sdk/harness` + `-acp` + `-claude-code` + `-codex`（Apache-2.0） | 评估后采纳为接口契约参考；先做 spike 验证 sandbox 假设 | 与 `AgentDriver` 1:1 对应；但 experimental + 假定 sandbox，必须 spike |
| **P0** | "Session/Run/Item + Authority/Preview + 单调状态机" 模型 | 抄进 ADR，不抄代码 | 业界已收敛（Codex app-server、mosoo、AI SDK Harness 三家一致） |
| **P1** | `@openai/codex-sdk@0.156.1` / `codex app-server`（Apache-2.0） | 作为 Codex 的首选集成路径（优于 `codex exec`） | 协议级可控：thread/turn/sandbox/approval/reasoning 全可结构化控制 |
| **P1** | `ai@7` provider 层 + `Output.object`（Apache-2.0） | 投票执行器的底座 | 多模型统一 + 结构化输出；注意 `generateObject` 已 deprecated |
| **P1** | `@modelcontextprotocol/sdk@1.30.1`（MIT） | 作 MCP client + 外部校验器插件通道 | 比自造 IPC 插件协议省事，且生态最大 |
| **P1** | `acpx@0.19.x`（MIT） | 备用方案：若不想自写 ACP client/session owner，用 `acpx/runtime` + `acpx/flows` | 已实现 session owner、permission mode、NDJSON 事件、TS 工作流；但 pre-1.0 |
| **P2** | `execa@10`（MIT）；`node-pty` 仅兜底 | 自研进程管理器时使用 | 无更好选择；PTY 路线已被 agentapi 的废弃证伪 |
| **P2** | LiteLLM / OpenRouter 网关 | 用于"锁模型版本"与会话审计 | 解决 model id 漂移 |
| **P2** | AG-UI 事件分类 | 仅作 `NormalizedEvent` 设计参考 | 不引入依赖 |
| **P3** | `@mosoo/agent-driver`、`caw`、`lite-harness` | **只读源码，借鉴设计** | 三者分别因 Bun-only / Python / 停滞而不适合作依赖 |
| **禁用** | `coder/agentapi` | 不要参考其代码 | 已 archived、路线（PTY 抓屏）错误 |
| **禁用** | HAPI 代码 | 只读（AGPL-3.0 污染） | license 冲突 |
| **需替换** | 设计文档中的 "gemini" 驱动 | 改为 `agy`（Antigravity CLI），或明确限定为 BYO API key 的 gemini-cli | 消费者渠道已于 2026-06-18 停服 |
| **需降级** | 设计文档中的 "aider" 驱动 | 从首版支持列表移除或标为实验 | 维护停滞 + CVE-2026-10175 |

---

## 5. 风险与未决项（建议主 agent 定向决策）

1. **`@ai-sdk/harness` 的 experimental 定位与 sandbox 假设**是本次调研最大的未决项。它接口最贴合，但"all harnesses operate in a sandbox" 与 agent-cord "本地 daemon + 用户本机工作区"的模型可能冲突。**建议先做一个 spike**：用 `@ai-sdk/harness-acp` + `createACP` 包一个 agent（Kimi 或 OpenCode，都有原生 `acp` 子命令），跑通"起 session → prompt → 收 update 事件 → 处理 permission request"，确认 sandbox 是否可绕、事件是否足够喂 `events.jsonl`。
2. **事件模型的粒度损失**：AI SDK Harness 把无对应类型的事件降级为 dynamic tool part。若 `events.jsonl` 要求强类型，可能需要在 adapter 之下再挂一层原始 ACP 事件采集。这会影响"复用 harness 还是直接复用 ACP"的最终选择——**这是 P0 级的架构分叉**。
3. **Claude 侧许可边界**：需要主 agent 确认 agent-cord 的定位是"用户本机 BYO credential 的本地工具"（则驱动 `claude` CLI 无碍）还是"对外分发的产品"（则不得依赖 Claude 订阅额度，且品牌命名受限）。
4. **投票执行器的模型版本锁定策略**（直连各厂商 vs 经 OpenRouter/LiteLLM）没有现成最优解，本次未展开。
5. 本次未核实到的：`agy`（Antigravity CLI）是否有任何编程接口（除 ACP 与子进程外）；`pi --mode rpc` 的协议文档；Factory Droid / Amp / Cline 的直连 SDK 成熟度。这几家目前都通过 ACP registry 覆盖，可以推迟。
