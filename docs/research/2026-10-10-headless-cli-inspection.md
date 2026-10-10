# Headless CLI查询与 Human Review 指南

## 判断与调研

原子能力识别需要区分声明与本机观测。原headless查询只返回适配器能力；即使二进制不存在也没有运行时诊断。新增固定版本/帮助查询能定位安装与CLI版本差异，又无需发送模型任务。

[OpenAI Docs CLI reference](https://developers.openai.com/codex/cli/reference)说明exec/resume与配置覆盖；本机Codex0.160.0的exec/help和exec resume/help实际核验。Claude2.1.220与Kimi2.1.1也仅调用version/help。本机Claude auto的choices带引号，新增反例并修正解析；max_turns未在帮助展示，但这不足以判定隐藏参数不支持。Codex --config是通用配置入口，不能证明effort配置键和模型能力。

## 已实现

内置模板声明`inspection_profile`为claude/codex/kimi；自定义库模板可显式声明兼容的查询profile。自定义YAML原始args不猜--help语义；它仍可通过命名模板或内置template+bin覆盖复用受支持方式。探测前后启动configuration_hash保持不变。

HeadlessDriver.inspect只使用固定命令、原bin/prefixArgs/env/cwd；不拼prompt/模型/effort/角色/预算参数，stdin关闭。Claude/Kimi用--version与--help，Codex用--version、exec --help、exec resume --help。所有命令共享一次deadline，每路输出最多128KiB，终止树另有有界grace；成功组长退出、失败或超时都清理同进程组后代。

版本只返回有限semver，原stdout/stderr/错误/路径不公开。选项只从定义行判定，不把示例正文的--model当旗标；auto只看permission-mode明确choices，支持引号/换行；Codex effort维持null。`advertised=true/false/null`分别表示帮助展示/未展示/无法由帮助核验。native_resume同样只描述入口展示，不证明实际恢复。

## 操作路径

1. Agent页展开内置headless或明确兼容模板，点击“查询 CLI 能力”。没有probe声明的原始wrapper不提供该按钮。
2. 查看CLI版本、每个查询步骤、帮助指纹及已配置项。缺二进制、失败、超时、无法识别都有独立结果，不显示为通过。
3. 修复安装/配置后重新查询；重载或刷新后的revision/hash改变，旧结果明确过期。查询期间重载保留原身份并current=false；幂等重放返回历史结果，不重跑CLI。
4. 模型/effort实际执行仍按已有严格launch与Goal审计，诊断不自动改模式、扩权限或放行人工gate。

REST复用`POST /api/v1/agents/:name/inspect`（Idempotency-Key、body={}或timeout_ms）。ACP观察仍在observation；CLI观察放在可选cli_observation，保留旧消费兼容。CLI失败诊断返回200结构化状态，HTTP失败另表示命令边界/名称等问题。current仅核验配置快照，不代表诊断成功。

## Human Review

- `headless-inspection.ts`：有限版本、选项定义/choices解析、advertised三态，不推断模型或隐藏参数。
- `headless.ts`：固定query argv与deadline/maxBuffer，stderr/raw不得暴露，成功退出的进程组清理。
- `AgentService.inspect`：CLI观察独立返回并沿用配置新鲜度，ACP行为兼容。
- `CliCapabilityObservation.tsx`与Agent详情：静态声明/CLI结果、configured/advertised、错误与旧身份分别展示，手机纵向布局。

离线fixture只接受固定帮助命令，收到模型argv直接失败；验证参数不泄露、缺CLI/错误/超量/未知格式、auto引号、描述误匹配、deadline、忽略SIGTERM子进程与成功父进程退出后的清理、修复后新调用。真实TCP HTTP fixture验证幂等与原始wrapper不猜命令；reload窗口保留旧身份。

## 限制

这不是模型访问、真实native resume、自测、OS隔离或外部二进制完整性证明。明确兼容profile的wrapper必须自己保证帮助命令不做模型任务或外部副作用；主动脱离进程组的子进程不在清理保证内。诊断hash和配置current不能检测后续外部CLI/凭据改变，执行时仍需重新校验结果。CLI不提供结构化能力接口，解析按已核验格式保守处理，不适配格式时标unrecognized/unknown。

最终验证：`npm test`1269项/85文件，typecheck/build:all/diff与120本地文档链接通过。实际本机HTTP查询Claude2.1.220/Codex0.160.0/Kimi2.1.1均passed、幂等一致，没有prompt或需求执行；Playwright1440/390/320七张截图验证CLI不可用/帮助未展示/过期重查/503历史结果，pageerror=[]、页面无横向溢出。临时证据`/tmp/cord-stage63-preview-result.json`、`/tmp/cord-stage63-browser-result.json`、`/tmp/cord-stage63-final-tests.json`，没有付费模型调用，原真实Draft未操作。
