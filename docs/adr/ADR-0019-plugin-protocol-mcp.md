# ADR-0019 ｜ 外部校验器插件协议：MCP over stdio，不自造线协议

- 状态：accepted（设计定稿，代码未实现）
- 日期：2026-09-24
- 关联：ADR-0016（分发与插件机制——本 ADR 把其「外部进程 IPC 插件 + 协议 v1 冻结」落定为具体协议）、ADR-0014（三级校验器的第 3 级）、ADR-0017（AgentDriver 的 ACP，同属 JSON-RPC 族）
- 来源：开源实现调研（2026-09-24，[docs/research/2026-09-24-05](../research/2026-09-24-05-gate-dsl-cel-policy-plugins.md)）；2026-09-24 人工拍板

## 背景

ADR-0016 已定：层 3 插件是外部进程、IPC 装载、协议 v1 冻结为 `check` / `capabilities` / `health` 三类消息、握手先交换 `protocolVersion`。留白的是**传输与线协议**：自造一套 stdio JSON-RPC 协议，还是复用现成协议。

2026-09-24 调研的两个关键事实：① MCP（Model Context Protocol，Linux Foundation）官方 TS SDK（`@modelcontextprotocol/sdk`，MIT）成熟且生态最大，本身就是「stdio/HTTP 上的 JSON-RPC + 能力协商 + 结构化工具入参出参」；② k8s KRM Functions 提供了「校验器」单一职责的契约范本——插件是「读 STDIN 的 ResourceList、写 STDOUT 的 ResourceList」的任意程序。同时 ACP（ADR-0017）也是 JSON-RPC 族，本项目已有协议收敛的压力与机会。

## 备选方案

### 备选 A：自造 stdio JSON-RPC 协议

- **是什么**：用 `vscode-jsonrpc` 承载，自定义 `initialize` 握手与 `check` / `capabilities` / `health` 方法。
- **优点**：协议面最小、语义完全贴合「校验器」单一职责；无生态概念包袱。
- **缺点**：握手、版本协商、能力发现、错误码全要自研自测；任何现成工具都无法直接当校验器，插件生态从零开始。
- **契合度**：中。

### 备选 B：MCP over stdio（选定）

- **是什么**：插件即 MCP server；`check` / `capabilities` / `health` 映射为 MCP 工具，`initialize` 握手天然承载 `protocolVersion` 协商；契约形状借 KRM Functions 的「ResourceList in/out」——输入是 gate 上下文包（产物描述 + 触发器证据 + 锚点），输出是 ADR-0016 已定型的 `{result: pass|block|warn, anchors, reason, confidence}`。
- **优点**：协议、SDK、握手、版本协商零自研；任何现成 MCP server 理论上都能当校验器，生态白拿；与 ACP 同属 JSON-RPC 族，平台整体协议数量减一。
- **缺点**：MCP 语义是「工具调用」而非「纯函数校验」，需在协议层显式约束校验器的纯函数语义（见注意点 1）；MCP server 的任意性带来安全面（沿用 ADR-0016 的凭证与最小权限机制兜底）。
- **契合度**：最高。

### 备选 C：HTTP 服务插件

- **是什么**：插件是 HTTP 服务，宿主 POST 校验请求。
- **优点**：天然支持远程校验器（企业内 CI 平台等）。
- **缺点**：引入服务生命周期管理（端口、健康检查、鉴权），与「本地优先、子进程模型」不符。
- **契合度**：低；作为可选远程传输保留（MCP 本身支持 HTTP 传输，届时零协议变更）。

## 决策

**外部校验器插件协议 = MCP，默认传输 stdio；HTTP 传输为可选远程形态；不自造线协议。**

1. **消息映射**：`check` → `tools/call`（入：gate 上下文包；出：ADR-0016 已定型的三态结果结构）；`capabilities` → MCP 原生 `tools/list` + 插件自描述；`health` → MCP `ping`；握手版本协商 → `initialize`。
2. **契约形状照抄 KRM Functions**：插件是「读标准输入的上下文包、写标准输出的判定结果」的纯程序；宿主负责拉起、超时、杀进程。
3. **`vscode-jsonrpc` 不作协议形态**，仅可作为底层库的备选（MCP SDK 内部同为 JSON-RPC 族）。

