# ADR-0074 ｜ Agent 能力工作台与查询新鲜度

- 状态：accepted
- 日期：2026-10-10
- 关联：ADR-0027（配置快照）、ADR-0073（启动能力与 ACP 协商）

## 决策

Agent 工作台展示适配器声明的启动选项、原生 resume 与宿主 Goal/受限节点恢复能力，并提供显式 ACP 查询。清单中的注册状态不代表 CLI 已安装、模型可用或协议已核验，不使用绿色通过图标表示注册。

`AgentInspectionView.current` 表示 server 返回结果时，查询捕获的 revision/configuration_hash 仍匹配当前可用同名 agent。期间重载（即使有效参数相同）、移除或拒绝该别名都会返回 false；结果仍保留其原配置身份，不能替换成新配置的 hash。静态 headless 查询没有协议 observation，不声称已协商。

幂等重放仍返回原响应，不重查或重写历史 current。console 查询完成后读取最新清单，并结合响应 current、revision、非空配置 hash 和当前 alias 核对结果。刷新清单失败时结果只能标为未核验，不能以留存清单证明最新；新清单变化时旧结果明确标过期。后续查询失败保留历史结果，但失败状态单独展示。

查询不自动触发，不发送 prompt、不授予 worker 工具预授权；前端只消费 server 的 capability/observation 和公开身份，不计算协议能力或 workflow 状态。页面跳转、筛选、切换 agent、迟到请求与重载不能把 A 的结果贴给 B。model/effort 候选、mode、配置 ID/类型及省略数以有界协议投影展示，不编辑凭据或构造新启动定义。

## 验证

离线测试覆盖 server 查询期间重载/移除、固定原身份、失败重载和幂等历史响应；console 身份核对覆盖缺少 current/hash/alias、revision 与 hash 漂移。真实浏览器验证成功/失败/重试/过期、筛选/切换、未安装静态声明、查询无 prompt，桌面与窄屏截图/无溢出。最终人审与真实 Draft 不操作。
