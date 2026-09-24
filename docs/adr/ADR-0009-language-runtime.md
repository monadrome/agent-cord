# ADR-0009 ｜ 语言与运行形态：TypeScript + 常驻 daemon 核心 + 薄 CLI

- 状态：accepted（设计定稿，代码未实现）
- 日期：2026-09-24
- 关联：ADR-0010（SSOT 存储，daemon 必须无状态可重放）、ADR-0011（agent 运行时）、ADR-0012（事件与 IM 适配）、ADR-0016（分发与插件）
- 来源：本方案技术选型调研（2026-09，内部调研纪要）——语言生态 + 运行形态

## 背景

本项目不是一个「agent 内核」，而是一个**编排与共识层**。它要做四件事：

1. **文件监听**——文档防腐、快照同步；
2. **长流程状态管理**——全局 session 状态机、投票留痕、门禁编排；
3. **IM webhook / 长连接接收**——飞书、Slack、Discord，以及纯 CLI 模式；
4. **驱动子进程 CLI**——headless 模式驱动各家 coding CLI 执行任务。

因此语言问题的本质不是「哪个语言最适合写 agent」，而是**哪个语言的生态对「编排层 + CLI 驱动层」最友好**；形态问题的本质是「webhook 接收与文件监听要求常驻进程，但 dogfooding 与开源传播要求低门槛入口」这组矛盾怎么解。

评估维度收窄为四条硬约束：

1. 驱动各家 headless CLI 的 SDK / 编排生态；
2. 结构化 schema 定义与校验能力（账本条目、agent/gate 配置的 schema 是**协议本体**，是这个平台真正的资产）；
3. 开源贡献者生态（平台靠社区热插拔 agent/gate 活下去）；
4. 长进程 IO 密集负载的稳定性（本项目不是 CPU 密集型负载）。

## 备选方案

### 语言备选

**A. TypeScript（Node.js）**

- **是什么**：Node 运行时 + npm 生态。
- **优点**：① AI CLI 工具链的第一现场——Claude Code 本体是 TypeScript，其官方 SDK 的 reference 实现是 TS；Gemini CLI 是 TS；MCP 的官方 reference SDK 是 TypeScript。驱动子进程、解析流式 JSON 输出的现成代码最多。② schema 能力：Zod 是 TS 事实标准，且 TypeScript 的类型系统本身让「协议定义」同时是「代码类型」，运行时校验与编译期检查一份代码同源。③ IM 适配层：飞书、Slack、Discord 三家官方 SDK 均有 TS 第一维护版本（Bolt、discord.js 原生 TS）。④ 贡献者生态：可视化编排/自动化类头部开源项目（n8n、Flowise、Langflow、LobeChat）全部选 TS，说明这个领域的目标贡献者池在 TS。
- **缺点**：长进程的内存足迹与单线程模型需要纪律（async 泄漏、未捕获异常可拖垮整个 daemon——而路由机器人已是识别出的单点，这个风险真实存在）；无静态二进制分发，部署依赖 Node 版本（可用 bun compile / Node SEA 缓解，但不主流）。
- **契合度**：最高。四条硬约束里三条（CLI 驱动、IM 适配、贡献者生态）直接命中，schema 维度与 Zod 满分对齐。

**B. Python**

- **是什么**：Python 3 + asyncio 生态。
- **优点**：LLM 框架生态的正中心（LangGraph / AutoGen / CrewAI / OpenHands 均 Python 一维护）；Pydantic 的 schema 能力与 Zod 同级；有「Python server + headless CLI + SDK」的成熟先例（OpenHands）；实验统计脚本（κ 系数、回放）天然在 Python。
- **缺点**：被驱动的对象（claude code、codex、gemini CLI）的 SDK 与生态主场不在 Python，驱动层胶水代码更多；打包分发与版本碎片化（venv/poetry/uv）对「开源基座降低接入门槛」不利；类型系统弱于 TS，协议 schema 与代码类型是两套东西，演进一致性靠纪律。
- **契合度**：高，第二选择。若团队 Python 浓度极高可选，但需要为驱动层付额外胶水成本。

