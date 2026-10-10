# ADR-0078 ｜ 协调快照中的流程 Agent 身份与能力

- 状态：accepted
- 日期：2026-10-10
- 关联：ADR-0031/0033（配置身份与采用）、ADR-0048（执行观察）、ADR-0073/0077（能力声明）

## 问题

协调输入hash仅绑定协调者配置。尚未派发worker时，worker模型/effort/角色/通道/context_revision改变不会改变文档、任务或Goal观察，旧advance提议仍可被采用。协调prompt也不知道流程声明的worker/supervisor是否可解析或提供何种能力。

## 决策

提供有界CoordinationAgents：完整覆盖流程node.run.agent和goal.supervisor_agent的唯一名称，最多128项，按名称排序。每项仅有agent、resolution(resolved/unavailable)、configuration_hash和可选能力声明；声明严格白名单/有界选项，不含argv/env/角色正文/错误原文或未经核验的运行时探测。未知或拒绝配置为unavailable；可解析不等于已安装/模型可用。

ContextSessionAgent增可选read_agents hook；服务器默认接入。hook结果必须完整、唯一、符合声明与结构；不能读取/验证时不调用模型。上下文进入prompt和完整input_hash，轮次事件只保存agent_context_hash。出现该上下文用v11/v12域，旧无hook库调用保留既有域；旧服务器提议需重新协调才可声称绑定流程Agent。

流程next worker unavailable或缺稳定配置身份时不得advance，只能依据workflow节点提出wait/ask_human；不自动换agent、改参数、扩权限或放行gate。运行时安装/CLI帮助/ACP选项仍通过显式能力查询，不在协调过程中自动启动探测。当前轮次使用固定resolver快照，热重载不改变模型调用，但查询/采用以最新resolver重算并拒绝旧结果。

采用advance时固定实际run resolver，核验该固定快照与提议输入，同时在记录采用前重检最新流程Agent身份是否一致；A/B/A窗口不能校验A却执行B。记录后的热重载保留已授权固定配置。自动协调retry输入/查询重检同步绑定上下文，原Goal预算与人工续跑来源不变。

采用run冷恢复必须有合法context-session-agent完成来源、请求/完成/采用顺序、同节点advance、输入摘要及当前流程Agent完整身份。缺证据或配置变化拒绝自动派发；需重新协调并显式采用当前配置，不能自动改授权。已终态或非当前历史登记保持原事实。

## 验证

离线纯声明/结构/范围/hash与真实fixture协调覆盖未知worker、配置漂移、环境不泄漏、通道/角色/context_revision改变、同快照热重载、采用A/B/A、记录后固定执行、冷恢复、缺hash/摘要和失败修复。自测、实际HTTP与人审指南通过后小步提交。
