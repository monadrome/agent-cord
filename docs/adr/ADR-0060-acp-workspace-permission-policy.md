# ADR-0060 ｜ ACP 工作区 read/edit 范围预授权

- 状态：accepted（原型已实现）
- 日期：2026-10-09
- 关联：ADR-0017（ACP）、ADR-0031/0054（配置身份）、ADR-0055/0056（Goal 自主交付）、ADR-0050（独立协调无工具）
- 来源：当前 driver/agents.yaml 核对；ACP SDK v1 RequestPermissionRequest 与 ToolCallLocation 类型

## 背景

原 ACP 支持程序化 PermissionDecider，但工作区 YAML 无法声明预授权。普通可写 worker 一旦请求权限就会被默认取消，即使操作位于用户已指定的源码范围内。仅设置 Goal 不能消除这一中间阻断。

## 备选方案

1. 全部 permission 请求自动批准或依赖 CLI 自行决定。
2. 每个请求转人工，或继续使用默认全部取消。
3. 配置者声明 read/edit 路径范围，宿主核验 ACP 结构化 kind/locations 与文件边界后仅选 allow_once。

## 决策

采用方案 3。ACP agent 注册新增可选 permission_policy：read/edit 分别为工作区相对路径清单，合计至少一个有效范围，每类最多 64 项。路径为精确文件或目录前缀，不支持 glob、根目录、绝对路径、空段或遍历；沿用普通文档边界，事实文件、agent 配置和管理路径禁止。归一化去重/排序，不能从请求 title/name/rawInput 推断授权。

可写任务的请求必须具备 read/edit kind 与 1-64 个绝对 locations；所有位置必须位于 task.cwd 的普通目录内且符合相应范围。宿主拒绝链接、硬链接、目录或特殊叶文件；read 要求文件存在，edit 允许创建普通文件/父目录。所有位置通过且提供唯一 optionId 的 allow_once 才选择；只有 allow_always、未知操作（含 execute/delete/move/fetch）、缺位置、越界或 IO 不可判断时取消并落权限错误。不会记录人工决定或扩大长期权限。

readonly 任务继续使用原默认拒绝策略，即使注册策略有 read；独立协调的无工具边界保持不变。缺省没有 permission_policy 时兼容原 M2 行为。原生 AcpDriverOptions 支持同一结构；permission_policy 与自定义 decidePermission 互斥，避免两个来源覆盖。

声明策略采用 ACP 配置 v3 域，将归一化范围和可选 context_revision 纳入 configuration_hash；不传入 argv、不公开环境或路径原文。不声明保持 v1/v2 身份。清单仅公开 read_count/edit_count，重载固定配置快照；策略改变使旧任务、报告/提议与审批按既有身份链重新核验。

## 理由（第一性原理推导）

1. 已声明的常规操作不应要求人逐次批准，权限边界必须由宿主确定性检查，而不是由 agent 自称安全。
2. ACP kind 与 absolute locations 提供可检查结构；缺材料时取消，比解析自由文本推断更可靠。
3. allow_once 避免把当前匹配泛化为未来长期授权；只读协调与普通 worker 的权限职责不同。
4. 路径策略改变实际执行行为，必须进入配置身份，否则旧结果可能代表不同权限。

## 被否方案的否决理由（逐一）

- 方案 1：批准未知或越界操作，不能维持 Draft-only 与关键权限人工控制。
- 方案 2：普通路径也需要逐次人工调度，无法满足正常 Goal 执行自主的原则。
- 执行 shell 命令从 rawInput 字符串猜测授权：ACP v1 无统一 argv 契约，无法证明执行内容；本轮继续拒绝，验证命令由 Goal 宿主运行。

## 关键实现注意点

1. 这是合作 agent 的协议授权检查，不是 OS 沙箱、恶意 agent 证明或文件事务；kind/locations 由 agent 报告，检查后仍可能发生文件竞争。操作系统隔离仍由部署者负责。
2. task.cwd 的真实路径与规范别名均可定位；拒绝工作区根自身为链接，不把系统路径别名误判成越界。
3. 新策略的权限反馈固定为 metadata，取消错误不保存 request title/rawInput；这些字段可能带私有内容。旧无策略回执保持兼容。
4. 不提供 execute/删除/移动或网络预授权，不把 policy 字段放入 headless 定义；未知配置拒绝别名。真正权限卡点继续由 Goal/supervisor 升级。
5. 覆盖标准 read/edit、创建、多路径、前缀兄弟/遍历/链接/硬链接/管理文件、缺 locations、未知 kind、持久选项、readonly、配置重载/隐私与完整 Goal 到最终人审。
6. permission 驱动错误不可通过自动重试获得新权限，协调任务 retryable=false，Goal 直接形成阻塞；其他普通 driver 错误保留原重试行为。

## 证据来源

- node_modules/@agentclientprotocol/sdk/dist/schema/types.gen.d.ts：v1 ToolCallUpdate.kind/locations 与 ToolCallLocation.path（绝对路径）。
- src/driver/acp.ts 的 defaultPermissionDecision 与 agents-yaml.ts 的注册配置缺口。
- core/session-files.ts 普通文件访问边界和 [核心 feature](../core-features.md) 的既有授权执行原则。
- [范围权限验收](../research/2026-10-09-acp-workspace-permissions.md)：真 ACP 请求、配置恢复、隐私及浏览器。
