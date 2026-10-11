# Workflow Agent能力准入：Human Review指南

## 配置

```yaml
run:
  agent: codex-implementer
  require_capabilities:
    transport: headless
    prompt_input: stdin
    native_resume: supported
    workspace_isolation: shared_lease
```

`require_capabilities` 是宿主准入条件，不是启动参数。流程 Agent 的公开能力快照必须逐项匹配；缺能力、未知值或配置被移除时协调只能提出 wait/ask_human，NodeRunner 会在 spawn 前写不可重试 configuration failure，checkpoint 复用也拒绝。字段与 `require_readonly_mapping` 是并列约束，两者都要满足。

支持的维度：`transport`、`prompt_input`、`native_resume`、`workspace_isolation`、`readonly_launch`、`readonly_resume`。当前两个 driver 的工作区能力是 `shared_lease`，stdin 只由 Codex/custom 显式声明，ACP 的 native resume 需要协议协商；这些静态声明不证明模型权限、额度、工具隔离或 OS sandbox。

## 审查入口

1. [schema.ts](../../src/core/schema.ts)：严格 requirement schema 与 workflow 发布校验。
2. [agent-context.ts](../../src/coordinator/agent-context.ts)：统一能力匹配函数与协调快照。
3. [coordinator.ts](../../src/coordinator/coordinator.ts)、[session-agent.ts](../../src/coordinator/session-agent.ts)：派发/checkpoint/eligible_nodes共同准入。
4. [测试](../../tests/coordinator/agent-capability-requirements.test.ts)：缺失/冲突/合法能力、stdin、workspace lease、只读映射、零调用和旧完成拒绝。
5. [ADR-0094](../adr/ADR-0094-agent-capability-requirements.md)：协议边界与未来隔离扩展。

```bash
npx vitest run tests/coordinator/agent-capability-requirements.test.ts tests/coordinator/readonly-mapping.test.ts
npm test
npm run typecheck
npm run build:all
git diff --check
```

缺省 `require_capabilities` 的旧流程保持原语义；实际 worktree/OS sandbox仍需独立执行器实现，不能只填字段宣称安全。

阶段83定向31项、全量1600项/116文件、typecheck/build:all/diff通过；无效能力不会启动driver或推进workflow。
