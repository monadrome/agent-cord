# ADR-0079 ｜ Agent 能力查询去重与关闭生命周期

- 状态：accepted
- 日期：2026-10-10
- 关联：ADR-0025、ADR-0074、ADR-0077

AgentService 对同 revision、configuration_hash 和 timeout 的在途查询共享一次 driver 探测；不同 Agent、配置或 timeout 返回 409，不排队，完成结果不缓存。REST 同一 Idempotency-Key 仍按既有协议重放。ACP/Headless inspect 接收 AbortSignal；Fastify `preClose` 先取消并等待查询、进程树和协议连接收束，关闭后返回 `service_closing`。

查询不发送 prompt、不调用 worker、不授予工具权限，也不写 workflow 事实。诊断快照仍用 revision/hash 核对 current；自定义原始 args 没有显式 probe profile 时不自动猜测。该 slot 仅约束单服务实例，不替代跨进程锁或 OS 隔离。

验证覆盖同配置不同幂等键、不同 timeout 冲突、失败/超时释放、预取消、关闭 503、CLI/ACP 进程收束和正常 run/协调不受影响。
