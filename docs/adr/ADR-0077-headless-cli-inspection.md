# ADR-0077 ｜ Headless CLI 运行时能力查询

- 状态：accepted
- 日期：2026-10-10
- 关联：ADR-0073/0074（能力声明、查询新鲜度）、ADR-0075（明确启动选择）

## 决策

内置 Claude/Codex/Kimi 模板显式声明 inspection_profile，提供有界版本/帮助查询。自定义库模板可明确声明兼容的 profile；自定义原始 args 不猜测 --help 含义，不自动执行。AgentCapabilities 增可选 inspection 描述，旧外部driver继续兼容。

HeadlessDriver.inspect 仅使用固定profile命令和原bin/prefixArgs/env/cwd，绝不拼入prompt、模型、角色或启动参数。命令为 --version、任务 --help，Codex另查exec resume --help；stdin关闭，无模型调用。总timeout限制全部步骤，stdout/stderr限量，成功/失败/超时均收束进程树。版本仅解析短semver标识，不公开原输出、路径、凭据或错误正文。

每路stdout/stderr最多128KiB，总timeout约束命令执行，终止树另有有界kill grace。成功组长退出后仍清理同进程组后代；主动自行脱离进程组的子进程不属于这一保证。probe不提供OS隔离，显式兼容profile的wrapper自身仍负责帮助命令没有外部副作用。

结果明确 evidence=cli_help：版本、步骤状态、帮助hash、逐启动选项的 advertised/unadvertised/unknown、configured以及原生resume入口是否展示。只以选项定义行判定旗标，不从正文中猜测参数；Claude auto需permission-mode选项的choices明确含auto，Codex effort走配置键而不能仅凭--config证明支持。帮助未展示不等价于不支持或禁止启动，入口展示不证明实际session恢复、模型访问、认证/额度或自测通过。

AgentInspectionView 增可选 cli_observation，保留ACP observation字段。当前性沿用固定revision/config hash与查询后最新清单核验；探测不修改agent执行身份、不自动调用模型、不替代执行错误或Goal完工审计。能力工作台提供显式CLI查询，运行时结果与静态声明分开；缺二进制/超时/无法识别和旧结果分别呈现。

## 验证

离线fixture实测argv、缺CLI、非零/未知格式、help缺旗标/只正文提及、auto枚举、Codex effort未知、超时/进程树清理、输出上限、秘密不泄露、配置身份/重载/幂等。实际本机Claude/Codex/Kimi仅调用帮助，不使用付费模型；真实HTTP与桌面/手机浏览器回归。