**C. Go**

- **是什么**：Go 生态。
- **优点**：长进程稳定性最强（goroutine 模型、单文件交叉编译分发）；`os/exec` 驱动子进程心智负担最低。
- **缺点**：LLM/agent 生态最薄——MCP Go SDK 进入 Tier 1 较晚且为共建；LangGraph 等无 Go 版；IM SDK 的 Go 版本维护活跃度弱于 TS/Python；schema 表达（无泛型 enum 变体、需手写 validator）在三者中最差；AI 应用层的贡献者池明显小于 TS/Python。
- **契合度**：低。本项目是 IO 编排而非高并发服务，Go 的核心优势（单文件部署、并发吞吐）用不上，而它的短板条条命中硬约束。

**D. Rust**

- **是什么**：Rust 生态。
- **优点**：有「某 CLI 从 TypeScript 重写为 Rust」的成功先例（启动快、零依赖安装、OS 级沙箱）——但那是**面向终端用户的单 agent 工具**的选型逻辑；单二进制分发、内存安全、长进程不泄漏。
- **缺点**：迭代速度最慢（协议层在实验期必然高频重构，Rust 重构成本最高）；agent 编排生态最薄；贡献者门槛最高——而本平台的生死线是「新增 agent/gate 零代码、社区贡献配置与插件」，贡献者池直接决定生态。
- **契合度**：最低。Rust 解决的是「亿级用户分发 + 启动延迟 + 安全沙箱」，不是本项目的问题（协议实验 + 编排胶水 + 社区贡献）。

### 运行形态备选

**A. 纯 CLI 工具**：一次性命令、跑完退出。
- **缺点**：**直接否决项**——IM 事件接收与文件监听要求常驻进程，纯 CLI 形态物理上无法承载翻译层与 watcher。它可以作为前端壳存在，不能是全部。

**B. 常驻 server（daemon）**：单一常驻进程承载 webhook、watcher、session 状态机、子进程编排。
- **优点**：状态一致性最简单（单进程内存态 + 快照文件夹落盘）；事件分发天然进程内。
- **缺点**：无入口面，开发者无法手动触发（「给我跑一遍回放实验」），dogfooding 不便；对开源传播不友好（「装一个永远跑着的进程」门槛高于「装个 CLI」）。

**C. SDK 库**：只做库，入口由使用方写。
- **缺点**：平台的核心用户（协作群里的产品/开发）不是程序员，没有「使用方」会替你写入口；SDK 形态等于把形态决策推给用户，与「平台」定位矛盾。SDK 可以作为同一核心的另一种暴露形式存在，不能是主形态。

**D. IDE 插件**：VS Code / JetBrains 扩展。
- **缺点**：本项目交互面是 IM 群聊 + CLI，不是编辑器；对本项目零增益，纯分散精力。可作远期可选入口，不进入主选型。

**E. 混合：常驻 daemon（核心）+ CLI（客户端/调试入口）**
- **是什么**：单一核心逻辑以常驻进程运行（IM 接收、文件监听、session 状态机、投票编排、驱动子进程）；CLI 是通过本地 IPC/HTTP 与 daemon 通信的薄客户端，同时承担初始化、手动触发、调试、实验脚本入口。
- **优点**：同时满足「常驻」与「有可触达的入口」；CLI 极薄（复用核心暴露的同一套接口），维护成本近似纯 daemon；有成熟先例（自动化编排类工具的 daemon + webhook 触发器形态、某开源 agent 项目的 server + headless CLI + SDK 形态）。
- **缺点**：多一个进程间接口面，需要一开始定义好本地 API 边界，否则 CLI 与 daemon 各自演化成两套逻辑。

## 决策

**语言：TypeScript（Node LTS）。形态：常驻 daemon 为核心 + 薄 CLI 客户端（本地 IPC/HTTP），核心代码同时以库形式导出（SDK 是副产品而非独立形态）。**

