# Agent 能力查询生命周期与 Human Review 指南

能力查询是诊断入口，不应因为多端重试而并发启动多个 CLI。AgentService 以单实例 slot 复用同配置/timeout 的在途查询；不同配置或 timeout 409，完成结果不缓存。ACP/Headless inspect 支持取消，Fastify `preClose` 先取消并等待，关闭后返回 `service_closing`。

查询不发送 prompt、不调用 worker、不授予工具权限；结果不写事件或 workflow 事实。CLI/ACP 进程由 driver 清理，查询 current 仍绑定固定 revision/configuration_hash。原始 args 无显式 probe profile 时不猜 `--help` 语义。

人审重点：`AgentService.inspect/close` 的 slot key、共享结果副本、冲突和关闭归一化；`HeadlessDriver.inspect`/`AcpDriver.inspect` 的 AbortSignal、timeout、进程/连接清理；`app.ts` 的 preClose 顺序。ACP查询也不调用worker的onSession回执钩子；后续实际run仍报告它自己的session。

`apps/server/tests/agent-inspection-lifecycle.test.ts`的11项测试使用真实CLI/ACP fixture与TCP HTTP，覆盖不同幂等键及省略/显式5000ms的共享、timeout/Agent冲突不spawn、重载期间新配置冲突、失败/超时后释放、close/preClose取消与实际PID退出、结果副本和关闭时reload拒绝。`tests/driver/launch.test.ts`另验证ACP预取消不spawn、取消挂起session/new后的清理/再查询，以及查询与worker回执隔离。服务级mock只验证控制逻辑，不代替进程和HTTP证据。

关闭AgentService时HTTP查询返回503 service_closing；整个server关闭还可能提前断开TCP连接。连接错误不是已送达503的证据，app.close验收同时核验关闭完成和PID退出。隔离实际HTTP验收中，两种查询均收到503，CLI关闭耗时约2秒、ACP约23ms，未等10秒deadline，PID都已退出。

最终验证：`npm test`1306项/88文件、`npm run typecheck`、`npm run build:all`和`git diff --check`通过。证据在`/tmp/cord-stage65-final-tests.json`与`/tmp/cord-stage65-real-result.json`；后者确认共享只执行一组version/help、冲突409、后续新查询重新执行，并记录两种协议关闭结果。没有付费模型调用、没有新增需求/模型prompt，原真实Draft未操作。

slot只约束单AgentService。单HTTP调用方断开不取消其他共享调用方；不覆盖跨daemon、主动脱离进程组的wrapper或外部副作用。诊断声明与配置current不证明实际模型/认证可用，完成结果不缓存，后续显式查询才重新观测外部状态。
