# 跨进程 workspace 执行互斥

日期：2026-10-09

## 调研与证据

Node 的内置 `node:sqlite` 与现有 IndexStore 是兼容的实现基础。本地探针显示一个连接持有 `BEGIN IMMEDIATE` 时第二连接得到 `ERR_SQLITE_ERROR`、`errcode=5`，rollback 后可获取。独立 lock DB 可以保持长事务而不持有主索引的写锁；使用零 busy timeout，等待由宿主异步恢复器管理。

真实子进程回归进一步复现：强杀持锁宿主后，detached 子进程仍存活。故不能把 SQLite 自动释放视为安全重跑依据。当前方案在锁内独占写入 fsync 的 owner 标记，正常 executor 收束才删除；崩溃遗留和标记变化均 fail-closed，不猜 PID/mtime。

同 root 双 server 实例与真实双进程 HTTP 验证：占用时 409、被拒绝需求无启动事实；正常取消释放后下一 worker 一次调用、一个未决人工 gate、零人工决定/节点退出。另一实例的已授权恢复由每秒检查自动续跑原 run，不增加预算或要求人工重新调度。

## Human Review 指南

查看 `apps/server/src/services/workspace-lease.ts` 的 acquire/release：SQLite 与 owner 标记是否同时成功才派发，异常读取是否区分 busy 与 unresolved，错误 owner/篡改标记能否清掉他人占位。查看 RunService 的恢复 timer：只重检已有授权，每次重新读取当前事实、身份和预算，close 后不继续派发。

运行 `apps/server/tests/workspace-lease-lock.test.ts` 与 `apps/server/tests/workspace-lease.test.ts`。前者覆盖真实进程、强杀和 detached 存活，后者覆盖双 server HTTP、恢复、关闭与失败路径；Goal 授权/恢复预算由既有 `goal-retry.test.ts` 一起回归。测试没有调用付费模型，没有批准真实 Draft。

限制：锁不会隔离文件或网络，不能保证多 daemon 的同需求事件追加/审批/协调安全。异常 owner 标记需先核验遗留进程和副作用，所有同 root server 停止后才能修复；活动时删除 `.index` 或锁文件会破坏互斥。恢复锁资源与授予 Goal 预算是不同操作，任何恢复都保持原授权和最终人工 review。
