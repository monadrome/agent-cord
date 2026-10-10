# ACP 配置一致性与 Human Review 指南

## 发现

现有驱动可校验设置回执，但后续 config_option_update/current_mode_update 只作 metadata。即使模型、effort 或权限模式改变，旧启动身份仍可伴随成功 result 进入宿主交付。新增反例首先复现 8 个失败点。另一个功能缺口是只支持 legacy modes，不能选择仅提供 configOptions 的 agent 模式。

公开 [ACP Config Options](https://agentclientprotocol.com/protocol/session-config-options) 规定配置设置响应/更新提供完整状态，category 仅用于 UX，新配置接口应优先于旧 modes。[Session Modes](https://agentclientprotocol.com/protocol/session-modes) 的 set_mode 成功响应为空，当前 mode 通知可能来自 agent 自行切换，不能发明必需确认通知。已安装 SDK 1.5.0 类型/消息处理顺序与上述结构已核对，通过 Firecrawl 读取文档；未调用付费模型。

## 实现

```yaml
agents:
  delivery-worker:
    kind: acp
    bin: your-acp-wrapper
    launch:
      model: your-model-id
      effort: high
      mode: code
      option_ids: {model: llm, effort: thinking, mode: workflow}
```

ID/值必须来自实际协议。mode 映射走新 set_config_option，不猜 category；省略 mode 映射时保留旧 modes/set_mode，空成功回执仅证明协议确认。readonly mode 仍只允许 plan；独立协调应使用适合只读的命名 agent，不沿用 code 模式配置。

每次 run/resume/inspect 都有独立 AcpLaunchState。new/load、当前 session 更新和设置回执共同确定完整状态；检查重复 ID/候选、非法默认值与类型。设置顺序是 mode、按 ID 排序的扩展、model、effort，每步依据最新候选；切换 mode 后新增的模型可选择，不会用初始 plan 列表误拒绝。扩展键序不改变实际设置顺序或有效配置身份。

开始 prompt 前所有显式选择一致，之后选择漂移、移除或改变类型会记录不可重试 configuration error、session/cancel 和进程树收束。后续恢复到原值或成功 result 不消除失败；漂移后的权限请求不会进入 worker 裁决器。未选默认值可自适应，同值与外部 session 更新不误判。宿主不写回成功指南、不继续自测或消耗自动重试预算，不形成 Goal ready/协调提议。

已经开始的权限裁决在返回结果前也重查收束状态，漂移期间迟到的允许改为 cancelled；不把先前异步裁决当作当前权限授权。

显式 launch 使用 v5 域并绑定 explicit-session-selections.v1 状态策略，旧 v4 任务会按既有配置新鲜度重新核验；无 launch 的默认 ACP 身份保持原域。协议状态不能证明真实底层 LLM、模型权限或额度，也不能隔离进程与回滚已有副作用。异步通知可能在 prompt 发出后才被宿主观察；保证是观察到矛盾后取消并拒绝成功，不能承诺零模型消耗或零副作用。

## 人审与验收

优先读 `src/driver/acp-launch.ts` 的完整状态/选择检查和 `acp.ts` 的 session 过滤、seal、错误取消；然后看 `coordinator.ts` 对 configuration/permission 不可重试的持久处理。设置策略/哈希先于恢复或结果消费，模型文字不参与能力正确性。

`tests/driver/launch.test.ts` 使用真实离线子进程验证纯 config-only/无 category mode、legacy 空回执、动态候选、模型/effort/mode 漂移、恢复原值、同值/未选/外部更新、原生 resume、重复结构、取消/权限/进程收束与键序。`goal-delivery.test.ts` 验证真实源码写入后的漂移不会自测或生成指南，冷恢复不重发；配置修复后新 run 实际测试通过，等待最终人工 review。`coordination.test.ts` 验证独立协调不接受漂移提议，修复后的轮次使用最新 PRD；真实 HTTP inspect 验证映射的 mode 候选与不发 prompt。

隔离 TCP HTTP 验收由 /tmp 临时脚本创建新 root，真实 failed worker 调用 1 次、冷恢复仍为失败；修复后总 worker 调用 2 次、宿主测试通过/审批 1/人工决定 0/节点退出 0/doctor=true。独立协调总 2 次，失败提议=null，第二次使用最新 PRD。临时日志、路径和脚本不入仓库；真实 Draft 未操作。

最终验证：`npm test` 1221项/82文件、`npm run typecheck`、`npm run build:all`、`git diff --check`、110项本地文档链接通过。临时证据 `/tmp/cord-stage61-real-result.json` 和 `/tmp/cord-stage61-final-tests.json`；预览重新加载最终代码后原待人审交付保持、worker仍为2次。
