---
title: IM 机器人适配层
date: 2026-09-24
type: research-archive
status: 调研结论均为 2026-09-24 当日实测，时效性敏感（star 数、版本、license 可能变化）
---

我已完成调研。以下是报告。

---

# IM 机器人适配层 · 开源可复用实现调研

**调研日期**：2026-09-24 ｜ **方法**：GitHub API（`gh`，已鉴权）、npm registry 实测、官方文档抓取、npm tarball 源码解包核验

---

## 0. 核心结论（先看这个）

**agent-cord 想自研的「NormalizedEvent + 多 IM 统一抽象」，在 TypeScript 生态里已经有成熟实现，不需要自研。**

决定性发现：Vercel 在 2026-02 开源的 **Chat SDK**（npm 包名 `chat`，MIT），提供的就是「一套 handler 跑多平台」的统一事件模型 + Adapter 接口；而 **飞书官方在 2026-05 发布了该 SDK 的正式适配器** `@larksuite/vercel-chat-adapter`，基于飞书官方 `@larksuiteoapi/node-sdk`，走 WebSocket 长连接（**本地 daemon 不需要公网 IP**）。

也就是说，agent-cord 的「群=圆桌、单机器人路由、@提及」这三件事，**开箱即用地落在现成组件上**，第一阶段应有的自研量接近零。

---

## 1. 统一抽象层 / NormalizedEvent 先例（本次调研的主战场）

### 1.1 ⭐ Vercel Chat SDK（`chat`）

