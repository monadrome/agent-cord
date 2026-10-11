# 自定义Wrapper完整启动旋钮：Human Review指南

## 配置

自定义args可以显式消费既有typed启动旋钮，wrapper协议与厂商内置CLI分别适配：

```yaml
agents:
  custom:
    kind: headless
    bin: your-wrapper
    args: [run, --readonly, '{{readonly}}', --bare, '{{bare}}', --auto, '{{auto}}', --agent, '{{agent}}', --max-turns, '{{max_turns}}', --budget-usd, '{{budget_usd}}', '{{prompt}}']
    resume_args: [resume, '{{resume_session_id}}', --readonly, '{{readonly}}', --bare, '{{bare}}', --auto, '{{auto}}', --agent, '{{agent}}', --max-turns, '{{max_turns}}', --budget-usd, '{{budget_usd}}', '{{prompt}}']
    launch: {bare: true, auto: true, agent: architect, max_turns: 7, budget_usd: 2.5}
```

命令/flags是形态示例，必须由真实wrapper实现；不能把布尔值参数直接当某家CLI的无值flag。支持provider/model/effort、max_turns/budget_usd、system_prompt/agent/agents_json、bare/auto；只在基本args使用占位时声明能力。其他完整readonly_args/readonly_resume_args也须同旋钮集合，prompt/session规则见 [只读分支指南](./2026-10-10-custom-readonly-launch.md)。

launch继续严格校验类型、正资源值和非空角色；无占位的选项、漏值/错类型、其他分支新增或漏旋钮均拒绝注册，不回退同名内置配置。布尔值true/false（false不能被当成缺值），number转确定文字，角色/JSON/提示是单个argv。替换一次，不递归解释prompt或JSON里的占位/命令文本，不经过shell。

readonly任务及原生恢复中auto显式值强制false；bare保持显式值，不默认开启。映射表示参数生效，不表示wrapper遵守权限/隔离，宿主只读工具审计、源码/产物核验和最终gate仍生效。max_turns/budget_usd仅为底层传参，不证明实际费用上限已执行，也不取代run.goal的时长/尝试/usage预算。Goal始终是宿主交付生命周期。

## 身份与恢复

旧provider/model/effort-only的argv与hash不变。新增启动旋钮进入原四分支argv身份，变更角色、数值或bool会触发旧任务/协调/审批的新鲜度检查。driver深拷贝参数，reload不影响在途run；新协调固定最新resolver，cold相同输入复用合法任务，不重做有效工作，已退出事实不回滚。

显式session恢复仅选择完整resume分支并保留指定ID；没有只读恢复映射时拒绝，不回退可写会话或新session。原始args没有CLI帮助探测声明，公开能力只表明适配器声明/安装unchecked，不自动查询或启动模型。

## Human Review

1. [custom-template.ts](../../src/driver/custom-template.ts)：基本args能力推导、完整分支集合一致、缺值与单次String替换、readonly auto=false，确保无shell。
2. [headless.ts](../../src/driver/headless.ts)：typed launch与四argv hash、快照/显式session；[agents-yaml.ts](../../src/driver/agents-yaml.ts)无效同名别名不降级。
3. [驱动测试](../../tests/driver/custom-launch-knobs.test.ts)：21项真实四分支argv、bool/numeric/JSON、缺值与错类型无进程、漏分支/能力集合、原hash兼容和快照变化。
4. [TCP Goal测试](../../apps/server/tests/custom-launch-knobs.test.ts)：3项Goal自测/只读评审/最新PRD协调、cold等待不重做、角色重载使旧提议失效、在途角色固定、注册失败无worker/自测/人审、修复后交付。
5. 控制台`/#/agents`搜索wrapper并展开，查看bare/auto/角色/资源能力，应该没有自动inspect或原始角色正文；需求审批继续保持人工未决。

验收使用确定性离线wrapper，不调用真实LLM。最终全量与实际预览结果见 [progress.md](../../progress.md)，临时证据`/tmp/cord-stage75-real-result.json`和`/tmp/cord-stage75-browser-result.json`不入仓库；模型额度实际执行、厂商CLI权限与OS隔离仍需各适配器独立证明，原真实开发Draft未操作。

阶段75最终1461项/104文件、typecheck/build:all/diff与131个本地文档链接通过。隔离HTTP三次实际调用的bare=true、轮次7、费用2.5、角色architect均保持；auto分别true/false/false，最后一次读取最新PRD，review.md保留宿主测试证据。审批1/人工决定0/仅deliver退出/doctor通过。PRD更新后旧ready是历史证据，新协调current=true只表示基于当前快照提出wait。Playwright1440/390/320三截图无pageerror/溢出/自动inspect，桌面与最窄已查看。
