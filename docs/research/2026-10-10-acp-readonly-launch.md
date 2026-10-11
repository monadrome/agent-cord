# ACP独立只读启动配置：Human Review指南

## 配置契约

同一ACP别名可用不同的启动配置承担Goal实现和只读评审/协调：

```yaml
agents:
  worker:
    kind: acp
    bin: your-acp-wrapper
    launch:
      provider: writable-provider
      model: writable-model
      effort: high
      mode: code
      option_ids: {provider: provider, model: llm, effort: thinking, mode: workflow}
      config_options: {extended: true}
    readonly_launch:
      provider: review-provider
      model: review-model
      effort: low
      mode: plan
      option_ids: {provider: provider, model: llm, effort: thinking, mode: workflow}
```

bin/ID/值都是形态示例，必须使用wrapper真实协商结果。readonly_launch是完整替换；省略model/provider/effort会使用该session的默认值，不继承可写配置。新session与显式loadSession共用选择规则，工作流仍通过`readonly: true`表示只读任务。

注册时拒绝不支持的选项、缺/重复ID、非plan mode与非空扩展配置；动态候选、设置回执和执行中漂移仍在session核验。未声明readonly_launch继续继承launch与既有只读限制；原来code/扩展配置导致的readonly拒绝不会被隐式降级。空独立配置可声明，但不证明agent当前处于plan。

## 查询与恢复

`POST /api/v1/agents/:name/inspect`默认查询执行配置；body `{readonly: true}`查询ACP只读配置，必须带Idempotency-Key。结果增加readonly=true，默认响应维持旧形状；后续[Headless独立配置](./2026-10-10-headless-readonly-launch.md)也支持明确cli_help模板的按模式帮助查询，原始args仍拒绝。typed client第三参数传入该input，旧name/key调用保持兼容。

查询同快照/超时/任务模式可以共享一个在途探测，跨模式冲突409；幂等键重放绑定原body，不替换查询模式。查询不发prompt、不授予工具或调用worker session回调。控制台选择“执行配置/只读配置”，候选和实际mode来自server；切换模式后上次不同模式结果标“其他任务配置”。

新增profile使用ACP配置域v6，身份包含两套配置与顺序策略。任意分支变化都会使旧checkpoint/协调/审批重新核验；在途run继续使用固定resolver，无声明的旧配置身份与能力保持不变。新字段只说明独立声明，不提供OS隔离，也不满足headless专用的require_readonly_mapping。

## 审查入口

1. [acp.ts](../../src/driver/acp.ts)：两套严格注册、完整替换、对应session/inspect选择、v6配置hash和默认兼容。
2. [agents-yaml.ts](../../src/driver/agents-yaml.ts)、[ports.ts](../../src/core/ports.ts)、[schema.ts](../../src/core/schema.ts)：ACP专有字段、公开能力与协调严格元信息，未知/无效别名不回退。
3. [agent-service.ts](../../apps/server/src/services/agent-service.ts)、[contracts.ts](../../apps/server/src/contracts.ts)：mode共享key、false/缺省规范化、跨模式冲突、取消/重载与实际mode回执。
4. [AgentCapabilityDetails.tsx](../../apps/console/src/pages/AgentCapabilityDetails.tsx)、[agent-capabilities.ts](../../apps/console/src/agent-capabilities.ts)：可选择任务配置、历史mode与revision/hash共同核验，失败不冒称当前结果。
5. [驱动测试](../../tests/driver/acp-readonly-profile.test.ts)、[TCP交付/查询测试](../../apps/server/tests/acp-readonly-profile.test.ts)：实际设置顺序/新任务/原生恢复/注册拒绝无进程、两套身份、同别名Goal+报告+最新快照协调、固定resolver/冷等待、幂等/共享/关闭。

## 证据与限制

阶段71已通过1384项/96文件、typecheck/build:all/diff与124个本地文档链接。隔离实际HTTP的同别名调用为code、code、plan、plan；宿主失败后修复通过，review.md含宿主证据，findings.md由宿主代写；最新PRD协调提出wait。审批1、人工决定0，只有deliver退出，doctor通过。独立查询不发送prompt，执行候选含small/large，只读候选仅small。Playwright1440/390/320九截图/六次查询通过，包含执行、只读与跨mode历史，pageerror为空且无横向溢出，桌面与最窄截图已查看。

临时证据定位`/tmp/cord-stage71-real-result.json`与`/tmp/cord-stage71-browser-result.json`，最终检查见[progress.md](../../progress.md)。使用确定性离线fixture，不证明真实LLM权限/额度、wrapper执行前隔离或原生session无副作用。宿主Goal自测、源码/产物核验、readonly工具审计与最终人工gate仍独立生效，原真实开发Draft未操作。
