# ADR-0076 ｜ 活动 run 的人工等待投影

- 状态：accepted
- 日期：2026-10-10
- 关联：ADR-0021（操作登记）、ADR-0030（审批版本）、ADR-0048（协调执行观察）

## 问题

run 在 SQLite 初始登记为 running，直到 executor 返回才登记状态。正常人工 gate promise 挂起期间，需求事件投影已 waiting_human，getRun/listRuns/协调却仍 running。仅在 ask 回调改登记会留下 gate.waiting 已可见但 ask 尚未进入的窗口，且必须维护额外的恢复状态同步。

## 决策

新增 server 纯投影：仅当 run 仍占据本服务的活动槽位且登记为 running/waiting_human，核验本 run 的 workflow.run.started 绑定，再用同一次事件读取中的当前同 workflow/revision gate.waiting 判断是否仍需人工输入。有效 human.decision.recorded 绑定 waiting_event_id/evaluation_hash/允许选项后不再等待输入，后续 gate/resume 自行处理；选择不等于 gate 放行。invalidated/resolved/cancelled 继续由既有共享审批扫描消除等待。终态登记不被投影覆盖，历史/其他 run 不借用当前等待。

getRun 与新 readRuns 查询方法消费该投影，REST 列表/dashboard/active_run 使用只读查询方法；现有同步 listRuns 保留操作登记用途，不作为 REST 展示来源。latestRun 在提供同批 events 时共用投影，协调 run.status 与任务/Goal 来自同一批事实；active 槽位保持 true，等待人工不代表进程已收束或 lease 已释放。

活动查询无法读取严格事件流、启动绑定缺失/冲突或当前等待结构不可验证时拒绝，不把旧索引 running/等待冒充最新。查询不写事件、不写完成时间、不产生人工决定、不解除 workspace lease，不改变节点推进/授权预算。SQLite 状态仍由既有执行完成/冷恢复流程维护。

异步读取结束后重新读取操作登记，若期间取消或结束，保留更新后的终态，不用之前的running副本复活查询。其他run的迟到取消不会清除当前人工等待；多个人工等待逐项核验，不因第一项合法而忽略另一项坏结构。

## 验证

覆盖 gate.waiting 落盘后 ask 前窗口、有效/错误/其他等待人工决定、继续执行下一 worker、失效重验、新人审、取消/终态、冷恢复/索引重建、跨 run/revision、事件读取故障。实际 TCP HTTP 核验单 run/列表/需求 active_run/协调一致，原 Draft 不操作。