配套决定：

1. 驱动层抽象为统一接口（`AgentDriver`，见 ADR-0011），不依赖任何一家的 SDK 专有特性。
2. daemon 必须设计成**无状态可重放**：状态全部落在快照文件夹（SSOT），daemon 重启 = 从文件夹重放恢复，不维护不可重建的内存态。
3. daemon 与 CLI 之间用本地 HTTP（localhost 端口 + token 文件）或 Unix socket 通信，接口即核心模块的函数签名。
4. 实验统计脚本（回放、κ 系数等）允许用 Python 独立实现，通过 daemon 的本地 HTTP 接口取数，但**必须写成只读客户端**，禁止写路径。
5. 分发走 npm 全局安装，并提供 devcontainer/Docker 示例兜底无 Node 环境；暂不做单二进制，`bun compile` 留作远期选项（详见 ADR-0016）。

## 理由（第一性原理推导）

1. **从「驱动子进程 CLI」出发**：被驱动对象的 SDK 与社区自动化脚本的主场在 TS；驱动层的输出解析（JSON 流、事件流）是高频改动区，离生态主场越近成本越低。
2. **从「协议本体 = schema」出发**：agent/gate/账本条目/投票记录的 schema 是这个平台唯一真正的资产。TS + Zod 让「协议定义」同时是「代码类型」，演进一致性由编译器保证——在协议高频重构期这是最大的工程杠杆。
3. **从「常驻 + 需要入口」出发**：daemon 是唯一满足常驻要求的形态；CLI 薄客户端同时服务 dogfooding（平台管理自己的开发）与开源传播。SDK 不是独立形态，是核心以 package 导出的副产品——因此不需要为「SDK 形态」单独付设计成本。
4. **从「开源基座的生死线是贡献者」出发**：可视化编排/自动化类头部开源项目全部 TS，目标贡献者池在 TS；而「新增 agent/gate 零代码」意味着平台代码量不大但协议演进快，语言必须服务**快速迭代**而非运行时性能。本项目负载是 IO 编排，Node 事件循环完全够用。
5. **从「不用为省毫秒牺牲隔离」出发**：运行时的第一职责是让独立性可机验、可审计（ADR-0006、ADR-0011），而不是压榨进程开销。语言与形态的选型不应引入任何削弱隔离或可审计性的简化。

## 被否方案的否决理由（逐一）

- **纯 Python 整体选型**：不是错误而是次优。否决理由集中于驱动层——被驱动 CLI 的生态主场不在 Python，胶水成本长期存在；分发与版本管理摩擦与「开源基座低门槛接入」冲突。保留余地：实验统计与回放工具可用 Python 独立编写，进程边界清晰，不构成语言分裂（见决策第 4 条）。
- **Go**：LLM/agent 生态与 schema 表达能力不满足硬约束①②③；本项目无高并发与单文件分发诉求，Go 的优势场景空转。
- **Rust**：其选型前提是「亿级分发的终端单 agent 工具」，与本项目「协议实验 + 编排胶水 + 社区贡献」的痛点不重叠；迭代速度与贡献者门槛是致命伤而非可容忍项。
- **纯 CLI 形态**：物理上无法承载 IM 事件接收与文件监听，一票否决。
- **纯 SDK 形态**：把入口决策推给非程序员用户，与平台定位矛盾；且没有任何常驻能力。
- **IDE 插件形态**：交互面在 IM 群聊与 CLI，IDE 插件零增益。
- **纯 daemon 无 CLI 客户端**：缺手动触发与调试入口，dogfooding 与反复手动回放实验不可行。
- **单二进制优先（bun compile / Node SEA 作为主分发通道）**：不作为当前主通道。它解决的是「用户没有 Node」的问题，而目标用户（开发者团队、CI 镜像）几乎必有 Node；先走 npm 与 Docker 两条通道，单二进制留作远期补充。

## 关键实现注意点

