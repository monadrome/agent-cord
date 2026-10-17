# 《协作有据》演示视频分镜脚本（storyboard）

> 本文件是视频渲染的唯一真相源：所有屏幕文案、时间戳、hash、数字必须与此处完全一致，
> 渲染代码（`src/index.html`）不得自行发明任何数据。
>
> 规格：总长 **140.0s**，1920×1080，30fps（共 4200 帧），深色主题。

## 0. 设计基调（design tokens）

- 背景：`#0B0E13`（近黑深蓝）；面板底：`#12161F`；面板描边：`#1F2633`
- 主文字：`#E6E9F0`；次要文字：`#8A93A6`；弱提示：`#4A5265`
- 强调色（唯一）：青 `#46D6D2`；通过绿 `#3ECF8E`；拒绝红 `#F2555A`；警示琥珀 `#E8B44A`
- 字体：中文 `PingFang SC`；代码/数字/hash `"SF Mono", Menlo, monospace`
- 动效：面板浮现 = 透明度 + 上移 12px，cubic-bezier(0.22, 1, 0.36, 1)，200–400ms
- 打字机：非匀速（用确定性的 seeded 节奏，禁用 `Math.random()`）
- 拒绝瞬间：红色横条 + 画面轻微震动（translateX ±6px 衰减 400ms）+ 红闪一下
- 同一时刻屏幕只有一个视觉焦点；关键结论定格 1.5–2s

## 1. Mock 数据总表（自洽性以本表为准）

| 项 | 值 |
|---|---|
| 需求号 | `ZXHC-13500` |
| 需求标题 | 多程退票挽留提示优化 |
| 日期 | 2026-10-16（所有时间戳同一天内递增） |
| KICKOFF 通过 | 14:02:11 |
| C-0 写入 Cord | 14:02:13，hash `3f9a1c72b804` |
| 执行 Agent session | `S-1`，worktree `wt-zxhc-13500` |
| 实现提交 | `I-1`，commit `8c2e91d0f4a6`，14:05:40 |
| SCOPE 通过 | 14:05:58 |
| 验证 Agent session | `S-2`（独立 session、独立 worktree，不共享聊天上下文） |
| TESTCASE 通过 | 14:14:02 |
| UT | 152 用例；首轮 151 pass / **1 fail（RR-07）**；修复后 152/152；行覆盖恒定 **87.4%** |
| 失败用例 | `RR-07 用户关闭提示后不再展示` |
| UI 一致性 | 3 张截图 diff，最大偏差 0.18%（阈值 0.5%） |
| e2e | 12 用例全过；录屏 `e2e-video.html`，hash `e5a2d690bc17` |
| code review | 2 条建议，0 阻塞 |
| 修复提交 | `I-2`，commit `51b7aa29ce08`，14:18:22 |
| 环境指纹 | 期望 `9f2c41a07b3e`；被篡改后 `44d0b8e17a91` |
| 证据包 hash | `c70e5b19a2d4` |
| ACCEPTANCE 放行 | 14:26:10 |
| Event Store | 事件 `E-0001 … E-0042`（共 42 条，append-only） |
| Cord 条目 | `C-0` 认知边界；`C-1` 假设 H-1（后被推翻，标记 RETRACTED 但保留） |
| 假设 H-1 | 「关闭态未跨标签页同步」（confidence 0.62），复验后被推翻 |
| 修复根因 | 补 `storage` 事件监听，跨标签页同步关闭态 |
| 飞书决策卡 | 歧义：「挽留提示是否覆盖积分抵扣场景？」选项：覆盖 / 不覆盖（本期）；人点选「不覆盖（本期）」 |

hash 一律 12 位小写 hex。禁止出现：lorem、TODO、placeholder、测试数据、demo、example.com、乱码、占位人名。

## 2. 分幕时间轴

### 幕 0 · 开场（0.0s – 10.0s）

纯黑起。

