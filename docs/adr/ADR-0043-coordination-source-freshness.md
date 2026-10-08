# ADR-0043 ｜ 独立协调提议绑定声明源码身份

- 状态：accepted（实现选型）
- 日期：2026-10-08
- 关联：ADR-0032（独立协调）、ADR-0033（受控采用）、ADR-0041（源码范围）、ADR-0042（worker 新鲜度）
- 来源：阶段 29 对独立协调与 worker 输入身份的审查

## 背景

只读 worker 与机器 gate 已绑定代码输入，但 coordinationInputHash 仍只覆盖文档、账本、流程和配置。源码变化而 PRD 不变时，旧协调提议可能继续标记 current/adoptable。

## 备选方案

- 每次采用都强制重新协调：无法复用仍然有效的提议，重复付费调用。
- 把文件扫描塞进纯协调 hash：破坏计算与 IO 的边界。
- 宿主注入源码摘要，将派发、完成、查询和采用绑定到同一身份：复用已有范围扫描规则。

## 决策

ContextSessionAgentOptions 增加可选 read_source_hash(def) 钩子。server 对整个绑定流程的 verification-passed.with.inputs 取并集，从既有 helper 获取摘要。协调者总是只读，不携带源码正文或事件历史。

轮次 started/completed 保存 source_hash，prompt 元信息包含该摘要；有源码绑定时 coordinationInputHash 使用 v2 域，没有绑定时保留 v1。摘要仅标识当前材料，不构成测试通过或内容正确的证明。

模型返回后重新读取文档/进度和源码摘要；在途源码变化记 stale，无法读取记 failed/freshness，两者都不返回提议。查询与采用前使用同一声明范围重新计算；源码变化或无法判定时不可采用，保持人工 gate 和确定性执行器约束。

## 理由

“最新需求快照”不能在代码层变化后仍引用旧提议。摘要绑定让模型调用与执行采用基于同一份可识别的材料；宿主提供 IO，纯 hash 保持可重放。

## 被否方案

无条件调用模型无法判定旧提议是否仍有效，且浪费相同输入的结果；hash 自行读文件使内核与 server 的范围约定耦合。

## 实现边界

只覆盖声明范围，不认证外部依赖、OS 环境或模型推断质量。快照 ID 仍是文档/事件 provenance，source_hash 是额外源码输入身份。采用只是显式进入绑定流程，不自动批准关键 gate 或合入。

## 证据来源

现有 coordinationInputHash/inspect/采用 guard 和源码清单 helper，以及阶段 29 新增核心与 REST 回归。
