# ADR-0092 ｜ Headless标准输入Prompt通道

- 状态：accepted（已实现并验证）
- 日期：2026-10-10
- 关联：ADR-0073（启动能力）、ADR-0088（双配置）、ADR-0090（完整进程完成）

## 依据与问题

已抓取[官方非交互文档](https://developers.openai.com/codex/non-interactive-mode)明确支持`codex exec -`让stdin成为完整prompt；官方命令页与本机exec/resume帮助也描述`-`语义。当前内置Codex将task.prompt作为裸位置参数，`--help`、子命令名称或`-`可能改变CLI解析；prompt还暴露于进程argv/命令诊断。

## 决策

HeadlessCliTemplate增加可选prompt_input=argv/stdin，缺省仍为argv。内置Codex使用stdin：new/resume与只读/可写均把固定`-`放入原prompt位置，execa.input发送完整原文，不增加换行、不使用shell或中间文件；版本/help查询继续stdin忽略，不发送prompt。Claude/Kimi与旧自定义wrapper的参数行为保持。

自定义headless args形态可显式声明prompt_input，所有完整分支使用同一通道；stdin模式禁止任何`{{prompt}}`占位，静态`-`或专有stdin旗标由wrapper实际协议声明，不猜测。template形态由模板拥有通道，不允许覆盖。未知枚举/混合声明在注册或构造时拒绝，不退回同名内置配置。

AgentCapabilities与严格协调能力投影新增可选prompt_input字段，仅有明确模板声明时公开；它描述输入映射，不证明模型/隔离可用。控制台能力详情展示标准输入/命令参数，不公开prompt内容。非stdin配置保持现有v4身份；stdin启动定义把prompt_input纳入原launch_definition摘要，再由v4完成策略绑定。不同通道即使argv相同也有不同身份，模型/profile/revision仍绑定原定义；热重载固定resolver，cold恢复与旧审批/协调按身份重验，已退出节点不回滚。

## 限制与验证计划

stdin减少argv暴露和选项/子命令误解析，不保证wrapper尊重协议、vendor不记录prompt或OS隔离。argv-only wrapper仍由显式映射负责，不能普遍强加未知CLI的stdin旗标。完整流/进程退出、取消/超时清理、宿主Goal自测与人工gate继续独立生效。

17项driver和4项TCP真实离线回归核验多行/Unicode/选项形式/`-`/子命令prompt、new/resume与readonly四组合、原文UTF-8字节、双profile/固定session、无prompt查询、错误声明拒绝、旧argv身份兼容/新stdin身份迁移、背压timeout/abort与终止清理。最终1594项/115文件、typecheck/build:all/diff通过；隔离HTTP与desktop/mobile三视口验收，审批1/人工决定0/仅deliver退出/doctor通过。人审与限制见[Human Review指南](../research/2026-10-10-headless-stdin-prompt.md)。