- **0.0–2.8s**　标题卡淡入（居中）：
  - 小字（次要色）：`第 15 届 Trip Hackathon · 2026 焕新于技`
  - 大字（主色 72px）：`协作有据`
  - 副标（青色 28px）：`AI 业务研发协作平台`
- **2.8–4.2s**　标题卡淡出。
- **4.2–9.0s**　痛点句居中淡入（40px，主色）：
  `验证已经自动化，共识还没有。`
  1.5s 后下方补一行小字（次要色 22px）：
  `协作共识散落在聊天记录里，事后无法追溯`
- **9.0–10.0s**　整体淡出至黑。

### 幕 1 · 派发与上下文贯通（10.0s – 40.0s）

- **10.0–11.5s**　左上角幕标淡入（青色小字 + 细线）：`幕一 · 派发与上下文贯通`
- **11.5–21.0s**　左侧出现「任务表单」面板（宽 880px），标题栏 `新建研发任务`。字段逐行填入（每行打字机录入，节奏有快有慢，行间停顿 300–600ms）：
  - `需求号　ZXHC-13500`
  - `标题　　多程退票挽留提示优化`
  - `目标　　在多程退票流程中增加挽留提示，降低误退率`
  - `验收　　① 退票确认前展示挽留提示`
  - `　　　　② 提示可关闭，且记录用户选择`
  - `　　　　③ 全链路 e2e 通过`
  - `边界　　仅 frontend/refund 模块；不改计价与退改规则引擎`
- **21.0–24.0s**　表单底部出现 gate 行：`gate: KICKOFF`，一个人类口令输入框（输入显示为 `••••••`），敲下后盖章 `✓ 通过 14:02:11`（绿色）。字幕小字：`每一道门，口令只掌握在人的手里`。
- **24.0–30.0s**　表单整体收缩成一张卡片 `C-0 认知边界`，平移飞入右侧浮现的「Cord 认知账本」面板：
  - 账本项目题 `Cord · 认知共识账本（append-only）`
  - 新条目追加到底部：`C-0 认知边界 · ZXHC-13500`，右侧等宽小字 `3f9a1c72b804 · 14:02:13`
  - 账本上方可见一条更旧的灰色条目（示意历史不可改）：`C-57 上一迭代共识 · ZXHC-13218` `a1d9402be6c7 · 09-30 17:44`（灰色、不可交互）
- **30.0–35.0s**　下方浮现执行 Agent 卡片：
  - `执行 Agent · session S-1 已启动`
  - 小字：`上下文来源：Cord C-0（唯一） · worktree wt-zxhc-13500`
  - 一个克制的 spinner（青色细环）转动
- **35.0–40.0s**　对比字幕（屏幕中央偏下，两行情灰一行亮）：
  - 灰字划线淡出：`过去：上下文散落群聊，Agent 反复追问`
  - 亮字定格：`现在：一处固化，零追问`

### 幕 2 · 执行与独立验证（40.0s – 84.0s）

- **40.0–41.5s**　幕标：`幕二 · 执行与独立验证`
- **41.5–56.0s**　代码编辑器面板（左，宽 1120px）打字动画，顶部 tab：`retainHint.ts · wt-zxhc-13500`。右侧窄栏显示 `执行 Agent · S-1` 状态：`编写实现中…`（spinner）。逐字打出（非匀速，含一次短暂停顿如同思考）以下代码（语法高亮：关键字青、字符串琥珀、注释弱灰）：

```ts
import { z } from "zod";

export const RetainHintTrigger = z.object({
  scene: z.literal("multi-leg-refund"),
  legCount: z.number().int().min(2),
  dismissed: z.boolean(),
});

export type RetainHintTrigger = z.infer<typeof RetainHintTrigger>;

const STORAGE_KEY = "refund.retain-hint.dismissed";

export function shouldShowRetainHint(t: RetainHintTrigger): boolean {
  if (t.dismissed) return false;
  return t.scene === "multi-leg-refund" && t.legCount >= 2;
}

export function dismissRetainHint(): void {
  localStorage.setItem(STORAGE_KEY, "1");
}

export function readDismissed(): boolean {
  return localStorage.getItem(STORAGE_KEY) === "1";
}
```

