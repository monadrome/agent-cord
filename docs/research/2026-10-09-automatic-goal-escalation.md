# Goal blocked 自动协调升级验收

日期：2026-10-09。协议见 [ADR-0058](../adr/ADR-0058-automatic-goal-blocker-escalation.md)，产品原则见 [核心 feature](../core-features.md)。

## 行为与边界

声明 supervisor_agent 的 Goal 真正 blocked 后，宿主自动创建一次协调轮次；请求由 system/goal-supervisor 记录，绑定 run、node、执行版本和 Goal 完成事件。模型只解释当前阻塞，返回带该事件证据的 ask_human 或 wait；不自动回答、扩预算、批准 gate 或恢复失败 run。

同 blocker 用持久化请求事实去重。已有人工协调轮次先收束，再核验原 run 是否仍当前失败；关闭信号可打断等待。冷恢复只补没有请求事实的 blocker，已经开始或失败的 supervisor 调用不重放。未知 agent、坏输出、超时与取消保留协调终态，原 run.error 不被覆盖。没有 supervisor 的旧流程与成功路径不产生额外模型调用。

## 验证范围

自动升级回归使用真实 ACP/headless fixture 子进程与宿主命令，覆盖正常阻塞、首轮成功、未声明 supervisor、错误 JSON/advance/缺证据、未知 agent、并发去重、请求追加失败、缺请求冷恢复、源码在途变化、取消、超时、伪造来源、坏历史请求、已有人工协调与关闭恢复。人工答复仍是澄清，测试验证其不会形成 gate 决定或执行退出。

来源消费拒绝不存在、未来、不同 run/node/版本或非宿主的 blocker。已记录的自动请求不能在库入口被重新调用，REST 不接受外部 trigger 字段。blocker 作为输入身份的一部分贯穿 prompt、完成重检和查询/答复核验。

最终全量离线 919 测试 / 70 文件通过，typecheck、build:all 和 diff 检查通过；10 份公开文档的 147 个本地链接全部存在，ADR-0058 符合七节与 200 行限制。

## 真实 Codex 与 HTTP

隔离临时工作区用确定性的 worker 与必定失败的检查制造 blocker；真实 Codex CLI 0.160.0 作为 supervisor 自动调用一次。没有人为发起协调请求或代答。

- worker 1 次、supervisor 1 次，自动生成 ask_human 并引用真实 Goal event_id。
- round trigger=goal_blocked、current=true、answerable=true；原 run=failed。
- 人工 gate 决定 0、节点退出 0，未合入/发布/扩预算。
- 重启保持同 round，没有新增 supervisor 调用；投影重建后 session doctor=true。
- 临时结果 `/tmp/cord-stage44-real-result.json` 与 `/tmp/cord-stage44-browser-result.json` 保存证据定位，不提交模型正文、运行数据或截图。

## 浏览器验收

Playwright/Chrome 在 1440、390、320 宽度显示“Goal 自动升级”、真实模型问题与有限选项。选项可用、默认不提交；没有“采用并启动 SDLC”按钮。Goal 来源导航打开 blocker 事件，pageerror=0、没有横向溢出；桌面与移动截图已查看。

首次检查发现导航按钮只有 title、缺少可访问名称，已补 aria-label。事件页异步加载后再检验来源，避免把尚未渲染视为丢失。全页截图拍摄前滚到页顶，移动端固定导航和正文未重叠。

## 后续工作

当前原型已连接“发现 blocker → 自主协调 → 提出人工问题”，答复会进入最新快照。人工答复后的显式继续、预算授权和费用治理仍待实现；当前答复不自动启动新 run。真实 supervisor 只验证这个微型样本，不证明复杂需求的诊断质量或普遍正常路径比例。验证脚本/工作区仍是信任边界，持续目标保持 active。
