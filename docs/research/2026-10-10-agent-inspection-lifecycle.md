# Agent 能力查询生命周期与 Human Review 指南

能力查询是诊断入口，不应因为多端重试而并发启动多个 CLI。AgentService 以单实例 slot 复用同配置/timeout 的在途查询；不同配置或 timeout 409，完成结果不缓存。ACP/Headless inspect 支持取消，Fastify `preClose` 先取消并等待，关闭后返回 `service_closing`。

查询不发送 prompt、不调用 worker、不授予工具权限；结果不写事件或 workflow 事实。CLI/ACP 进程由 driver 清理，查询 current 仍绑定固定 revision/configuration_hash。原始 args 无显式 probe profile 时不猜 `--help` 语义。

人审重点：`AgentService.inspect/close` 的 slot key、共享结果副本、冲突和关闭归一化；`HeadlessDriver.inspect`/`AcpDriver.inspect` 的 AbortSignal、timeout、进程/连接清理；`app.ts` 的 preClose 顺序。离线与真实 HTTP 回归覆盖同配置不同幂等键只探测一次、不同 timeout 冲突、失败/超时释放、关闭 503 和正常 run 不受影响。

最终验证：`npm test` 1293项/87文件、`npm run typecheck`、`npm run build:all`、`git diff --check`和123项本地文档链接通过。推送因GitHub连接低速超时未确认远端，提交保留本地。

最终验证：`npm test` 1293项/87文件、`npm run typecheck`、`npm run build:all`、`git diff --check`和123项本地文档链接通过；原真实Draft未操作。
