# Agent工作区隔离能力：Human Review指南

## 当前事实

Agent能力现在公开`workspace_isolation: shared_lease`。这表示 RunService 在同一工作区内使用 lease/跨进程锁防止并发执行器互相污染；worker仍可读写共享目录，OS、网络、Git worktree和外部副作用不在该声明范围。ACP与headless都返回相同值，Context Session Agent把它作为能力快照的一部分。

控制台 Agent 详情显示“工作区隔离：共享工作区（lease）”。这个字段不能变成绿色安全结论，也不代表 vendor CLI 的 sandbox 参数已经生效。需要真实隔离时应在后续 ADR 中增加 worktree/容器执行器、路径映射、清理/恢复和副作用对账，再单独声明 `worktree` 或 `os_sandbox`。

`GET /api/v1/workspace/lease` 是只读运行诊断：`free` 表示没有当前 owner，`held` 表示本进程持有活动 lease，`unresolved` 表示磁盘 owner 标记存在但当前进程没有可确认的执行器，`unavailable` 表示无法读取诊断边界。unresolved 必须先核验遗留进程和副作用，不是自动接管许可；诊断不会写事件或修改锁。

## 审查入口

1. [ports.ts](../../src/core/ports.ts)、[schema.ts](../../src/core/schema.ts)：严格能力枚举与协调投影。
2. [headless.ts](../../src/driver/headless.ts)、[acp.ts](../../src/driver/acp.ts)：当前两个 driver 的 shared_lease 声明。
3. [AgentCapabilityDetails.tsx](../../apps/console/src/pages/AgentCapabilityDetails.tsx)：静态能力展示，不发起额外探测。
4. [agent-context.test.ts](../../tests/coordinator/agent-context.test.ts)：能力快照包含隔离值、环境/argv/prompt不泄露。
5. [ADR-0093](../adr/ADR-0093-workspace-isolation-capability.md)：未来增强边界和不变量。
6. [workspace-lease-status.test.ts](../../apps/server/tests/workspace-lease-status.test.ts)：free/held/unresolved三种只读投影与无接管断言。

```bash
npx vitest run tests/coordinator/agent-context.test.ts tests/driver/launch.test.ts apps/server/tests/agent-registry.test.ts
npm test
npm run typecheck
npm run build:all
git diff --check
```

阶段82最终定向79项/全量1595项、typecheck/build:all通过；旧只读能力fixture缺字段的4项失败已补齐并重跑。当前两个driver与协调上下文均报告shared_lease，UI只展示事实，不生成隔离承诺。

阶段84新增运行诊断后，定向7项与全量1602项/117文件通过，typecheck/build:all/diff通过。free/held/unresolved状态均只读投影，不接管/释放锁；本接口不能证明外部 detached worker 已退出。

## 限制

shared_lease不是工作树隔离、容器沙箱或权限证明。它不能阻止未登记进程、外部 daemon、网络副作用或同 workspace 外部写入；强杀时 owner 标记仍需人工/宿主对账。最终人工 review、Goal 自测和关键 gate 不因该字段改变。
