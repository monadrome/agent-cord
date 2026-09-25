# AGENTS.md

> 面向 AI 编码代理的项目说明。读者默认对本项目一无所知。

## 项目概述

**agent-cord** 是一个开源的多 agent 共识协作基座（Apache-2.0）：把「系统应该怎么表现」的每一个结论物化为带证据锚点、可独立复核、可度量的结构化对象。核心机制：

- **共识快照文件夹**（SSOT 的物化形态）：一个需求一个文件夹 `cord/<req-id>/`，内含快照文档（`prd.md` / `adr.md` / `plan.md` / `findings.md`）、共识账本 `ledger.yaml`、append-only 事件流 `events.jsonl`，git 为版本化权威。
- **共识账本**：每条结论是一条带证据锚点的条目，状态机单向流转（`provisional` → `confirmed` → `overturned`），无证据不入账。
- **盲评投票**（子系统代号 conclave）：k=2~3 个异构模型独立盲评、不辩论；2/2 一致且锚点可机验、无锚点重合（Jaccard ≥ 0.5 或子集关系视为疑似同源错误）才放行 confirmed。
- **流程门禁与工作流**：apiVersion 化 YAML 定义有向图，gate 引用 checker 注册表，新增 gate 零代码。
- **事件协议**：EventEnvelope v1（ULID + 血统内 seq + `prev_event_hash` 因果链），单写者原子追加，`ledger.yaml` 由确定性纯函数 reducer 从事件流投影而来。

**当前状态**：M2 最小闭环已实现并提交进 git（约 5600 行 TypeScript，218 个测试用例全绿）：core 事件协议与 reducer、workflow 薄执行器、voting 盲评执行器、driver（ACP/headless）、cord CLI。未实现：IM 适配（飞书）、CEL/外部插件校验器、知识库检索、防腐钩子等（见 `docs/10-roadmap.md`）。`docs/` 是已定稿的方案文档集（13 章 + ADR-0001~0020 + 调研归档），设计与实现状态的权威表述以 README「当前状态与参与方式」为准。

## 技术栈与运行要求

- **语言/运行时**：TypeScript 5.9（strict + `noUncheckedIndexedAccess`），ESM（`"type": "module"`，`module: NodeNext`），Node.js **>= 22.5.0**（`engines` 与 CLI 启动自检均强制）。
- **构建**：`tsc` 输出到 `dist/`（含 `.d.ts` 与 sourcemap），`dist/` 不进 git。
- **测试**：vitest 3，Node 环境，testTimeout 30s。
- **主要依赖**：`zod` v4（schema 即协议）、`yaml`、`ulid`、`execa`（子进程）、`@dagrejs/graphlib`（工作流拓扑）、`ai` v6（Vercel AI SDK，投票 provider 底座）、`@agentclientprotocol/sdk`（ACP 驱动）、`@modelcontextprotocol/sdk`（MCP 插件协议）、`tsx`（开发期跑 CLI）。
- **没有配置 linter / formatter**（无 eslint/prettier），也没有 CI 配置文件。

## 常用命令

```bash
npm run build       # tsc -p tsconfig.json → dist/
npm test            # vitest run（全部测试，当前 218 个用例 / 20 个文件全绿）
npm run typecheck   # tsc --noEmit
npm run cord -- <args>   # 开发期用 tsx 直接跑 src/cli.ts，如 npm run cord -- demo
npx vitest run tests/core/store.test.ts   # 跑单个测试文件
```

CLI（`bin` 名 `cord`，入口 `dist/cli.js`）：`cord init`（初始化 `cord/` SSOT 根，幂等）、`cord new <req-id>`、`cord doctor [--fix]`、`cord demo`（临时目录跑 M2 最小闭环，纯离线只用 MockProvider）、`cord events <req-id>`。

## 代码组织

```
src/
├── core/            # 契约与事件溯源核心
│   ├── schema.ts    # 跨边界数据结构唯一权威（zod）；修改须经 ADR
│   ├── ports.ts     # 模块间接口唯一权威（EventStore / Reducer / ProviderAdapter / AgentDriver 等）；修改须经 ADR
│   ├── hash.ts      # 确定性原语：canonicalJson、内容哈希、哈希链、因果序（纯函数，禁读时钟与随机数）
│   ├── store.ts     # JsonlEventStore：唯一写路径，单写者串行队列 + O_APPEND 原子追加 + fsync
│   ├── reducer.ts   # events.jsonl → ledger.yaml 的确定性纯函数投影；冲突置 conflict=true，不静默择胜
│   ├── session.ts   # cord/<req-id>/ 文件夹句柄；rebuildLedger 是账本唯一重建路径
│   └── doctor.ts    # 事件流与投影的对账（只诊断不修复）
├── voting/          # 盲评投票执行器（ADR-0013：直连模型 API，temperature=0，结构化输出）
│   ├── executor.ts  # 编排：每票独立互不可见、失败重试 1 次、判定与统计、少数派留痕；不做写账本等副作用
│   ├── jaccard.ts   # 锚点独立度（kind + 规范化锚点字符串；line_hint / snapshot 不参与）
│   └── provider/    # mock.ts（脚本化，测试/离线用）与 ai-sdk.ts（真实模型底座）
├── workflow/        # 薄执行器：loader.ts（YAML 加载 + 引用完整性校验）、checkers.ts（内置 checker 注册表，
│                    #   fail-closed：无法判定一律 block）、executor.ts（拓扑推进 + 事件落盘 + 按事件流扫点恢复）
├── driver/          # AgentDriver 实现（ADR-0011/0017）：acp.ts（ACP 直连，第一实现）、
│                    #   headless.ts（裸 headless 降级，execa subprocess）、registry.ts（探测顺序 ACP → headless）
├── adapters/cli.ts  # CLI 入站归一化适配器（与 IM 适配器同一事件模型）
├── cli.ts           # cord CLI：只做薄编排，把命令转成对 core/workflow/voting 公共 API 的调用
└── index.ts         # 库导出入口（CLI / daemon / 库导出是同一核心的三种暴露形式）

tests/               # 目录结构镜像 src/：core/ voting/ workflow/ driver/ cli/ + e2e/
docs/                # 方案文档：01~13 章、adr/（ADR-0001~0020）、research/（2026-09-24 调研归档）、INDEX.md
```

