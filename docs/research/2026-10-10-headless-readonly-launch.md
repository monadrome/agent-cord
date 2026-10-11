# Headless独立只读启动配置：Human Review指南

## 配置

内置CLI模板与自定义wrapper均可声明完整readonly_launch：

```yaml
agents:
  dual-worker:
    kind: headless
    template: claude
    launch:
      model: writer-model
      effort: high
      agent: writer
      max_turns: 8
      budget_usd: 3
      auto: true
    readonly_launch:
      model: review-model
      effort: low
      agent: reviewer
      max_turns: 2
      budget_usd: 1
```

名称/模型/角色须替换为本机真实可用配置；角色可能依赖外部文件或明确agents_json。只读任务/原生恢复用readonly_launch完整替代knobs+launch，省略的字段不继承执行配置；空独立配置使用CLI默认值，不证明默认模型是什么。自定义完整args若用model/role等必需占位，独立配置也必须给足值，缺失拒绝，不退回writer。

两套配置分别按模板能力校验。Claude只读强制plan和读工具白名单，Codex保留read-only参数，Kimi保留plan参数；auto只读优先关闭，bare不默认开启。readonly_launch配置字段与capabilities.readonly_launch=mapped是不同含义：前者选择参数，后者说明只读模式已有映射，独立配置不代表OS隔离。

## 身份、恢复与查询

显式独立配置用headless.v3绑定四种有效argv及context_revision，空配置也与未声明区分。旧无readonly_launch的v1/v2身份、参数和能力元信息保持不变。模型/角色/有效参数变更使旧任务、协调和审批重检；热重载保留在途resolver，cold合法输入复用有效任务，历史已退出节点不回滚。

无prompt CLI帮助查询接受readonly=true。实际命令仍为固定version/help，模型/角色/预算原文不进入查询argv；cli_observation.configured按所选完整配置投影，advertised是CLI帮助证据，不能作为模型权限/额度、实际role加载或原生恢复成功的证明。原始args无明确帮助profile时server拒绝此模式，不猜--help语义。typed client旧name/key调用兼容，第三input可选择任务模式。

控制台可查询的独立配置显示“执行配置/只读配置”。不同mode在途查询409、相同mode/配置/timeout可共享，幂等重放绑定原body；结果标实际mode，跨mode历史标“其他任务配置”，与最新revision/hash共同核验。取消/服务关闭在结果返回前收束诊断进程，query不能占worker槽位或改变执行身份。

## 审查入口

1. [headless.ts](../../src/driver/headless.ts)：独立typed配置、完整替换、new/resume argv选择、v3/旧hash兼容、help按profile投影而不发模型参数。
2. [agents-yaml.ts](../../src/driver/agents-yaml.ts)、[ports.ts](../../src/core/ports.ts)：两种headless形态注册、能力共享语义、非法同名别名阻断。
3. [agent-service.ts](../../apps/server/src/services/agent-service.ts)：readonly query仅接受ACP/明确cli_help，mode共享key/关闭/重载边界；原始args拒绝，默认响应兼容。
4. [驱动测试](../../tests/driver/headless-readonly-profile.test.ts)：14项真实Claude/Codex/Kimi与custom参数、新任务/指定resume、未支持/缺值/空profile、旧hash/context_revision、所选帮助项。
5. [真实TCP测试](../../apps/server/tests/headless-readonly-profile.test.ts)：5项Goal自测/独立模型角色报告/最新PRD/cold等待、在途resolver、CLI query幂等/共享/跨mode冲突/重载/关闭PID清理。
6. [CLI展示](../../apps/console/src/pages/CliCapabilityObservation.tsx)、[能力详情](../../apps/console/src/pages/AgentCapabilityDetails.tsx)：所选配置与真实结果mode分开，历史不冒称当前所选。

最终完整验证与隔离实际预览见 [progress.md](../../progress.md)。临时证据`/tmp/cord-stage76-real-result.json`、`/tmp/cord-stage76-browser-result.json`只留本机，不入仓库。使用确定性离线fixture，不调用真实LLM；底层max_turns/budget_usd不证明额度执行，Goal宿主自测/资源边界、readonly工具审计和最终人工review独立生效。原真实开发Draft未操作。

阶段76全量1480项/106文件、typecheck/build:all/diff与151个本地文档链接通过。隔离HTTP三次调用为writer-model/high/writer/8轮/3美元参数、review-model/low/reviewer/2轮/1美元参数、最新PRD独立协调使用同review配置；auto分别true/false/false，宿主测试/指南有效，审批1/人工决定0/仅deliver退出/doctor通过。PRD更新后原ready只作历史，current协调仅代表依据新快照提出wait。Playwright1440/390/320十二截图/六查询验证所选配置、跨mode历史和表格底部滚动可见，pageerror为空、无横向溢出，截图已查看。
