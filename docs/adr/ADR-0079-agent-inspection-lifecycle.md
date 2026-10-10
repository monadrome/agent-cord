# ADR-0079 ｜ Agent 能力查询去重与关闭生命周期

- 状态：accepted
- 日期：2026-10-10
- 关联：ADR-0025、ADR-0074、ADR-0077

AgentService 对同 revision、configuration_hash 和 timeout 的在途查询共享一次 driver 探测；不同 Agent、配置或 timeout 返回 409，不排队，完成结果不缓存。REST 同一 Idempotency-Key 仍按既有协议重放。ACP/Headless inspect 接收 AbortSignal；Fastify `preClose` 先取消并等待查询、进程树和协议连接收束，关闭后返回 `service_closing`。

查询不发送 prompt、不调用 worker、不授予工具权限，也不写 workflow 事实。诊断快照仍用 revision/hash 核对 current；自定义原始 args 没有显式 probe profile 时不自动猜测。该 slot 仅约束单服务实例，不替代跨进程锁或 OS 隔离。

ACP查询不调用worker的onSession回执钩子。预取消不启动进程，查询成功/失败/取消后的slot释放均等driver清理结束；同一查询的结果为独立副本。在途重载可使旧查询current=false，关闭之后不提交新registry。

实际TCP HTTP和子进程回归覆盖不同幂等键及省略/显式5000ms共享、不同timeout/Agent冲突、重载快照、超时/失败后的再查询、关闭503、Fastify preClose及PID收束；driver回归覆盖ACP预取消/挂起取消和worker回执隔离。

服务关闭会关闭TCP连接，客户端可能收到service_closing响应，也可能只观察到连接断开；不能仅凭连接错误声称503已送达。单独AgentService.close的HTTP验收确认503，完整app.close的验收同时检查关闭完成及实际PID退出。此边界不扩大为跨daemon互斥或副作用回滚保证。
