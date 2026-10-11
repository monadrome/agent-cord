# ADR-0095 ｜ Supervisor有界自动重试

- 状态：accepted（原型已实现并验证）
- 日期：2026-10-11
- 关联：ADR-0058（Goal升级）、ADR-0065（人工协调重试）、ADR-0070（执行收束）
- 来源：默认Goal交付与原子Agent控制要求；[Human Review指南](../research/2026-10-11-bounded-supervisor-retry.md)

## 背景

Goal已能在卡点后自动调用独立supervisor，但supervisor输出格式错误或超时仍需要人工重复启动。已有人工retry token/父子来源可以复用；原RunService在升级完成前持有活动槽位和lease，而retry要求原执行体已收束，首失败反例证明两者互锁。

## 备选方案

1. 所有supervisor失败都保持人工重试。
2. 在driver中对所有错误无限续发prompt。
3. 宿主按发布预算，只对输出错误/超时重试同blocker，复用既有token与事件来源契约。

## 决策

Goal可显式声明supervisor_max_attempts（1到3，必须同时有supervisor_agent），默认一次。宿主先完成原executor/验证进程收束并释放lease，再发起升级；原run.failed不因协调结果变化。只对supervisor的output失败或timeout自动重试；配置、工具、存储、中断、取消和输入过期不自动重试。

初始request记录supervisor_max_attempts（仅显式大于1）。自动子request带automatic_retry={attempt,max_attempts}与既有retry三字段，system/goal-supervisor actor；core严格核验初始授权次数、连续父子链、唯一子请求、父失败/超时、相同配置与输入以及因果来源。旧人工重试仍human，无automatic_retry的system子请求继续拒绝。

自动循环必须使用已发布版本的上限，不信任回调传入数字。派发与request写前后复用retry token/expected_input_hash guard，并额外要求当前coordination_input_hash等于父完成input_hash、supervisor配置等于父完成配置。PRD/源码/流程worker或supervisor变化停止，不能自动换配置。没有输入/配置证据的失败不重试。最多三次（包含首次）；成功wait/ask_human立即停止，无worker新预算、人工答复、采用或gate决定。

冷恢复不自动补已有request的子调用或重放中断调用；未写入首次request的blocker仍按发布上限发起。人工重试保留显式token语义，可在修复最新配置后续做，与自动上限分开。服务关闭取消所有在途协调及循环。取消原run/归档/新run替代/人工答复或人工重试抢先均停止自动循环。

## 理由（第一性原理推导）

输出错误和超时可以在相同授权输入下重试，不需要人为提供新事实。配置、工具、存储与未知副作用错误没有同样前提，应保留显式修复边界。预算来自不可变发布版本，不能由回调或模型扩大；自动子请求可追溯但不构成执行worker或审批的授权。

## 被否方案的否决理由（逐一）

- 方案1为可自动恢复的supervisor输出错误增加人工调度；保留它作为默认一次和自动上限之后的入口。
- 方案2缺乏预算、来源与当前输入核验，容易重复越权工具调用或替换输入；不采用。
- 冷恢复续接已有链无法证明中断副作用与剩余操作，不自动重放。

## 关键实现注意点

1. 原executor先释放活动槽位/lease，再等待升级；cleanup只删除匹配run，不能删除后来启动的执行器。
2. 写前/写后与started落盘后的全输入重检都需要保留；已记录请求后的配置重载使用固定resolver，后续新请求重新核验当前配置，不自动换配置。
3. core对成功自动子完成要求父输入一致；stale/未派发/中断结果保留可查询历史，不因新输入污染整个列表。
4. `supervisor_max_attempts`是协调次数，不是worker尝试、Goal usage预算或permission auto模式。各层分别计量；本ADR不增加supervisor费用/token治理或跨进程事件写入安全保证。

## 证据来源

首失败反例已复现executor-active生命周期互锁；71项协调升级回归覆盖headless/ACP输出失败后成功、三次硬上限、来源伪造、冷恢复不重复、timeout/取消/工具边界、输入/配置漂移、写失败/记录后中断及人工重试。相关定向122项和完整1637项/117文件通过，build/typecheck/build:all/diff通过；隔离TCP双协议验证最终人工gate未决与doctor=true。所有验证使用离线fixture，不调用付费模型，不操作7306真实Draft，详见[Human Review指南](../research/2026-10-11-bounded-supervisor-retry.md)。
