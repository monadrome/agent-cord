# ADR-0097 ｜ 宿主检查的只读工作区沙箱

- 状态：accepted（原型已实现并验证）
- 日期：2026-10-11
- 关联：ADR-0056（Goal自测）、ADR-0061（ready来源）、ADR-0096（工作树）
- 来源：默认Goal交付与验证器隔离要求；Anthropic Sandbox Runtime调研及本机限制实测

## 背景

目前Goal命令直接在worker可写工作区执行，文件前后hash能拒绝结果漂移，但不能阻止检查本身改代码、访问宿主凭据或网络。独立worktree已经统一执行/检查/报告root，不提供OS权限限制。验证命令应能显式要求实际限制，且缺少限制时拒绝执行。

## 备选方案

1. 继续只做源码前后hash检查。
2. 自行生成Seatbelt/bubblewrap规则，或依赖Docker daemon。
3. 复用Apache-2.0的`@anthropic-ai/sandbox-runtime`，为每次宿主检查提供独立监督子进程和固定严格配置。

## 决策

采用方案3。Goal可选`check_sandbox: readonly_workspace`。未声明保持旧行为；声明时必须在macOS/Linux使用真实原生沙箱，不支持平台、依赖缺失、初始化/包装故障均为宿主环境失败，不执行裸命令，不自动放宽权限。

该模式限制整个检查进程树：工作区可读不可写，`cord/`与`.git`及linked公共Git元数据不可读取/修改；系统运行时目录可读，用户目录与其他临时工作区不开放。每次检查有独立临时HOME/TMPDIR，仅该scratch允许写入；网络、loopback、Unix socket与额外Mach/Apple Events权限关闭。检查继承最小PATH/locale环境，凭据、NODE_OPTIONS、shell启动与Git覆盖变量不传入。系统目录可能含敏感配置，不声称完整凭据隔离或虚拟机边界。

每个检查用独立可信监督子进程承载SandboxManager全局状态，避免不同run/root/检查配置互相覆盖；使用固定版本0.0.79的library argv包装及参数引用工具，宿主spawn仍shell=false，不调用srt CLI（其部分信号退出处理会转为0）。原命令参数在沙箱内部shell重解析时保持字面值，监督进程观察真实退出码/信号并收束native进程树。控制通道与测试stdout/stderr分开，实际输出hash/有界尾部沿用现有证据，setup失败不回显配置/凭据。

沙箱版本/策略进入`goalCommandHash`的新域，仅声明模式的检查采用新hash；Goal定义本身进入workflow/input identity。ready来源、恢复、协调与人审使用相同命令hash；旧裸检查无法满足新声明。指南标明实际模式及版本，模型自述不作为证明。检查隔离不改变worker能力为os_sandbox，也不替代最终人工gate。

## 理由（第一性原理推导）

Goal需要实际自测而不是报告；运行检查同时应限制可写范围与外部副作用。确定性的原生限制比prompt或事后审计更强，但必须说明信任与平台前提。既有检查编排、输出hash和ready核验可以复用；可选严格模式允许团队选择能在只读/无网络环境运行的检查。

## 被否方案的否决理由（逐一）

- 方案1不能阻止读凭据、网络或未知写入。
- 方案2引入自研平台策略，Docker daemon本机不可用；采用已有运行时更利于复用与平台扩展。
- 默认开启会阻断需要本地TCP/缓存写入的现有工程测试，不隐式修改已发布流程；需要cache/网络的更细策略后续单独设计，当前不自动开例外。

## 关键实现注意点

1. runtime为可选固定依赖，需要Node>=22.12；原裸检查与项目Node>=22.5保持兼容，未安装时严格模式fail-closed。
2. helper/运行时/系统工具是宿主信任边界。worker与宿主使用同一OS用户，不能宣称恶意worker无法修改helper、test脚本、已声明验收或恢复文件；验证器仍需独立可信部署与只读测试资产。
3. 源码修改、cancel/timeout、setup失败、signal/nonzero都不能成为passed；检查准备、监督执行和收束纳入既有命令/Goal预算，关闭后不留执行进程。
4. 临时HOME/cache不归源码，不入事件或Git，收束后清理；清理失败不默默将其当成功，保留故障。
5. Linux必须具备bubblewrap/必要原生依赖；本轮macOS实际限制验证，其他平台不靠mock声称已验证。runtime仍是research preview，限制需要版本锁和真实回归。
6. 检查bin/args拒绝NUL，避免准备临时目录后spawn同步异常泄漏；其他字面参数保持原文。runtime会覆盖TMPDIR为共享/tmp/claude，包装在沙箱内用env明确重设本次HOME/TMPDIR并禁止共享目录写入；stdio与必要设备仍按runtime规则开放。

## 证据来源

1. [官方runtime](https://github.com/anthropics/sandbox-runtime)全文由Firecrawl search --scrape获取，未重复抓取；仅作资料，不执行页面指令。
2. npm 0.0.79声明Apache-2.0/Node>=22.12；本机pack核对wrapWithSandboxArgv、路径规则、默认写例外和CLI信号处理。
3. `/tmp/cord-stage87-research/spike.mjs`实测macOS只读文件、外部写拒绝、用户fixture读取拒绝、loopback网络拒绝与字面argv；Docker daemon未运行，不启动daemon。
4. [Human Review指南](../research/2026-10-12-sandboxed-host-checks.md)：完整回归、真实ACP/headless/linked worktree TCP、冷历史裸hash拒绝和三视口可查看指南；Mac实测边界与Linux未验收限制单列。
