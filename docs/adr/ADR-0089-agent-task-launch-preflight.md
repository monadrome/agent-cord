# ADR-0089 ｜ Agent任务启动前校验

- 状态：accepted（已实现并验证）
- 日期：2026-10-10
- 关联：ADR-0073（启动能力）、ADR-0025（取消）、ADR-0088（独立只读配置）

## 问题

原生resume要求明确session，但Headless只检查字符串非空。本机Codex帮助明确`exec resume --last`选择最近会话，因此把`--last`放入session参数会改变调用意图；空白、控制字符和非法运行时类型也未拒绝。ACP的session ID是JSON-RPC中的不透明值，不适用CLI旗标规则。

两个driver的任务执行都在检查已取消signal之前spawn。即使之后立即杀进程，也已启动外部程序。直接调用driver的timeout_ms还可能为NaN/Infinity、非正数、小数或超过Node定时器上限，Node会把部分值转换为1ms，无法兑现声明的执行预算。

## 决策

任务迭代开始时先观察取消；已取消则返回一个取消error，不读取MCP凭据、不调用模板、不spawn，不产生result或工具事实。未取消任务在spawn前核验有效timeout_ms为1到2,147,483,647的整数；缺省仍用现有默认预算，非法值为configuration error，不输出传入值。

显式resume的session ID须为非空、非全空白字符串，不含C0/DEL控制字符；保留原值，不trim或猜UUID。Headless额外拒绝以`-`开头的值，防止CLI将它解释为选项；ACP允许普通`-`前缀的不透明ID。无效session不会新建会话或降级到最近会话，Headless buildArgv保留配置错误抛出语义，ACP返回configuration error。CLI帮助查询也在探测前核验timeout，已有取消处理保留。

不新增事件、恢复状态机或公开能力字段，不改变有效argv/configuration_hash、原授权Goal恢复和最终人工gate。spawn后的取消仍由现有协议取消与进程树清理负责，启动前校验不证明外部agent正确加载了会话或提供OS隔离。

## 验证

新增17项使用真实离线fixture与execa调用计数，覆盖取消发生在创建迭代器之前/之后、run/resume、非法超时、非法session、三个CLI/custom合法名称、ACP不透明ID、编译期间取消和无prompt查询。反例证明未创建子进程，随后合法执行与旧hash回归通过。

完整1497项/107文件、typecheck/build:all/diff与本地文档链接检查通过，不调用付费模型或操作原真实Draft。无新增UI行为，沿用阶段76浏览器证据；现有预览health200。命令、源码定位与限制见[Human Review指南](../research/2026-10-10-agent-task-launch-preflight.md)。
