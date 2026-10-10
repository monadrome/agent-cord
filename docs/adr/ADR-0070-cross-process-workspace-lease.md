# ADR-0070 ｜ 跨进程 workspace 执行锁与异常释放标记

- 状态：accepted（本地执行互斥原型）
- 日期：2026-10-09
- 关联：ADR-0069（workspace 单槽）、ADR-0020（事件单写者）、ADR-0025（进程收束）、ADR-0063（原授权恢复）
- 来源：同 root 双 server 和 SQLite 实测；detached worker 在持有进程强杀后仍可存活

## 背景

ADR-0069 的内存 lease 只能防同一个 RunService 实例中的并发。另一个 server 指向同 root 时可以获得自己的槽位，导致共享源码并发写入。平台已依赖 Node 内置 SQLite，但主索引不能持有贯穿 agent 执行的写事务，否则会阻塞 REST 幂等与运行登记。

SQLite 在持有进程退出时自动释放锁，但 agent 与验证命令使用 detached 进程组，可能在宿主强杀后仍运行。文件锁被释放不证明执行副作用已结束；直接抢占崩溃后的锁会重现同目录并发。

## 备选方案

1. 保留内存 lease，依赖操作者避免双 server。
2. 用 PID、mtime 或心跳到期回收普通文件锁。
3. 独立 SQLite 事务提供实时互斥，正常执行另写异常释放标记；异常退出保留标记，直到核验遗留进程。

## 决策

采用方案 3，替换 ADR-0069 的锁载体。`WorkspaceLease` 在真实 root 的 `cord/.index/workspace-lease.sqlite` 持有 `BEGIN IMMEDIATE`，使用零 busy timeout，不阻塞事件循环等待锁。独立数据库与主索引隔离，不新增依赖、core schema/ports 或授权事件。锁目录、数据库/sidecar/标记需为普通文件边界；root 路径别名不能绕过互斥。

获取 SQLite 锁后独占创建 `workspace-lease-owner.json`，写入随机 lease_id、req_id、run_id 并 fsync 文件。只有标记落盘成功才允许派发；没有 PID/mtime/过期时间自动回收规则。正常释放必须匹配内存 owner 和标记全文，删除标记后 rollback/close。owner 错误不能释放，标记被更改时保留异常状态并报告错误。异常退出留下标记，即使 SQLite 锁已释放也不能启动新 worker。

busy 是 409。已有授权恢复每秒重新进入原恢复器核验事实、配置、输入与剩余预算，不创建新的 run/授权，不重放模型；跨实例正常释放后也能自动继续。关闭停止定时检查并等待活动执行器收束。锁损坏/IO 是 500；未确认释放是 409 且不进行 busy 循环，恢复派发停止并提供具体诊断。所有 workflow 状态事实仍经 `session.events.append`。

新启动、协调采用、Goal 新授权和显式恢复在原事实追加前获取锁，继承 ADR-0069 的零额外事实拒绝行为。锁文件/标记属于运行资源，不作为 workflow、人工审批或 Goal 预算的事实来源。

## 理由

1. SQLite 本地事务已提供经过验证的互斥和崩溃锁释放，无需自制 PID 生命周期算法。
2. 主索引独立，长执行不阻断 API 的幂等与运行登记。
3. 异常标记使不确定的副作用 fail-closed；不能以宿主死亡或心跳过期推断 detached worker 已结束。
4. 只有 busy 自动重检，环境故障和异常退出明确停止；正常路径无需人逐次调度恢复。

## 被否方案

- 内存锁不能覆盖第二个实例。
- PID/mtime/心跳自动抢占既有 PID 重用风险，也无法证明 worker/验证子进程结束。
- 只用 SQLite 锁允许宿主强杀后另一个 worker 与遗留进程并发。
- 主索引长事务会把正常幂等写命令误变成锁冲突。

## 验证与限制

覆盖同 root 两个 server、真实双进程 HTTP、root 别名、owner 幂等/错误释放、busy/损坏/目录/链接、正常释放/强杀、detached 子进程存活时拒绝新执行、标记变更拒绝释放、跨实例自动原授权恢复，以及已有取消/关闭/Goal 授权/预算回归。

该能力仅约束遵循协议的本地 agent run，不提供 worktree、OS/network sandbox、远程/NFS 分布式锁或抗恶意 worker 证明。仍不支持同需求多 daemon 并发写事件、审批和独立协调。多副本会影响共享索引/事件投影，此锁不将整套 server 升级为多副本服务。

异常退出后，应停止同 root 的 server 并核验遗留 worker/验证进程、源码和副作用，再修复 owner 标记；不能在活动执行器存在时删除/替换 `.index`、数据库或标记。修复锁不自动授权新预算，恢复仍遵守原 run 的来源和输入验证。本原型不提供自动未知副作用对账或电源故障下的文件树事务保证。