| 项 | 内容 |
|---|---|
| 仓库 | [vercel/chat](https://github.com/vercel/chat) |
| License | MIT |
| 活跃度 | **2,384★ / 316 fork / 120 contributors / 37 open issues**；创建 2025-12-22；最后提交 2026-09-22；npm `chat@4.41.0`（2026-09-18），84 个版本、近乎周更 |
| 提供什么 | `Chat` 类统一持有事件生命周期；`onNewMention` / `onSubscribedMessage` / `onNewMessage(regex)` / `onReaction` / `onAction` / `onSlashCommand` / `onMessageUpdated` / `onMessageDeleted`；`Thread`（`post` / `subscribe` / `setState` / `stream` / `allMessages`）、`Channel`、规范化 `Message`（text + mdast AST + author + attachments）；JSX 卡片跨平台渲染（Block Kit / Adaptive Cards / 飞书卡片）；AI streaming；模态框；内建去重、per-thread 锁、消息并发策略（burst/queue/debounce/drop） |
| Adapter 生态 | 官方 `@chat-adapter/*`：Slack、Teams、Google Chat、Discord、Telegram、Gmail、GitHub、Linear、Notion、WhatsApp、Messenger、Instagram、X、Web。Vendor-official 含**飞书**、Matrix(Beeper)、Resend、Novu 等。Community 含 **WeCom（企业微信）、Weixin、QQ、Mattermost、LINE、Webex** 等 |
| **匹配度** | **直接复用（第一阶段抽象层）** |

**为什么它几乎是为 agent-cord 定制的**：Chat SDK 的路由顺序是「DM → 已订阅 thread → @提及 → 正则模式」。映射到 agent-cord：

- 「群 = 圆桌」→ `Channel`（`channelId`）
- 「圆桌成员」→ `thread.subscribe()`（订阅后持续参与，未订阅时靠 @提及触发）
- 「单机器人路由」→ `onNewMention` 作为唯一入口，机器人自身消息被自动过滤，不需要自己写 `isMe` 过滤
- 「会话状态」→ `thread.setState()` + `StateAdapter`

**必须知道的代价**：

1. **v4.x 快速迭代**，周更，无 LTS 承诺；weekly release 意味着升级成本是常态。
2. **`StateAdapter` 是必需项**，官方只有 memory / Redis / ioredis / PostgreSQL，社区有 MySQL / Cloudflare Durable Objects / Cloudflare Agents。**没有 SQLite adapter**（我实测 `@chat-adapter/state-sqlite`、`@chat-adapter/state-postgres` 中前者不存在）。对「本地优先、文件+git 为 SSOT」的 agent-cord 来说，需要**自研一个 StateAdapter**（订阅、锁、去重、thread state、transcript）——这部分反而是自研的合理边界，因为它正好是 agent-cord 定义里的「派生数据」而非 SSOT。
3. 设计取向偏 serverless（webhook + 分布式锁）。但它同时支持长连接模式（飞书 WS、Slack Socket Mode、Discord Gateway），长驻 daemon 完全可用。

### 1.2 ⭐ `@larksuite/vercel-chat-adapter`（飞书官方适配器）

| 项 | 内容 |
|---|---|
| npm | `@larksuite/vercel-chat-adapter@0.3.0`（2026-09-14），MIT，5 个版本（2026-05-14 首版） |
| 仓库 | package.json 声明 `github.com/larksuite/vercel-chat-adapter`，**但该地址 GitHub 返回 404（源码仓库当前不可公开访问）** |
| 作者 | `mazhe.nerd@bytedance.com`（字节员工） |
| 官方文档 | [chat-sdk.dev/adapters/vendor-official/lark](https://chat-sdk.dev/adapters/vendor-official/lark) ｜ [Vercel changelog](https://vercel.com/changelog/chat-sdk-adds-lark-feishu-support) |
| 提供什么 | WebSocket 长连接事件订阅（**webhook 模式未实现，`handleWebhook()` 返回 501**）；基于 `@larksuite/channel` 的 23 种消息类型归一化；原生 cardkit 打字机流式输出；交互卡片、按钮回调、表情回复；消息历史 `fetchMessages` / `listThreads`；QR 扫码一键建应用 `registerLarkApp` |
| **实测源码核验**（我解包 tarball 确认） | 依赖 `@larksuite/channel@0.7.1` + `chat@^4.26.0`；调用 `chat.processMessage` / `processAction` / `processReaction`；**未调用 `processSlashCommand`** |
| 明确不支持 | **Slash commands（README 功能表 "Slash commands \| No"）**、Modals、typing indicator（飞书无此 API）、ephemeral、`postChannelMessage`、Webhook 传输、多租户 `setInstallation()` |
| **匹配度** | **直接复用（第一阶段飞书入口）**，slash command 需自行补齐 |

两个关键工程细节（从 d.ts/js 读出，非文档转述）：

- **threadId 编码为 `lark:{chatId}:{rootId}`**，`rootId` 优先取 `root_id`，否则用 `message_id`（即顶层消息自己成根）。刻意**不用**飞书原生 `thread_id`（`omt_*` 是话题容器 ID，作 `replyTo` 会报 `format_error: Invalid ids`）。代码里 `rootId` 为空时不下发 `replyTo`，因此**「在群里发一条新顶层消息」实际可行**（文档功能表标的 `postChannelMessage: No` 指的是 Chat SDK 的 channel 级抽象，不是物理能力）。
- **`isDM()` 有冷启动缺陷**：飞书 p2p 群和普通群 chat_id 同为 `oc_*` 前缀，DM 判定靠入站事件填缓存，进程重启后第一条 DM 可能被误路由到 `onNewMention`。agent-cord 若做 DM 入口需要自己兜一层。

> ⚠️ **风险提示**：该包 npm 上公开可用、LICENSE 完整，但**源码仓库 404**（公开不可审计）。agent-cord 是 Apache-2.0 开源项目且强调可审计性，建议：① 把 npm tarball vendored 进仓库并锁定版本；② 向飞书提 issue 要求开放仓库；③ 评估 fork 维护成本（dist 50KB，薄 shape-translator，fork 门槛低）。

### 1.3 ⭐ `@larksuite/channel`（飞书官方「Channel SDK」——被低估的选项）

| 项 | 内容 |
|---|---|
| npm | `@larksuite/channel@0.7.1`（2026-09-07），MIT，12 个版本（2026-06-04 首版），活跃 |
| 定位自述 | 「让 agent 和外部服务接入飞书/Lark 消息系统：可靠入站事件、消息归一化、流式回复、媒体上传、卡片交互」 |
| 提供什么 | **`NormalizedMessage` 统一消息模型（12+ `msg_type` 归一化、@提及占位符处理、`merge_forward` 展开、卡片/表情/评论/机器人入群事件归一化）**；WebSocket + webhook 双传输、自动重连、keepalive 看门狗；`PolicyConfig`（`requireMention`、allowlist）、`SafetyConfig`（去重、过期丢弃、per-chat 串行化、文本批量）；`SendInput` 出站（text/markdown/post/card/image/file/audio/video/sticker）、流式卡片、SSRF 防护、自动降级；`registerApp` 扫码建应用 |
| **匹配度** | **直接复用（若不走 Chat SDK，这是飞书侧的等价物）** |

**这是本次调研隐藏的最佳发现之一**：飞书官方自己就造了一个「NormalizedEvent + policy/safety + 出站」的分层，并且**把 agent-cord 想要的 `requireMention` 单机器人路由、去重、per-chat 串行化都内置了**。它的抽象边界比 Chat SDK 更贴近 agent-cord 的 SSOT 思路（不做状态存储，纯传输+归一化）。

二选一的判据：**要不要多 IM？** 要 → 用 Chat SDK 顶层 + `@larksuite/vercel-chat-adapter`（后者内部就是 `@larksuite/channel`）。只做飞书 → 直接用 `@larksuite/channel`，少一层抽象、少一个失败点。

### 1.4 Koishi + Satori（中文生态的「统一消息协议」）

| 项 | 内容 |
|---|---|
| [koishijs/koishi](https://github.com/koishijs/koishi) | **6,225★**，MIT，最后提交 2026-08-28。跨平台聊天机器人框架，插件化 adapter 生态 |
| [satorijs/satori](https://github.com/satorijs/satori) | 254★，MIT，最后提交 2026-08-17；npm `satori@0.33.5`（2026-09-22）。自述 **"The Universal Messenger Protocol"** |
| Adapter 实例 | `@satorijs/adapter-lark@3.12.6`（2026-06-23）、`adapter-dingtalk@2.5.2`、`adapter-discord@4.6.2`、`adapter-slack@2.5.0`、`adapter-matrix@4.4.0`、`adapter-telegram@4.5.11` |
| **匹配度** | **只能借鉴思路 / 备选复用** |

Satori 是**协议层**的统一（不是库层）：15+ 平台 adapter，甚至有 OpenClaw 社区插件用 Koishi 作中间层把 Satori 端点接进 agent 网关。但：① 生态重心在 QQ/中文社区，工程风格与 TS 严格类型文化不同；② adapter 更新节奏参差（telegram adapter 停在 2025-11，lark 停在 2026-06）；③ 引入 Koishi 运行时对 agent-cord 是重依赖。**建议作为「设计参考 + 备用 adapter 来源」，不作主路径。**

### 1.5 其他统一抽象项目（评估后不推荐直接用）

| 项目 | License | 活跃度 | 提供什么 | 判定 |
|---|---|---|---|---|
| [botpress/botpress](https://github.com/botpress/botpress) | MIT | 14,922★，pushed 2026-09-23 | 现仓库是 Botpress Cloud 的 CLI/SDK/integrations | **不匹配**：**v12 自托管版已 sunset**（新部署不再支持），当前是云服务配套仓库。其 channel 抽象可作思路参考 |
| [hubtype/botonic](https://github.com/hubtype/botonic) | MIT | ~618★，v0.51.0（2026-06-29） | React 化 chatbot 框架，WhatsApp/Telegram/Messenger/webchat | **不匹配**：星数低，平台偏消费级 IM，无飞书 |
| [42wim/matterbridge](https://github.com/42wim/matterbridge) | Apache-2.0 | 7,573★，**pushed 2024-12-12（停滞近 2 年）** | Go 写的 20+ 平台消息桥接 | **只能借鉴思路**：桥接模型（每平台一个 `Bridge` interface）值得读，但 Go + 已停滞 + 目标是「转发」而非「响应式 bot」 |
| [errbotio/errbot](https://github.com/errbotio/errbot) | **GPL-3.0** | 3,308★，pushed 2026-08-17 | Python ChatOps bot，多后端 | **不匹配**：GPL-3.0 与 Apache-2.0 分发冲突，Python |
| [hubotio/hubot](https://github.com/hubotio/hubot) | MIT | 16,796★，pushed 2026-09-23 | 老牌 ChatOps 框架，adapter 分离 | **只能借鉴思路**：adapter 契约（`send`/`reply`/`hear`/`respond`）历史价值高，但生态碎片化、无事件归一化 |
| [AstrBotDevs/AstrBot](https://github.com/AstrBotDevs/AstrBot) | **AGPL-3.0** | **40,964★**，pushed 2026-09-24 | Python，16+ 平台 adapter，`AstrMessageEvent` 统一归一化 | **只能借鉴思路**：模型与 agent-cord 高度同构（就是「多 IM + agent」），**但 AGPL-3.0 不可链接进 Apache-2.0 项目**，且 Python |
| [langbot-app/LangBot](https://github.com/langbot-app/LangBot) | Apache-2.0 | **17,962★**，pushed 2026-09-24 | Python，统一 adapter 层覆盖 20+ IM | **只能借鉴思路**：license 友好但语言不符；产品形态与 agent-cord 重叠，建议作为竞品/灵感来源 |

### 1.6 OpenClaw / Hermes Agent — 架构先例（同类目最大的两个项目）

| 项目 | License | 活跃度 | 相关能力 | 判定 |
|---|---|---|---|---|
| [openclaw/openclaw](https://github.com/openclaw/openclaw) | MIT（LICENSE 为 MIT © OpenClaw Foundation；GitHub 因 `THIRD_PARTY_NOTICES.md` 识别为 NOASSERTION） | **390,374★ / 8,513 open issues**，pushed 2026-09-24，TypeScript，501(c)(3) 基金会托管 | 「Gateway + Channels」架构：Discord/iMessage/Slack/Teams/Telegram 等 20+ channel；**Channel Plugin SDK**（`openclaw.plugin.json` manifest、`createChatChannelPlugin`、DM security/pairing/threading/outbound 声明式装配）；插件由厂商自维护（Telnyx、腾讯企微团队发布了官方插件） | **只能借鉴思路**（架构参考价值极高） |
| [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) | MIT | **248,637★**，pushed 2026-09-24，Python | Messaging Gateway + **原生飞书/WeCom/DingTalk adapter** | **只能借鉴思路**：Python；但它是「IM 入口 + agent harness」的完整参考实现 |
| [imtoagent/imtoagent](https://github.com/imtoagent/imtoagent) | MIT | **仅 1★**，pushed 2026-06-12，TypeScript | **架构与 agent-cord 最像的一个**：IM Registry Factory → Bot Instance → AgentRuntime SDK → AgentAdapter → 统一代理；飞书 WS + Telegram 长轮询 + 企微 webhook；slash command（`/help` `/status` `/model` `/mode` `/dir`）；背景 daemon + CLI + launchd/systemd | **只能借鉴思路**：架构同构度极高（TS、daemon+CLI、多 IM+多 agent backend、slash command），**但 1 个 star、3 个月未更新，不可依赖**；建议作为「架构对照物」深度阅读 |

**OpenClaw 的 Channel Plugin 契约特别值得抄**：它明确划分了「插件拥有什么 vs 核心拥有什么」——

- 插件拥有：配置/账号解析、DM 安全策略与白名单、配对审批流、**会话语法（平台原生 conversation id → base chat / thread id / parent 的映射）**、出站、线程化、心跳打字
- 核心拥有：共享 message tool、prompt 装配、session key 外形、泛型 `:thread:` 记账、dispatch

这正是 agent-cord「Node 挂 gate、adapter 只管传输」应该采用的分层原则。另外它的 `security.dm` / `pairing` / `threading` / `outbound` 声明式装配（`createChatChannelPlugin`）比手动实现 `Adapter` 接口更省代码。

---

## 2. 各 IM 官方 SDK 逐平台评估

| 平台 | SDK | License | 版本/活跃度 | 事件订阅 | 发消息 | slash command | 本地 daemon 友好 | 判定 |
|---|---|---|---|---|---|---|---|---|
| **飞书/Lark** | [`@larksuiteoapi/node-sdk`](https://github.com/larksuite/node-sdk) | MIT | 294★，pushed 2026-09-14；`1.74.0`（2026-09-14），127 版本 | `EventDispatcher` + `im.message.receive_v1`；**WebSocket 长连接**（1.24.0+），无需公网 | 语义化 API（`client.im.message.create`）、卡片、模板卡片、分页迭代器、流式 | 无原生机制 | **极佳**（WS 长连接） | **直接复用** |
| **飞书/Lark** | `@larksuite/channel` | MIT | `0.7.1`（2026-09-07），12 版本 | 同上 + 归一化 + policy/safety | `SendInput`、流式卡片 | — | **极佳** | **直接复用（推荐）** |
| **Slack** | [`@slack/bolt`](https://github.com/slackapi/bolt-js) | MIT | 2,944★，pushed 2026-09-23；`5.1.0`（2026-09-02），126 版本 | Events API + **Socket Mode**；**签名校验自动完成** | Block Kit、modals、streaming | **原生 slash command**（3 秒 ack 窗口） | **极佳**（Socket Mode） | **直接复用**（推荐走 `@chat-adapter/slack`，它已封装 Socket Mode + 多工作区 OAuth + token 加密 + 原生 streaming + Agent Sessions API） |
| **Discord** | [`discord.js`](https://github.com/discordjs/discord.js) | **Apache-2.0** | **26,824★**，pushed 2026-09-21；`14.27.0`（2026-07-15），2088 版本 | Gateway WebSocket / HTTP Interactions | 完整 | 原生 application commands | **极佳**（Gateway） | **直接复用**（或走 `@chat-adapter/discord`） |
| **Matrix** | [`matrix-js-sdk`](https://github.com/matrix-org/matrix-js-sdk) | Apache-2.0 | 2,184★，pushed 2026-09-24（官方，最活跃） | `/sync` 长轮询 | 完整 | 无 | 好 | **适配后复用** |
| **Matrix** | [`matrix-bot-sdk`](https://github.com/turt2live/matrix-bot-sdk) | MIT | **仅 277★**，pushed 2026-03-27，npm `0.8.0`（2026-01-16），**已半停滞** | 专为 bot 简化 | 完整 | 无 | 好 | **不推荐**（停滞）；改用官方 `matrix-js-sdk` 或 `@beeper/chat-adapter-matrix`（MIT，`0.2.0` 2026-03-16，Beeper 维护，支持 E2EE 与桥接网络） |
| **企业微信/WeCom** | `@wecom/aibot-node-sdk` | MIT | `1.0.7`（2026-05-12），25 版本，**官方（腾讯）** | **WebSocket 长连接**（智能机器人） | 支持 | 无 | **极佳**（免公网、免回调地址） | **适配后复用**；另有腾讯官方 `@wecom/wecom-openclaw-plugin` 与社区 Chat SDK WeCom adapter |
| **钉钉/DingTalk** | [`dingtalk-stream-sdk-nodejs`](https://github.com/open-dingtalk/dingtalk-stream-sdk-nodejs) / `dingtalk-stream` | MIT | `dingtalk-stream@2.1.6-beta.1`（2026-03-22，7 版本，**仍为 beta**） | Stream 模式 WebSocket（事件+机器人收消息+卡片回调） | 支持 | 无 | 好 | **只能借鉴思路 / 低优先**：Node SDK 成熟度低于飞书/企微；备选 `@satorijs/adapter-dingtalk@2.5.2` |
| **微信（个人号）** | [`wechaty`](https://github.com/wechaty/wechaty) | Apache-2.0 | 23,319★，**pushed 2025-12-21（停滞 ~9 个月）**；npm 停在 `1.20.2`（2022-05） | RPA/puppet | 支持 | 无 | 差 | **不匹配**：RPA 路线有账号封禁风险，非官方；agent-cord 应避开 |

**对「群=圆桌」语义的平台差异提醒**：

- **飞书**：群里每条顶层消息自成一个 thread（`rootId = message_id`）。若 agent-cord 要「整个群=一个圆桌」，应在适配层**把 session 键定在 `channelId` 层**（`channelIdFromThreadId()` 可取），把 thread 当作轮次。这是接入 Chat SDK 时唯一需要额外设计的映射点。
- **Slack**：channel 与 thread 天然分离，`agentView` 模式下 DM 会按用户消息分线程——Chat SDK 文档明确警告：建 AI 历史要用 user history 而非 channel history。
- **Discord**：channel / thread 分离清晰，最接近圆桌语义。

---

## 3. Webhook ingress 与签名校验

第一阶段若采用**飞书 WS 长连接 + Slack Socket Mode**，**webhook ingress 根本不是必需项**（这是本地 daemon 方案的最大红利）。仅当接入企微应用回调 / 钉钉 / Teams 时才需要。

| 组件 | 用途 | 判定 |
|---|---|---|
| 各平台官方 SDK 内建校验 | 飞书 `EventDispatcher` 自动处理 AES 解密 + 签名；Slack Bolt / `@chat-adapter/slack/webhook` 自动 `x-slack-signature` 校验；企微 AES-256-CBC | **直接复用**，不要自研 |
| [`standardwebhooks`](https://www.npmjs.com/package/standardwebhooks) | MIT，`1.1.1`（2026-08-28）。[Standard Webhooks 规范](https://docs.svix.com/receiving/verifying-payloads/how)的参考实现（HMAC-SHA256 + 时间戳防重放） | **直接复用**（第三方 webhook 插件场景） |
| `@chat-adapter/slack/webhook` 低层子路径 | 已导出 `verifySlackRequest` / `parseSlackWebhookBody` / `readSlackWebhook`，**且不引入 `chat` 运行时**——适合「自己拥有路由与状态」的场景 | **直接复用** |
| Hono（`4.13.9`）/ Fastify（`5.12.5`）/ Express（`5.2.1`） | HTTP 框架 | **按口味选**：agent-cord 已有本地 IPC/HTTP，第三方 webhook 插件可挂在这些之上。注意 raw body 必须保留（签名是对原始字节算的） |

---

## 4. 造轮子 vs 复用：明确建议

### ✅ 应该直接用现成库（不要自研）

| 能力 | 用什么 | 理由 |
|---|---|---|
| 多 IM 统一抽象 / NormalizedEvent | **Vercel Chat SDK (`chat`)** | 120 contributors、周更、14+ 官方 adapter、thread/message/handler 模型完整覆盖 agent-cord 的入口需求 |
| 飞书事件订阅与消息归一化 | **`@larksuite/vercel-chat-adapter`**（顶层）或 **`@larksuite/channel`**（飞书专用） | WebSocket 长连接、23 种 msg_type 归一化、@提及、流式卡片、SSRF 防护、去重全都有 |
| 飞书底层 API / token / 分页 / 卡片 | **`@larksuiteoapi/node-sdk`** | 官方、127 版本、MIT |
| Slack | **`@chat-adapter/slack`** 或 `@slack/bolt@5` | Socket Mode、签名校验、slash command、原生 streaming、Agent Sessions 已封装 |
| Discord | **`@chat-adapter/discord`** 或 `discord.js@14` | Apache-2.0，与项目 license 一致 |
| Matrix | **`@beeper/chat-adapter-matrix`** 或官方 `matrix-js-sdk` | 别用半停滞的 `matrix-bot-sdk` |
| 企微智能机器人 | **`@wecom/aibot-node-sdk`**（官方 WS） | 免公网、免回调地址 |
| 跨平台卡片渲染 | Chat SDK JSX `Card`（Block Kit / Adaptive Cards / 飞书卡片自动降级） | 自研卡片 DSL 是纯浪费 |
| 消息并发/去重/锁 | Chat SDK 内建（`onLockConflict`、`dedupeTtlMs`、burst/queue/debounce/drop） | 这是公认难写对的并发部分 |
| webhook 签名校验 | 平台 SDK 内建 + `standardwebhooks` | — |

### 🔧 必须自研（无现成实现，或现成实现不匹配）

| 能力 | 为什么没有现成实现 |
|---|---|
| **`StateAdapter`（SQLite/文件后端）** | Chat SDK 无 SQLite adapter。但 agent-cord 的 SSOT 是文件+git，state 是派生物——自研一个把订阅/锁/去重写进 SQLite 或 `cord/<req-id>/.state/` 的 adapter 是**合理且必要的边界**，且实现面窄（subscriptions / locks / KV+TTL） |
| **群 = 圆桌 的 session 映射策略** | 飞书 thread 语义与「群=圆桌」不等价（见 §2），需要自研映射层（Chat SDK 的 `channelIdFromThreadId` + `thread.setState` 提供了原语，但策略是你的领域逻辑） |
| **飞书侧的 slash command** | `@larksuite/vercel-chat-adapter` 明确不支持；飞书平台本身也没有 Slack 式注册机制。用 `onNewMessage(/^\/cord\b/)` 兜底即可（约 20 行），**不是真缺口** |
| **投票/共识分支** | 盲评投票执行器、证据锚点机验、Jaccard 同源检测、`ledger.yaml` 状态机——**全生态无先例**，必须自研 |
| **工作流有向图 + gate 三级校验器** | 无直接先例（CEL 部分可用 `cel-js` 之类库，但 gate 契约与 YAML apiVersion 化是你的设计） |
| **`events.jsonl` + git union merge driver** | 无先例，需自研 merge driver 与 append-only 写入 |
| **AgentDriver（统一 subprocess 驱动 headless CLI）** | 无现成库。**架构可参考** `imtoagent` 的 `AgentAdapter.ts` 与 OpenClaw 的 harness plugin |
| **本地 daemon + 薄 CLI IPC + npm 库导出** | 无现成库。**架构可参考** `imtoagent`（daemon + launchd/systemd + 单 CLI）与 OpenClaw（Gateway + Control UI/CLI/TUI） |

### 🧠 只借思路（不引依赖）

- **OpenClaw Channel Plugin 契约**：插件 vs 核心的职责划分（详见 §1.6）——强烈建议在写 `AgentDriver`/IM adapter 前先读。
- **Satori / Koishi**：协议层统一的边界设计（哪些字段进 NormalizedEvent、`Channel`/`Guild`/`User` 的建模）。
- **Matterbridge**：平台 Bridge interface 的最小面。
- **AstrBot / LangBot**：中文 IM 生态的 adapter 覆盖面清单（企微智能机器人、公众号、QQ 官方等）——用来做路线图，不是代码来源。
- **imtoagent**：TS + daemon + 多 IM + 多 agent backend 的完整架构同构图，可逐文件对照。

---

## 5. 复用优先级清单

**P0 — 第一阶段立刻采用（决定入口可行性）**

| # | 组件 | 动作 |
|---|---|---|
| 1 | **`chat` (Vercel Chat SDK)** | 引入为统一抽象层。MIT，2,384★，120 contributors，周更 |
| 2 | **`@larksuite/vercel-chat-adapter`** | 引入为第一个落地 adapter。**vendored + 锁版本**（源码仓库 404，需可审计化） |
| 3 | **`@larksuite/channel`**（传递依赖，但值得显式认知） | 飞书归一化/流式/policy 的真实实现层；其 `policy.requireMention` 与 `safety` 正是 agent-cord 需要的能力 |
| 4 | **自研 `StateAdapter`（SQLite/文件）** | Chat SDK 唯一硬缺口；写入 `cord/` 派生目录，不污染 SSOT |
| 5 | **`onNewMessage(/^\/cord\b/)` 模拟 slash command** | 补齐飞书侧缺口 |

**P1 — 第二阶段（多 IM 展开时）**

| # | 组件 | 动作 |
|---|---|---|
| 6 | `@chat-adapter/slack`（含 Socket Mode） | 第二个官方 adapter；原生 slash command / streaming / Agent Sessions |
| 7 | `@chat-adapter/discord` 或 `discord.js@14` | Apache-2.0，license 一致性最好 |
| 8 | `@wecom/aibot-node-sdk`（官方 WS） | 国内企微入口，免公网 |
| 9 | `@beeper/chat-adapter-matrix` | Matrix / E2EE / 桥接网络（对「不绑定厂商」诉求最贴合） |

**P2 — 按需 / 谨慎**

| # | 组件 | 说明 |
|---|---|---|
| 10 | `standardwebhooks` + Hono/Fastify | 仅在需要接收第三方 webhook 时 |
| 11 | `@satorijs/adapter-dingtalk` / `dingtalk-stream` | 钉钉；Node SDK 仍 beta，优先级下调 |
| 12 | `cel-js` 类库 | gate 的 CEL 校验器（属工作流主题，非本次 IM 主题结论） |

**明确排除（不要碰）**

- `wechaty`（个人微信，RPA 风险 + 停滞 ~9 个月）
- `botpress` v12（自托管已 sunset）
- `errbot`（GPL-3.0）、`AstrBot`（AGPL-3.0）——license 与 Apache-2.0 分发冲突
- `matrix-bot-sdk`（半停滞，277★）
- `matterbridge`（停滞近 2 年，Go，目标不符）
- 任何 platform-level「自建机器人」以外的微信个人号方案

---

## 6. 需要向主 agent 明确的两个判断点

1. **主题描述里提到的 `Ballerine` 与 IM 抽象无关**——我核实了 [ballerine-io/ballerine](https://github.com/ballerine-io/ballerine)，它是 KYC/KYB 风险决策编排平台（金融合规领域），不提供任何消息归一化能力。应视为误关联，已从候选中剔除。

2. **Chat SDK 是 v4.x 且周更，无 LTS**——引入它意味着接受持续的升级维护成本。替代方案是「只用 `@larksuite/channel` + 各平台官方 SDK，自研薄归一化层」，代价是放弃多 IM 的收益（平均每平台 300~800 行 adapter 代码 + 各自的卡片/流式/去重差异）。**以 agent-cord「多异构 + 不绑定厂商」的设计目标看，走 Chat SDK 是对的**；但如果只想先做飞书单平台，直接用 `@larksuite/channel` 更轻、更可控，且不牺牲后续切换到 Chat SDK 的路径（因为 Chat SDK 的飞书 adapter 就是它）。

---

**参考来源**：[vercel/chat](https://github.com/vercel/chat) ｜ [Chat SDK 文档](https://chat-sdk.dev/llms.txt) ｜ [飞书 adapter 文档](https://chat-sdk.dev/adapters/vendor-official/lark) ｜ [Vercel changelog: Lark/Feishu 支持](https://vercel.com/changelog/chat-sdk-adds-lark-feishu-support) ｜ [larksuite/node-sdk](https://github.com/larksuite/node-sdk) ｜ [Slack adapter 文档](https://chat-sdk.dev/adapters/official/slack) ｜ [OpenClaw channel plugin SDK](https://docs.openclaw.ai/plugins/sdk-channel-plugins) ｜ [koishijs/koishi](https://github.com/koishijs/koishi) ｜ [satorijs/satori](https://github.com/satorijs/satori) ｜ [imtoagent](https://github.com/imtoagent/imtoagent) ｜ [AstrBot](https://github.com/AstrBotDevs/AstrBot) ｜ [LangBot](https://github.com/langbot-app/LangBot) ｜ [42wim/matterbridge](https://github.com/42wim/matterbridge) ｜ [standardwebhooks](https://www.npmjs.com/package/standardwebhooks)