- **56.0–60.0s**　右侧状态变为 `已提交`，弹出提交卡：
  `I-1 实现提交`　commit `8c2e91d0f4a6`　`3 files changed · +86 −12`　`14:05:40`
  随后 gate 行盖章：`gate: SCOPE ✓ 通过 14:05:58`
- **60.0–65.0s**　编辑器面板压暗退后，右侧滑入验证 Agent 面板：
  - `验证 Agent · session S-2 独立启动`
  - 小字：`独立 session · 独立 worktree · 不共享聊天上下文`
  - 强调字幕（青色，定格 2s）：`验证预期只来自契约，不采纳执行者的自我定义`
  - 随后盖章：`gate: TESTCASE ✓ 通过 14:14:02`
- **65.0–75.5s**　验证产物卡片逐个弹出（每张 2.5s，从右下向上堆叠，带迷你进度条走完才出现结论，体现耗时感）：
  1. `V-1 单测报告`　`152 用例 · 151 通过 / 1 失败`　`行覆盖 87.4%`（失败项红字：`RR-07 用户关闭提示后不再展示`）
  2. `V-2 UI 一致性`　`3 张截图 diff · 最大偏差 0.18%（阈值 0.5%）`　绿色 ✓
  3. `V-3 e2e 录屏回放`　`e2e-video.html · 12 用例全过`　一个迷你播放器外观（播放条走到 41%）
  4. `V-4 Code Review 摘要`　`2 条建议 · 0 阻塞`　绿色 ✓
- **75.5–80.5s**　屏幕中央出现 `agent-result/v1` JSON 面板（等宽，逐行打出），关键行定格：
```json
{
  "protocol": "agent-result/v1",
  "task": "ZXHC-13500",
  "from": "verifier/S-2",
  "status": "fail",
  "facts": [
    {
      "id": "F-11",
      "claim": "RR-07 failed: dismissed hint reappears in second tab",
      "evidence": "artifact://e2e-video.html#t=00:41",
      "hash": "e5a2d690bc17"
    }
  ],
  "hypotheses": [
    { "id": "H-1", "claim": "dismiss state is not synced across tabs", "confidence": 0.62 }
  ]
}
```
  `"status": "fail"` 用红色高亮块标出，出现的瞬间画面轻微震动 + 红闪一次，定格 1.8s。
  底部小字：`facts 必须带证据锚点 · hypotheses 不得当事实传播`
- **80.5–84.0s**　快速连击（节奏加快但不跳跃）：
  - 修复卡：`I-2 修复提交` commit `51b7aa29ce08`　`补 storage 事件监听，跨标签页同步关闭态`　`14:18:22`
  - 复验进度条 0→100%（约 1.2s）
  - 同一 JSON 面板中 `"status"` 翻转为绿色 `"pass"`，定格。

### 幕 3 · 流程门禁与破坏演示（84.0s – 128.0s）

- **84.0–85.5s**　幕标：`幕三 · 流程门禁与破坏演示`
- **85.5–91.0s**　中央出现 `ACCEPTANCE Gate` 面板（宽 980px），副标 `证据链检查 · fail-closed`。四项检查逐条打勾（每条 0.8s，绿色 ✓）：
  - `证据完整性　bundle c70e5b19a2d4`
  - `环境指纹　　9f2c41a07b3e`
  - `探针状态　　positive-control 在位`
  - `阳性对照　　通过`
  底部状态：`全部通过 · 待人类口令放行`
- **91.0–97.5s　破坏①**：左下滑入终端小窗，键入 `rm artifacts/e2e-video.html`（等宽红字）。gate 自动重检，第一项翻转为红 ✗，红色横条：
  `evidence missing: e2e-video.html`　→　大字 `拒绝放行`（震动 + 红闪，定格 1.8s）
  终端再键入 `restore artifacts/e2e-video.html`，状态恢复。
