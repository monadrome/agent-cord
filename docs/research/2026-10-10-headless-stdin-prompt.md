# Headless标准输入Prompt：Human Review指南

## 依据与行为

[OpenAI官方非交互文档](https://developers.openai.com/codex/non-interactive-mode)明确区分prompt-plus-stdin与`codex exec -`：后者让stdin成为完整任务输入。[官方命令页](https://developers.openai.com/codex/developer-commands)与本机Codex exec/resume帮助确认`-`语义。两份页面已实际抓取正文，研究缓存保留本机，不将搜索摘要当唯一依据。

内置Codex的新任务/指定session恢复统一把固定`-`作为prompt参数，真实task.prompt通过execa.input写stdin；model/effort、readonly沙箱、approval配置仍在原位置。原文按UTF-8发送，不增加换行、不经shell或中间文件，`--help`、`-`、`resume`、多行Unicode和字面量都作为数据。CLI帮助查询仍忽略stdin，只运行version/help，不调用模型。

Headless模板可声明`prompt_input: argv/stdin`，缺省为原argv行为；原生模板拥有输入协议，agents.yaml的template形态不能覆盖。自定义args形态可显式选stdin，所有new/readonly/resume分支共用，禁止任何prompt占位；固定`-`或专有stdin参数须由真实wrapper接口支持，宿主不猜测。

## 配置

```yaml
agents:
  codex-worker:
    kind: headless
    template: codex
    launch: {model: writer-model, effort: high}
    readonly_launch: {model: review-model, effort: low}
  stdin-wrapper:
    kind: headless
    bin: /absolute/path/to/your-wrapper
    prompt_input: stdin
    args: [run, --model, '{{model}}', --readonly, '{{readonly}}', '-']
    resume_args: [resume, '{{resume_session_id}}', --model, '{{model}}', --readonly, '{{readonly}}', '-']
    launch: {model: writer-model}
    readonly_launch: {model: review-model}
```

命令、模型与旗标是形态示例，须替换为实际wrapper接口。stdin不能再使用`{{prompt}}`；argv模式保持旧占位行为，不支持stdin的工具不能通过空输入降级。stdio只表示进程输入，和ACP JSON-RPC传输是不同维度。

明确模板通道进入公开capabilities.prompt_input和严格流程Agent观察，控制台“任务输入”显示标准输入/命令参数；无声明旧模板不补造核验事实。stdin通道额外进入launch_configuration_hash，再由既有v4完成策略绑定：相同静态argv的stdin与argv身份不同。旧argv-only配置identity保持，内置Codex因argv与通道变化而让旧未退出任务/审批/协调重验。两套profile/revision/完整恢复映射仍独立，热重载保持在途resolver，cold合法完成不重复；已退出节点不回滚。

## 审查入口

1. [headless.ts](../../src/driver/headless.ts)：Codex固定sentinel、template通道/能力/身份、实际stdin、帮助忽略输入、timeout/取消/完整退出。
2. [custom-template.ts](../../src/driver/custom-template.ts)、[agents-yaml.ts](../../src/driver/agents-yaml.ts)：明确自定义通道、所有分支禁止prompt占位、模板禁止覆盖、无效同名别名不回退。
3. [ports.ts](../../src/core/ports.ts)、[schema.ts](../../src/core/schema.ts)：可选typed能力与严格协调投影；[控制台详情](../../apps/console/src/pages/AgentCapabilityDetails.tsx)只展示映射。
4. [driver测试](../../tests/driver/stdin-prompt-input.test.ts)：17项真实字节/四组合/两套模型/特殊输入/旧身份/错误声明/背压timeout与abort/无prompt帮助。
5. [真实TCP测试](../../apps/server/tests/stdin-prompt-input.test.ts)：4项内置/custom Goal/readonly/最新PRD/cold/重载失效、固定resolver与query幂等/错误修复。
6. [ADR-0092](../adr/ADR-0092-headless-stdin-prompt-input.md)、[核心Feature](../core-features.md)、[示例](../../examples/agents.yaml)：产品/恢复边界。

```bash
npx vitest run tests/driver/stdin-prompt-input.test.ts apps/server/tests/stdin-prompt-input.test.ts
npm test
npm run typecheck
npm run build:all
git diff --check
```

完整实际验收与UI截图记录见[progress.md](../../progress.md)。离线fixture不调用付费模型，既有7306真实Draft不操作；测试/截图/运行数据只留临时目录。

阶段80最终1594项/115文件、typecheck/build:all/diff通过，17项driver/4项TCP stdin回归全绿。隔离实际HTTP PID41358、http://127.0.0.1:51602：writer-model/high到review-model/low，prompt UTF-8字节精确、原文不在argv，probe三次stdin为空；cold不重复，PRD更新B后旧协调失效、同review/new模型生成current/wait。审批1/人工决定0/采用0/仅deliver退出/doctor=true/付费0。Playwright 1440/390/320三视口能力详情显示“标准输入”，无横向溢出/pageerror，截图位于`/tmp/cord-stage80-agents-{1440,390,320}.png`；结果`/tmp/cord-stage80-real-result.json`、`/tmp/cord-stage80-browser-result.json`、测试`/tmp/cord-stage80-tests.json`。旧ready不冒称重新验收B，原7306真实Draft未操作。

## 限制

stdin减少进程argv暴露与误触CLI解析，不证明厂商不保存prompt、外部wrapper读取正确或提供OS隔离。原生worker仍按既有协议记录prompt_excerpt，模型/角色启动参数也仍在argv；不把stdin描述为凭据保密机制。外部agent可能回显stdin到输出或日志，现有产物/证据边界仍需核验。独立协调继续禁工具，Goal宿主自测、预算与最终人工gate独立生效；PRD变更后的current wait不批准旧ready交付。
