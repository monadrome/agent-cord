# 开源实现调研归档（2026-09-24）

> 为 ADR 技术选型提供依据与校准的 7 方向调研原始报告。
> 所有 star 数、版本、license、活跃度均为 2026-09-24 当日通过 GitHub API / npm registry 实测；时效敏感，引用前请复核。
> 三条关键结论附本地复现实验（git union 合并行为、FTS5 trigram 中文边界、并发 JSONL 追加），已回写 ADR-0010 / ADR-0011 / ADR-0015。

---

## 总判断

**外壳组件几乎都有 2026 年的成熟现成实现**（IM 适配、agent 驱动协议、CEL 校验、结构化输出、FTS5 检索、git 事件流），自研量可以压到很低；**核心机制是生态空白**——带证据锚点的共识账本、盲评投票执行器、锚点机验、Jaccard 同源检测、gate 放行语义，没有任何开源项目实现过。所有 llm-council 类项目都是「辩论 + 主席综述」，与本项目的盲评方向相反。独立研究 [spec-compare](https://github.com/cameronsjo/spec-compare) 把这个空白称为 **"The Enforcement Gap"**（spec 写了但没人强制实现遵守它）——差异化成立，但也意味着没有可抄的现成设计。

## 报告清单

| # | 文件 | 主题 | 核心结论 |
|---|---|---|---|
| 01 | [2026-09-24-01-orchestration-workflow-engines.md](./2026-09-24-01-orchestration-workflow-engines.md) | 多 agent 编排与工作流引擎 | 无引擎满足「YAML 图 + gate + 审批暂停 + git/文件为唯一 SSOT」的组合；允许外部状态源的仅 4 个（Vercel Workflow SDK 的 World 适配器最彻底）。编排内核自研，gate 状态机可用 XState v5；Inngest（SSPL）、Restate（BSL）许可排除 |
| 02 | [2026-09-24-02-headless-agent-drivers.md](./2026-09-24-02-headless-agent-drivers.md) | Headless coding CLI 统一驱动 | **ACP（Agent Client Protocol）是 AgentDriver 的标准答案**：协议 v1 稳定、官方 TS SDK（Apache-2.0）、registry 覆盖 41 个 agent；PTY 抓屏路线已被 coder/agentapi 归档证伪。Gemini CLI 消费者渠道停服、Aider 停滞 + CVE（已回写 ADR-0011） |
| 03 | [2026-09-24-03-blind-voting-llm-judge.md](./2026-09-24-03-blind-voting-llm-judge.md) | 盲评投票 / LLM-as-judge | 无现成投票执行器；最同构实现是 builtbyden/ai-council（MIT，盲评 + evidence gate + 确定性共识 + dissent 保留）。Vercel AI SDK + zod 为调用底座；学术证据支持「锚点同源 → 升级人工」（Apple 2026-06：评审面板约 3/4 名义独立性因同源错误丢失） |
| 04 | [2026-09-24-04-event-sourcing-file-ssot.md](./2026-09-24-04-event-sourcing-file-ssot.md) | 事件溯源与文件型 SSOT | 实测推翻两条假设（union 对原地修改产生重复记录 → ledger.yaml 严禁 union；trigram 不支持 2 字中文查询）——已回写 ADR-0010 / ADR-0015。JSONL merge driver 需自研约 100 行（规格参照 spec-kitty issue #569）；Emmett 无 license 不可用 |
| 05 | [2026-09-24-05-gate-dsl-cel-policy-plugins.md](./2026-09-24-05-gate-dsl-cel-policy-plugins.md) | 门禁 DSL / CEL / 策略引擎 / 插件 IPC | CEL 无官方 JS 实现（最大单点依赖风险），选 `@marcbachmann/cel-js` 藏在端口后 + `@bufbuild/cel-spec` 做一致性回归；ADR-0014 的三级校验器与 k8s/Kyverno/Cerbos 同构；CNCF Open Workflow Specification 可借事件词表；插件 IPC 用 MCP 或 stdio JSON-RPC，勿自造协议 |
| 06 | [2026-09-24-06-im-bot-adapters.md](./2026-09-24-06-im-bot-adapters.md) | IM 机器人适配层 | Vercel Chat SDK（`chat`，MIT）+ 飞书官方 `@larksuite/vercel-chat-adapter`（WS 长连接、免公网）使 NormalizedEvent 层接近零自研；缺口：Chat SDK 无 SQLite StateAdapter（自研，合理边界）、飞书 slash command 需 `onNewMessage(/^\/cord/)` 兜底 |
| 07 | [2026-09-24-07-similar-projects-landscape.md](./2026-09-24-07-similar-projects-landscape.md) | 类似需求与竞品全景 | OpenSpec（★70k，目录形态最像）、spec-kit（★138k，术语权威）、Beads（账本机制最强参照）、Kiro Crew（daemon 分层镜像）、AgentTeams（IM 房间=会圆桌的唯一落地）、HumanLayer（审批门禁最成熟，可复用「升级人工」通道） |

## P0 复用清单（跨报告汇总）

- **AgentDriver 协议层**：ACP + `@agentclientprotocol/sdk`（Apache-2.0）；非 ACP 的 CLI 保留裸 headless 降级驱动
- **IM 层**：`chat`（MIT）+ `@larksuite/vercel-chat-adapter`（飞书官方，vendored 锁版本）
- **投票执行器底座**：Vercel AI SDK + zod（`generateText` + `Output.object`；`generateObject` 自 v6 deprecated）
- **CEL**：`@marcbachmann/cel-js`（MIT）藏在 `ExpressionEvaluator` 端口后；`@bufbuild/cel-spec` 做一致性回归
- **YAML/schema**：`yaml`（eemeli，保注释键序）+ zod 4（`z.toJSONSchema()` 双产出）+ ajv
- **git/文件**：simple-git（自定义 merge driver 必须走系统 git）、chokidar、write-file-atomic、execa
- **检索**：better-sqlite3 + FTS5（或 Node ≥22.5 内置 `node:sqlite`），中文检索策略层自研（见 ADR-0015 校准）
- **升级人工通道**：HumanLayer（Apache-2.0，适配后复用）

## License 雷区（Apache-2.0 项目必须避开）

- **禁用**：Inngest（服务端 SSPL）、Restate（BSL 1.1）、Arize Phoenix（Elastic License 2.0）、Dagu / spec-workflow-mcp（GPL-3.0）、HAPI / AstrBot（AGPL-3.0）、Emmett（无 license，作者明示未来 AGPL/SSPL）、karpathy/llm-council（无 LICENSE，只能读思路）
- **谨慎**：Anthropic Claude SDK/Code 为专有许可——仅作用户本机 BYO 凭证的可选适配器，不进核心依赖树；Mastra 的 `ee/` 目录另有许可；minimatch 10.x 为 BlueOak-1.0.0（用 picomatch）
- **退路**：ledger 合并冲突若失控，Dolt（Apache-2.0，Beads 已验证）是换底座方案，代价是放弃纯文件约束

## 最该精读的公开实现

1. [builtbyden/ai-council](https://github.com/builtbyden/ai-council)（MIT，TS）——盲评 + evidence gate + 确定性共识 + dissent 保留，与本项目最同构
2. [wake](https://github.com/nelsonwerd/wake)（Apache-2.0，Go）——corruption-evident 事件日志 + 纯归约回放，与 events.jsonl 设计最同构
3. [spec-kitty issue #569](https://github.com/Priivacy-ai/spec-kitty/issues/569)——JSONL merge driver 的现成规格书
4. [OpenClaw Channel Plugin 契约](https://docs.openclaw.ai/plugins/sdk-channel-plugins)——插件 vs 核心的职责划分范本

## 待拍板项（调研留给设计层的开放问题）

1. `@ai-sdk/harness`（与 AgentDriver 1:1 对应但 experimental + 假定 sandbox）vs 直接用 ACP——需 spike 验证
2. Vercel Workflow SDK 自定义 World 能否落在 cord 目录 + git——需 spike 验证
3. 是否整体采纳 CNCF Open Workflow Specification 作为工作流 DSL 基底（其 TS SDK 仍是 alpha）
4. 外部校验器插件协议：MCP vs 自定义 stdio JSON-RPC