每个模块目录有 `index.ts` 作为公共 API 出口（barrel），模块间只经 barrel 或 `core/ports.ts` 的接口依赖；provider SDK 类型（如 AI SDK 的 `LanguageModel`）不得泄漏出所在模块。

## 开发约定（必须遵守）

- **语言**：代码注释、文档、CLI 输出一律使用**中文**；标识符用英文 snake_case（如 `session_dir`、`prev_event_hash`）。新增代码须保持这一风格。
- **契约权威**：`src/core/schema.ts` 与 `src/core/ports.ts` 是模块间契约的唯一权威，文件头明确标注「修改须经 ADR」。改动这两个文件前必须在 `docs/adr/` 新增或修订 ADR。
- **ADR 引用**：注释中引用设计依据用 ADR 编号（如 `ADR-0020 决策 4`）；20 条 ADR 全部 accepted，但 accepted 不等于已实现。
- **确定性**：`core/hash.ts` 与 `core/reducer.ts` 只放纯函数——同输入同输出，**禁止读时钟与随机数**。
- **单写路径**：一切状态变更只经 `session.events.append`；workflow 执行器等不写任何文件。事件先落盘、落盘成功后才向订阅者派发。
- **fail-closed**：checker 无法判定时一律返回 `block`，不放行；「无证据不入账」对门禁结论同样成立。
- **副作用幂等**：工作流恢复单位是节点，节点副作用（产物写入）与 check（只读可重放）必须幂等。
- **导入路径**：ESM NodeNext，相对导入必须带 `.js` 扩展名（如 `./ports.js`）。
- **文档一致性**：行为变化时同步更新相关 docs 章节与本文件；术语以 `docs/INDEX.md` §3 术语速查为准，不设别名。未经实验校准的参数（投票 k 值、阈值 0.5 等）不得写成已验证结论。
- **git 提交**：`dist/`、`node_modules/`、`cord/.index/`、`cord/**/*.tmp` 不进 git，但 `cord/` 下的文档与事件流是 SSOT 必须入库。

## 测试策略

- 测试与源码同构镜像：`tests/<module>/<file>.test.ts`；vitest include 为 `tests/**/*.test.ts`。
- **离线优先**：测试不发起网络调用。投票一律用 `MockProvider`（可按调用序编排响应、注入失败）；真实 provider 逻辑（`AiSdkProvider`）只测适配层。
- **driver 测试**：用 `tests/driver/fixtures/` 下的假 CLI 脚本（`fake-cli.mjs`、`fake-acp-agent.mjs`）模拟子进程，覆盖超时杀进程树、permission 超时应答等防御路径。
- **e2e**：`tests/e2e/m2-loop.test.ts` 用全部真实实现在临时目录里跑 M2 闭环（init → session → 事件流 → MockProvider k=2 投票 + 真文件锚点机验 → 内置门禁 → reducer 重建账本 → doctor 全绿），并含「执行中途被杀后恢复不重复产生事件」的用例。
- 临时目录统一用 `mkdtemp`，用例间互不干扰；外部副作用（文件写入）一律发生在临时目录内。

## 安全与权限模型

设计基线（docs/09-security.md）：**agent 全程只产 Draft，合入永远人工**。配套硬规则：

- 写操作必经路由（单写路径）；写权限按角色分级（实现 agent 只能写单特性分支，路由机器人不持有仓库凭证）。
- 凭证最小化：secrets 默认不可见、短时效；平台代码不得把凭证写进事件流或账本（事件流进 git，一旦写入即泄露）。
- prompt injection 纵深防御：协调 agent 只持最新快照、事件流永不进 LLM 上下文；判定模型必须与生成模型异构。
- 代码中的具体体现：锚点机验器拒绝逃逸根目录的路径（`createAnchorVerifier` 校验 resolved path 前缀）；ACP 驱动对 permission request 有独立超时且永远应答，不让子 agent 挂死宿主。
- 投票与检查逻辑**不做静默降级**：模型不可用、版本下线、解析失败一律显式记为异常/弃权，由编排层处理。

## 已验证状态（2026-09-24）

- `npm test`：20 个测试文件、218 个用例全部通过。
- `npm run typecheck`、`npm run build`：均通过。
- `npm run typecheck`、`npm run build`：均通过。
- README 与 docs/adr/README.md 的状态表述已与代码现实同步（M2 已实现）。
