# ADR-0054 ｜ 自定义 agent 外部行为的显式上下文版本

- 状态：accepted（原型实现）
- 日期：2026-10-09
- 关联：ADR-0027（固定 resolver）、ADR-0031（配置身份）

## 背景

现有 configuration_hash 绑定有效 argv，但全部 env 与外部角色文件被排除。env 除凭据外也可能控制角色或路由，外部 agent 文件更改也不改 argv；为了保持隐私边界，不能通过记录环境原文来描述这些行为变化。

## 决策

agents.yaml 的 ACP、headless 模板和自定义 args 条目增可选 context_revision，必须是正安全整数。HeadlessDriverOptions 与 AcpDriverOptions 同样支持，直接构造也校验；未声明保留原 v1 身份，声明时用各协议 v2 域并绑定数字版本。版本不传给 CLI，不参与旋钮编译，不改变 env 透传。

配置者在角色文件、行为环境或外部封装语义变化时主动增加此版本。相同版本下环境值仍不进入指纹或公开数据；凭据轮换不自动影响身份。版本变化通过既有 agent_configuration_hash 链路使旧提议/checkpoint/审批失效，当前在途 run 持有旧 resolver，后续显式启动采用新版本。

公开 agent 清单仅新增可缺省 context_revision 数字，控制台显示“上下文版本”；不公开 env/args/角色提示或文件原文。无版本清单与启动参数保持兼容。

## 边界

这是配置者维护的非敏感声明，不自动发现环境或文件变化，不证明实际 CLI/模型行为相同，也不代替 OS 权限。未增加版本时无法检测外部变化。不回滚已退出节点、批准 gate 或自动重放模型；原真实 Draft 仍由人工处理。
