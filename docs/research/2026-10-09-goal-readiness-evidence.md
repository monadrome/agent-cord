# Goal ready 来源与当前有效性验收

日期：2026-10-09。协议见 [ADR-0061](../adr/ADR-0061-goal-readiness-evidence.md)，产品原则见 [核心 feature](../core-features.md)。

## 修复结果

Goal ready 的结构来源由 resolveGoalReadiness 统一校验：当前 run/节点/执行版本下最新的 Goal 完成，真实 worker 成功和产物证据，以及 worker 之后、ready 之前的全部声明宿主验证。命令、input/source hash、零退出、来源、顺序及取消均纳入，不接受未来/外部/不存在/被替换的引用。

runner 用此证据复用，协调投影也使用同一证明，再读取当前代码/指南。历史 status 与 current/freshness_reason 分离：代码或报告变化时 ready/false/stale_input，读取故障 ready/null/unavailable；结构损坏 invalid/false，取消 run 的 ready 失效。只有 current=true 的 ready 可作 Goal evidence；blocked/retrying 等原执行事实仍可引用，历史事件/节点退出/人工 gate 不改写。

## 离线证据

- 先复现两个失败：旧 runner 接受先于 worker 的测试；协调观察无法标记 ready 后的源码变化。
- 34 项共用结构证据测试使用真实 NodeRunner 产出的事件，覆盖 valid、错误宿主、缺/未来引用、任务/产物/预算、命令/输入/退出码、最新结果替换、外部 session、取消、尝试启动与重复事件 ID。指南的宿主补证据会改变 hash，不误将补写前后产物视为同一份内容。
- runner 与 server 回归验证源码/指南修改、恢复、符号链接不可读、取消、坏 actor/correlation/预算，以及只有 ready 新鲜度在途变化也会令协调 stale。
- 旧缺来源的人工 ready fixture 现在明确为 invalid；缺省旧 hook 的 ready 不再冒称当前有效。
- ready 过期且次数耗尽的终态原先记录 max+1，新反例先失败；修正为已消费编号，完整 server 回归仍能自动升级且不新增 worker。
- 最终全量 1007 项 / 74 文件、typecheck、build:all 和 diff 检查通过。

## 隔离 HTTP

使用离线真子进程 worker 与 observer，无付费模型调用。Goal 首次失败、第二次修复到最终人审后，进行以下核验：

1. 当前 ready/source 通过，合法 Goal event_id 可在协调结果中引用。
2. 仅修改代码，旧轮次 current=false，继续引用旧 ready 的新轮次 failed/output。
3. 修改指南也使 ready 过期；还原相同内容后可重新核验 current=true，无须改历史事件。
4. 声明源码变为链接时 current=null/unavailable，修复普通文件后恢复。
5. 新轮次可据 workflow 来源报告旧 ready 过期；还原输入并冷恢复时 worker 不重复，审批 ID 保持。
6. 冷恢复的 run 活动槽位已变化，旧 warm 提议仍会失效；重新建立冷新轮次通过 current=true，Goal 本身也仍有效。

首次 smoke 把修改后的源码在冷恢复期间视为不会自动重检，已改为还原相同内容再核验 no-repeat；随后正确区分 cold 槽位变化导致的提议过期与 Goal 就绪来源。不修改生产恢复行为，不重复付费模型。

最终 worker 调用 2 次、显式 observer 5 次、gate 决定/节点退出 0，doctor=true。临时证据 `/tmp/cord-stage47-real-result.json` 与 `/tmp/cord-stage47-browser-result.json` 保存运行与截图定位，不提交模型正文、截图或运行数据。

## 浏览器与限制

Playwright/Chrome 在 1440、390、320 宽度检查最新有效轮次与 Goal 来源导航，无横向溢出、pageerror=0；桌面/手机截图保存并核对。人工审批保持未决。

证据身份只覆盖声明输入和实际检查，不能证明完整业务验收或抵抗恶意 worker；原日志未持久化、完整交付覆盖与资源治理仍需继续完善。持续目标 active。