1. **进程模型与崩溃隔离**：Node 单线程意味着解析器异常可拖垮整个 daemon（路由机器人是已识别的单点）。措施：daemon 内按需求隔离子进程（投票 agent、被驱动的 CLI 本就以子进程运行）；daemon 本体启用严格的未处理拒绝策略（进程级异常直接退出而非吞掉）+ 进程守护交由用户侧选择（平台只提供核心二进制与 Docker/容器化示例）；状态全部落快照文件夹，重启即重放恢复——这与 ADR-0010「SSOT 是快照文件夹」天然对齐。
2. **驱动子进程的接口边界**：对各家 CLI 的驱动抽象为统一接口（`spawn(prompt, context) → event stream`，见 ADR-0011）；各家 headless 输出格式不稳定、版本间存在 breaking change，**必须做版本探测与格式适配层**，并把「适配器版本 × CLI 版本」兼容性矩阵写进 README。原则：不解析人类可读输出，只用官方 machine-readable 模式。
3. **本地 IPC 边界先行**：CLI 与 daemon 的接口就是核心模块的函数签名，保证 CLI 永远不承载业务逻辑，避免双端漂移。
4. **文件监听的已知坑**：大仓库/高频 git 操作下有事件风暴问题——防腐钩子触发必须做去抖（debounce），并**以 git diff 为最终判据**（watcher 只作触发信号，锚点求交永远跑在 git 数据上），避免监听事件与文件真实状态竞争。
5. **schema 版本化**：Zod schema 随快照文件夹版本化演进（schema 带版本字段，读写双向兼容一个版本）。账本条目是长期资产，schema 升级不可避免——这是「文档带版本」共识在代码层的落实。
6. **实验脚本的异构边界**：允许 Python 统计工具通过本地 HTTP 取数，但必须是只读客户端；写路径一律禁止，防止第二套写逻辑绕过 `append_event`（ADR-0010）。
7. **分发与运行环境**：npm 全局安装 + Docker 示例兜底；声明 `engines.node` 并在 CLI 启动时自检（详见 ADR-0016）。
8. **与「不绑定厂商」的关系**：语言选型本身不构成厂商绑定——绑定面收敛在适配器文件（IM 适配器、provider 适配器、CLI 适配器）中，替换任一适配器不影响核心。

## 证据来源

1. 本方案技术选型调研（2026-09，内部调研纪要）：语言备选四维对比与运行形态 A–E 对比、推荐与推导链、被否理由、实现注意点。
2. 可视化编排/自动化类头部开源项目的语言分布（n8n = TypeScript，与 Python 后端的编排平台架构对比）：https://juejin.cn/post/7643731344673701929
3. 「server + headless CLI + SDK」形态的成熟先例：OpenHands SDK 架构文档 https://docs.openhands.dev/sdk/arch/overview ；v1 路径公告 https://www.openhands.dev/blog/the-path-to-openhands-v1
4. 某 CLI 从 TypeScript 重写为 Rust 的报道（说明该选型针对终端单 agent 工具的诉求）：https://www.devclass.com/ai-ml/2025/06/02/nodejs-frustrating-and-inefficient-openai-rewrites-ai-coding-tool-in-rust/1619589 ；headless exec 模式实践 https://www.deployhq.com/blog/getting-started-with-openai-codex-cli-ai-powered-code-generation-from-your-terminal
5. MCP 官方 SDK 的语言分层与生态采用数据（TS/Python 为第一梯队）：https://o-mega.ai/articles/build-a-remote-mcp-server-2026-guide ；https://mcpgate.de/blog/mcp-explained/
6. CLI agent harness 横评（hooks / subagents / SDK 的可扩展面）：https://blog.yeyupiaoling.cn/article/1785427966230?lang=en
7. 项目内部：方案提案 §5（三层架构与单机器人路由）、§9.5（安全模型）；工作清单 W1.3（全局 session 存储：事件溯源、可中断恢复）、W1.4（事件路由总线）；配套调研（2026-09）Q1。
