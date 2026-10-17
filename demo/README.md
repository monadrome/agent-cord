# 《协作有据：AI 业务研发协作平台》演示视频

第 15 届 Trip Hackathon · 2026 焕新于技 · 队伍「闭环同行队」

代码驱动的演示视频：**140s · 1920×1080 · 30fps · H.264(yuv420p) + AAC**。
全部画面由单个 HTML 页面按时间轴确定性渲染，Playwright 逐帧截图，ffmpeg 合成。

## 交付物

| 路径 | 说明 |
|---|---|
| `out/demo.mp4` | 成片（140.0s，1920×1080@30，含程序生成的低音量 pad 音轨） |
| `out/poster.png` | 封面（结尾定帧 t=139.5s） |
| `storyboard.md` | 分镜脚本：每镜时间轴、全部屏幕文案与 mock 数据的唯一真相源 |
| `src/index.html` | 时间轴动画渲染器（单文件、原生 JS、无外部依赖） |
| `src/capture.mjs` | Playwright 逐帧截图（7 页并发分片，`SMOKE=1` 抽帧模式） |
| `src/compose.sh` | ffmpeg 合成 + 海报导出 |

## 依赖

- node ≥ 18（开发用 v26）、ffmpeg ≥ 4（开发用 4.3.2）
- 局部依赖：`npm i`（playwright + chromium，首次约 130MB 下载；`npx playwright install chromium`）
- 字体：macOS 系统字体（PingFang SC / SF Mono）；其他平台中文回退 Noto Sans CJK、等宽回退 Menlo/monospace

## 重新生成

```bash
npm i && npx playwright install chromium   # 仅首次
npm run smoke      # 可选：18 个关键时刻抽帧到 smoke/，验证无报错
npm run capture    # 全量渲染 4200 帧到 frames/（约 90s，M 系 Mac）
bash src/compose.sh  # 合成 out/demo.mp4 + out/poster.png（约 50s）
```

端到端（含渲染与合成）约 **3 分钟**。

## 确定性

画面是时间 `t` 的纯函数（`window.__setTime(t)`）：不使用 `Date.now()` / `performance.now()` / 未播种 `Math.random()` / `requestAnimationFrame`。已实测正序、倒序、全新页面三种 seek 路径对相同 t 逐像素一致；重跑产出视觉等价的视频（PNG 逐字节一致，mp4 因编码器线程可能有位元差异）。

## 关键取舍（无人值守模式下自行决策）

- **技术路线**：选交接建议的首选方案（自包含 HTML + 时间轴驱动 + Playwright 逐帧 + ffmpeg），未引 Remotion，零框架依赖，确定性最强。
- **BGM**：ffmpeg lavfi 程序生成 A 大三和弦 pad（110/164.81/220/277.18Hz），实测响度约 −28dB，2s 淡入 3s 淡出；无版权风险。amix 四路归一化后 volume 系数取 0.35 才达到目标响度（compose.sh 内有注释）。
- **mock 数据**：全部集中在 storyboard.md §1 总表（需求号 ZXHC-13500、8 个 12 位 hex hash、同日递增时间戳、152 用例 / 87.4% 覆盖率等），渲染代码不得另造数据；已逐字 grep 核对 102 条文案、编号、hash 与 storyboard 一致。
- **微调偏差**（相对 storyboard，均为时序/版式级，内容与数据零偏差）：破坏①整体前移 0.55s 使「拒绝放行」定格落在检查帧；幕四关键词出现于 128.2/130.4/132.6s；飞书决策卡描边取品牌蓝 `#3370FF`。
- **修复记录**：初版 QA 发现两处缺陷并已修复重出片——① agent-result/v1 面板 hypotheses 行超宽被裁切（加宽面板+缩字号）；② 幕二强调字幕单字成行（改为逗号处显式断行）。

## 效率档位

执行模型为 Kimi（按交接方要求以 subagent K3 档执行实现与修复）。