- **97.5–104.0s　破坏②**：终端键入 `env patch --fingerprint 44d0b8e17a91`。第二项翻红，横条：
  `environment fingerprint mismatch`　小字 `expected 9f2c41a07b3e · got 44d0b8e17a91`　→　`拒绝放行`（震动 + 红闪）
  恢复：`env rollback`
- **104.0–110.5s　破坏③**：终端键入 `probe disable positive-control`。第三项翻红，横条：
  `probe disabled: positive-control`　→　`拒绝放行`（震动 + 红闪）
  底部小字定格：`零数据结论，必须有阳性对照`
  恢复：`probe enable positive-control`
- **110.5–115.0s**　四项全部回绿，人类口令框输入 `••••••`，盖章：
  `gate: ACCEPTANCE ✓ 放行 14:26:10`（绿色大字，定格 1.8s）
- **115.0–121.0s**　Event Store 回放：底部浮起横向时间线面板 `Event Store · append-only`，事件点 `E-0001 … E-0042` 从左向右快速点亮，播放头扫过；经过关键事件时上方弹出小标签：
  `E-0003 C-0 写入` → `E-0011 I-1 提交` → `E-0024 status: fail` → `E-0031 复验 pass` → `E-0042 ACCEPTANCE 放行`
  结尾字幕：`全过程，可逐事件回放`
- **121.0–125.0s**　Cord 账本面板再现，特写条目：
  - `C-1 假设 H-1「关闭态未跨标签页同步」` 灰色划线，右侧红色小标签 `RETRACTED · 被 V-3 复验推翻`
  - 但该条目**保留在账本中**，不消失。字幕：`被推翻的结论也留在历史里 —— 文档防腐`
- **125.0–128.0s**　飞书决策卡一闪（居中卡片，飞书蓝描边）：标题 `歧义升级 · 待人工决策`，正文 `挽留提示是否覆盖积分抵扣场景？`，两个选项按钮：`覆盖` / `不覆盖（本期）`；鼠标点选后者，卡片下方小字 `已恢复执行 · 决策已写入 Cord`。

### 幕 4 · 收尾（128.0s – 140.0s）

- **128.0–135.0s**　黑底，三个关键词逐个定格（每个 56px，依次淡入并停留，横向排列逐个出现，每个间隔约 2.2s）：
  `上下文贯通`　`文档防腐`　`流程门禁`
- **135.0–140.0s**　最终定帧（居中）：
  - 小字：`第 15 届 Trip Hackathon · 2026 焕新于技`
  - 大字：`协作有据：AI 业务研发协作平台`
  - 队名（次要色）：`闭环同行队`
  - 最下方三关键词小字：`上下文贯通 · 文档防腐 · 流程门禁`
  - 定格至 140.0s 结束。**海报帧取 t=139.5s。**

## 3. 声音

- 程序生成极简和弦 pad（A 大三和弦低频铺底，音量约 -28dB，开头 2s 淡入、结尾 3s 淡出），ffmpeg lavfi 合成，确定性可复现。不引人声、不用版权素材。

## 4. 渲染与合成（技术约定）

- 单文件 `src/index.html`：所有动画是时间 `t`（秒）的纯函数，暴露 `window.__setTime(t)`；禁用未播种随机数与真实时钟。
- `src/capture.mjs`：Playwright chromium，1920×1080 视口，按 1/30s 步进逐帧截图到 `frames/%05d.png`（可多页面并发，但帧序号必须严格对应 t）。
- 合成：`ffmpeg -framerate 30 -i frames/%05d.png ... -c:v libx264 -pix_fmt yuv420p -crf 18` + lavfi pad 音频 → `out/demo.mp4`。
- 海报：`t=139.5` 帧另存 `out/poster.png`。
