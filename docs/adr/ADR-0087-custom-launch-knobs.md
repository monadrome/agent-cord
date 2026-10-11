# ADR-0087 ｜ 自定义Headless Wrapper完整启动旋钮

- 状态：accepted（已实现并验证）
- 日期：2026-10-10
- 关联：ADR-0073（严格启动）、ADR-0080（完整参数分支）、ADR-0055（宿主Goal）

## 决策

custom args占位符扩展到既有HeadlessArgInput启动旋钮：bare、auto、max_turns、budget_usd、system_prompt、agent、agents_json，加上现有provider/model/effort。只在基本args显式使用对应占位时声明能力；launch继续复用严格类型schema，未映射选项/漏值拒绝注册，不静默忽略。所有已声明完整参数分支须保持同一旋钮集合，prompt/session/readonly原规则不变。

替换一次、不经shell；布尔值是文字true/false，数字以String确定转换，角色/JSON/prompt是单个argv值且不递归展开。bare按显式值传递，不默认开启。auto在只读任务与只读原生恢复中强制false，在可写任务消费显式值；这仅为wrapper参数约束，不证明OS隔离或工具执行前拦截。wrapper须自行把这些值映射为实际CLI接口，宿主readonly审计/源码与产物验证保持。

缺省不增加新能力字段或启动参数，旧provider/model/effort配置顺序与hash保持；新声明的四分支实际argv进入现有hash。配置变更触发任务/审批/协调新鲜度，热重载在途resolver保持原配置，冷恢复重新核验。max_turns/budget_usd是底层wrapper传参，不能替代宿主Goal时长/次数/可靠usage预算或证明底层已执行额度限制。

## 验证

先复现未知新占位拒绝；真实子进程覆盖四种启动分支的布尔/数值/角色/JSON传值、只读auto=false、单次替换/无shell、缺值/漏分支/未映射拒绝、旧身份兼容与固定snapshot。真实TCP Goal/只读报告/最新协调、配置恢复与人工gate未决，并提供可审查文档。确定性fixture不调用付费模型。

最终1461项/104文件、typecheck/build:all/diff与131个本地文档链接通过。新21项driver/3项TCP覆盖全部声明旋钮与恢复/拒绝/快照，隔离实际调用write(auto=true)、review(auto=false)、最新PRD协调review(auto=false)，宿主自测/指南与doctor通过，审批1/人工决定0/仅deliver退出。1440/390/320三截图无pageerror/溢出/inspect请求，桌面与最窄已查看；审查与限制见 [Human Review指南](../research/2026-10-10-custom-launch-knobs.md)。
