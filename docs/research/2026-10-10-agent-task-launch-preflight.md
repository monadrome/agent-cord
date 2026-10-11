# Agent任务启动前校验：Human Review指南

## 依据与行为

本机Codex 0.160.0的`codex exec resume --help`明确区分指定UUID/名称和`--last`选择最近会话。Headless过去只拒绝空session，因此`resume("--last", task)`会编译成选择最近会话的命令。新校验保留名称、空格与Unicode，不trim、不猜UUID；拒绝非字符串、空/全空白、C0/DEL控制字符，CLI额外拒绝`-`前缀。ACP使用结构化JSON-RPC，允许普通`-`前缀的session ID，非法ID在initialize/load前拒绝，不降级new。

Node的定时器对大于2,147,483,647、NaN或非正值会转换为1ms，小数也会截断，见[标准定时器说明](https://nodejs.org/api/timers.html#settimeoutcallback-delay-args)。两driver任务与直接帮助查询在spawn前核验正整数上限；只在timeout_ms未提供时使用默认预算，显式null不当作缺省。REST现有查询预算100到10000ms等更严格约束继续有效，不能通过本次上限扩大REST授权。

已经abort的任务返回一个取消error，不调用CLI、不读取MCP凭据、不生成result。取消优先于无效timeout/session。Headless还在模板编译后重读signal，模板期间取消不派发。此处的“零spawn”由调用计数核验，单凭没有PID文件不足以证明进程未启动。

## 审查入口

1. [task-preflight.ts](../../src/driver/task-preflight.ts)：两个纯参数校验器和固定错误，不回显传入ID/预算。
2. [headless.ts](../../src/driver/headless.ts)：取消优先、超时校验、原生resume与buildArgv、编译后的取消重检、帮助查询前置校验。
3. [acp.ts](../../src/driver/acp.ts)：MCP解析之前的取消/预算/session校验；显式resume(undefined)也不得进入new。
4. [task-preflight.test.ts](../../tests/driver/task-preflight.test.ts)：17项真实离线子进程/调用计数回归，覆盖run/resume、三个CLI/custom、合法名称、ACP不透明ID、非法值、取消与后续合法恢复、无prompt查询。
5. [ADR-0089](../adr/ADR-0089-agent-task-launch-preflight.md)：产品与兼容边界；[核心Feature](../core-features.md)保留宿主Goal完成审计和最终人工gate。

验证命令：

```bash
npx vitest run tests/driver/task-preflight.test.ts tests/driver/launch.test.ts tests/driver/custom-template.test.ts tests/driver/headless-inspection.test.ts
npm test
npm run typecheck
npm run build:all
git diff --check
```

阶段77的完整结果在[progress.md](../../progress.md)登记。临时JSON和实际运行证据保留本机，不提交凭据、环境、截图或运行目录。

最终完整1497项/107文件、typecheck/build:all/diff通过，包含17项新回归、原有真实TCP Goal交付/宿主自测/只读评审/最新快照协调/人工等待与恢复。生产代码在全量验证后没有再改；无新增UI行为，不重复阶段76截图。现有隔离预览health200，未操作原7306真实Draft。

## 限制

有效argv/configuration_hash、已发布流程、Goal预算/节点恢复和人工gate不变。Headless非法session保留参数编译错误抛出语义，ACP非法session返回configuration error；已取消任务不强行编造已加载session回执。厂商只读fork可能返回新session，参数校验不能证明agent正确加载了历史、识别原生turn checkpoint或提供OS隔离。已spawn任务的取消仍依赖协议取消和进程树清理，未知远端副作用不视为撤销。