## 理由（第一性原理推导）

1. **协议的价值在网络效应，不在表达力**。自造协议（A）能把语义裁剪到最贴，但插件生态的冷启动成本全部由我们承担；MCP 让「已有 MCP server 直接成为校验器」成为可能，这是 ADR-0016 冷启动策略（官方插件集 + 模板市场）之外的第三条供给来源。
2. **协议数量是复杂度税**。平台已有 ACP（驱动 agent）与本地 IPC（daemon ↔ CLI）两族协议；插件协议再自造一套，就是第三种 JSON-RPC 方言。选 MCP 后，插件与 agent 驱动共享同一族心智模型与调试工具。
3. **握手与版本协商是协议设计里最易错的部分**（ADR-0016 要求 v1 冻结 + N-1 兼容）。MCP 的 `initialize` 已把能力协商、版本交换做成标准动作，自研等于重造最易错的环节。
4. **从「校验器是纯函数」反推约束位置**：MCP 不保证工具无副作用，所以纯函数约束必须由我们在协议层显式声明（标注 + 宿主不依赖副作用），而不是寄希望于插件自觉——这与「禁止互见中间推理由编排层强制而非提示词约束」（ADR-0013）是同一原则。

## 被否方案的否决理由（逐一）

- **备选 A（自造 stdio JSON-RPC）**：否决于协议设计成本前置且生态从零；其「语义最贴合」的优点由 MCP 之上的薄约束层获得。
- **备选 C（HTTP 优先）**：否决于服务生命周期管理与本地优先形态冲突；保留为 MCP 的可选传输。
- **「Extism / WASM 插件」**：否决于其 JS SDK 长期停在 rc 且维护停滞（调研实测）；沙箱化插件属远期增强，届时可再起 ADR。
- **「插件直接读快照文件夹」**：否决——插件只拿宿主注入的上下文包，不持有文件系统路径（沿用 ADR-0016 的最小权限结构保证）。

## 关键实现注意点

1. **纯函数语义显式化**：插件清单中标注 `sideEffect: false`；宿主侧把校验器输出视为唯一结果，不读取、不信任插件的任何外部副作用；需要副作用的集成（如写回 CI 状态）走单独的事件类插件，不与校验器复用同一契约。
2. **超时与三态沿用 ADR-0016**：子进程强制超时（默认 60s，gate 可覆盖），超时按「升级人工」处理；`warn` 必须留痕。
3. **安全面不扩张**：凭证注入仍按 ADR-0016（环境变量 / 短时效 token，禁 stdin 明文长期密钥）；MCP server 的来源受模板市场「显式 add + 锁定 commit/tag」约束。
4. **官方插件集同样走 MCP**（ADR-0016 决策 7 的落实）：不允许官方插件使用进程内私有 API。
5. **fixtures 可测性**：`tools/call` 的入出参以 JSON fixtures 落仓库，回放实验与插件测试复用同一机制（沿用 ADR-0016 注意点 9）。
6. **协议族归一**：daemon ↔ CLI 的本地 IPC 优先采用 JSON-RPC（vscode-jsonrpc），与 ACP / MCP 保持同族，减少协议数量。

## 证据来源

1. 开源实现调研归档（2026-09-24）：MCP / KRM Functions / vscode-jsonrpc / Extism 的逐项评估与「不要自造协议」结论：[docs/research/2026-09-24-05-gate-dsl-cel-policy-plugins.md](../research/2026-09-24-05-gate-dsl-cel-policy-plugins.md)
2. MCP 官方 TS SDK：https://github.com/modelcontextprotocol/typescript-sdk （MIT）
3. KRM Functions 契约范本（ResourceList in/out）：https://github.com/kptdev/krm-functions-sdk （Apache-2.0）
4. hashicorp/go-plugin 与 Terraform provider protocol（进程插件握手与版本协商的黄金参照，仅借思路）：https://github.com/hashicorp/go-plugin （MPL-2.0）
