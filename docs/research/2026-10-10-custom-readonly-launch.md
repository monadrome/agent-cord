# 自定义 headless 只读启动：配置与 Human Review 指南

## 动机与行为

同一个 wrapper 可能承担实现、评审和最新快照协调。原自定义 args 不消费 task.readonly，只读评审会收到与实现相同的启动参数；普通 resume 也不能证明只读恢复已映射。

现在按可写/只读与新会话/显式恢复选择完整 argv，公开能力分别说明只读启动和恢复映射。宿主 Goal 继续负责实际检查、修复和交付指南；最终 review gate 保持人工。协议决策见 [ADR-0080](../adr/ADR-0080-custom-readonly-launch.md)。

## 配置

```yaml
agents:
  custom:
    kind: headless
    bin: your-wrapper
    args: [run, --model, '{{model}}', --effort, '{{effort}}', '{{prompt}}']
    readonly_args: [review, --model, '{{model}}', --effort, '{{effort}}', '{{prompt}}']
    resume_args: [resume, '{{resume_session_id}}', --model, '{{model}}', --effort, '{{effort}}', '{{prompt}}']
    readonly_resume_args: [review-resume, '{{resume_session_id}}', --model, '{{model}}', --effort, '{{effort}}', '{{prompt}}']
    launch: {model: your-model-id, effort: high}
```

命令和值为形态示例，须替换为 wrapper 实际支持的接口。四种分支互不追加：

| 任务 | 启动参数 |
|---|---|
| 可写新任务 | args |
| 只读新任务 | readonly_args；未声明时保留 args |
| 可写显式恢复 | resume_args，必须绑定指定 session |
| 只读显式恢复 | readonly_resume_args；没有独立 readonly_args 时，也可用含 readonly 占位的 resume_args |

支持统一模式参数的 wrapper 可仅声明 args/resume_args，两者都传 `--readonly, '{{readonly}}'`。替换值是文字 true/false，不推断其他枚举。模型/effort 必须在所有声明分支一致；基本 args 使用 prompt 时，其他分支也必须保留。readonly_resume_args 要求同时声明 readonly_args 与 resume_args。未知占位、缺 session、分支漏映射或模板形态混入自定义分支均拒绝别名。

完整启动旋钮现还支持provider、bare/auto、角色/系统提示/JSON和轮次/费用参数；基本args声明的所有旋钮须在其他完整分支一致映射。只读auto值强制false，未配置占位值仍拒绝；参数不证明OS隔离或底层额度执行，宿主Goal保持独立。详见 [完整Wrapper配置与人审指南](./2026-10-10-custom-launch-knobs.md)。

参数直接传 subprocess，不经过 shell，仅替换一次；prompt 内的占位或 shell 文字不执行。缺只读恢复映射时，driver.resume 在 spawn 前拒绝，不开新会话或回退可写恢复。库的外部 HeadlessCliTemplate 必须显式声明 supports_readonly/supports_readonly_resume，普通 supports_resume 不作推断。

## 能力与迁移

`GET /api/v1/agents` 与控制台 Agent 能力详情展示 `readonly_launch: mapped/unmapped`、`readonly_resume: supported/unsupported`。这些字段只证明适配器声明了参数映射；安装状态仍为 unchecked，原始 args 没有自动探测。ACP 继续使用协议能力，不增加虚构的 CLI 映射字段。

旧无分支的新任务 argv 不变；旧可写 resume 不变。旧配置只声明普通恢复而没有 readonly 映射时，显式只读恢复现在拒绝，configuration_hash 可能变化。添加真实分支或模式占位后显式 reload；新 run 使用新配置，在途 resolver 固定原配置。冷恢复、未退出 checkpoint、协调提议和审批按现有身份规则重新核验；不删除历史或回滚已退出节点。

参数映射不提供 OS 沙箱，也不能保证 wrapper 尊重模式。现有跨 driver 只读工具审计继续拒绝写工具与未知命令，违规落不可重试 driver failure；通知后的副作用不能撤销，未报告的工具不能由本层证明不存在。

## Human Review

1. 检查 [custom-template.ts](../../src/driver/custom-template.ts) 的四分支选择、model/effort/prompt 一致性、session 必需和单次替换；确认未使用 shell。
2. 检查 [headless.ts](../../src/driver/headless.ts) 的显式只读恢复声明、spawn 前拒绝与 argv/null 配置身份；[agents-yaml.ts](../../src/driver/agents-yaml.ts) 的无效别名不回退内置行为。
3. 检查 [ports.ts](../../src/core/ports.ts) 与 [schema.ts](../../src/core/schema.ts) 的可选严格能力字段，以及 [AgentCapabilityDetails.tsx](../../apps/console/src/pages/AgentCapabilityDetails.tsx) 的声明/安装状态展示。
4. 运行 [custom-template.test.ts](../../tests/driver/custom-template.test.ts) 与 [custom-readonly-launch.test.ts](../../apps/server/tests/custom-readonly-launch.test.ts)：四种实际 subprocess argv、模式文字、缺映射无进程、配置快照、Goal 宿主检查、只读工具违规不重试、修复后仅重新评审和最终人工 gate。
5. 控制台 `/#/agents` 搜索 wrapper 并展开能力；检查已映射、不支持恢复与旧 unmapped 三种状态。需求审批页应仍待人工，不提交批准、采用或合入。

## 验收证据

- 最终全量 1326 项 / 90 文件、typecheck/build:all、git diff --check 通过；42 项定向回归包含外部模板默认拒绝、实际无进程与可写兼容，相关七份文档的 101 个本地链接通过。完整记录见 [progress.md](../../progress.md)。
- 隔离 TCP HTTP 流程实际执行实现、宿主业务值检查、只读评审与最新 PRD 协调：wrapper 调用分别为 write/false、review/true、review/true，模型和 effort 均保持 fixture-model/high。review.md 保留宿主实测证据，无人工决定，只有 deliver 节点退出，doctor 通过。
- PRD 更新发生在首次 ready 之后；该 ready 是历史证据，不能冒称仍对应新需求。新协调 current=true 只表示它基于最新快照提出 wait，不放行旧审批。
- Playwright 在 1440/390/320 宽度通过五张截图与状态断言，无横向溢出/pageerror，能力展示没有自动发起 inspect；桌面和最窄截图已查看。

本次验证使用确定性离线 wrapper，不调用真实 LLM，不证明厂商 CLI 对权限参数的实现。临时验收结果定位于 `/tmp/cord-stage66-real-result.json`、`/tmp/cord-stage66-browser-result.json`，脚本/截图/运行数据不入仓库。原真实开发 Draft 未操作；合入、发布与关键 gate 仍待人工。
