# ADR-0100 ｜ ACP/headless Worker 的实际 OS 沙箱

- 状态：accepted（已实现，macOS离线验收）
- 日期：2026-10-12
- 关联：ADR-0096（工作树）、ADR-0097（宿主检查）、ADR-0093/0094（隔离能力与准入）

## 问题与方案

独立工作树不限制 worker 的实际读写、网络和环境变量。只读工具审计发生在通知之后，不能防止未报告的直接文件写入；共享同一 OS 用户的 worker 也能修改 cord 事实或宿主 Git 状态。

采用可选 Agent 级 `sandbox:{kind:workspace,allowed_domains?:[],env_allowlist?:[],read_paths?:[],state_dir?:absolutePath}`，两协议、新会话/显式恢复及无 prompt 查询共用。使用已有可选 Sandbox Runtime 0.0.79，每调用独立监督 helper，避免全局 runtime 状态相互污染。缺 runtime/依赖/支持或初始化失败拒绝执行，不降级裸模式。

## 决策

1. Helper 在宿主可信进程中准备 OS 限制，再以字面 argv 启动真正 agent；不继承其 IPC 控制通道。stdin/stdout 原样转发，ACP SDK 仍在宿主，现有权限、配置回执、工具审计、Goal 验收与人工 gate 不变。宿主必须先收到可信沙箱启动回执，正文不能伪造该回执。
2. 可写任务只允许修改本工作区和本次私有临时目录；只读任务仅允许写私有状态/临时目录。整个 cord 与 Git 元数据禁止读写，额外 read_paths 只授予读取，不能覆盖管理目录禁令。报告由现有 output=text/宿主代写通道持久化，不能让 agent 写事实或批准 gate。
3. 系统运行时读取采用已验证的有限目录集合；工作区/明确 read_paths 可读，其他用户目录默认不可读。网络采用明确域名/可选端口白名单，默认无网络，未知域名直接拒绝；不允许开放 wildcard、监听、Unix socket、PTY、Apple Events 或弱隔离回退。
4. Helper 启动环境最小化，agent 只接收基础 PATH/LANG、私有 HOME/TMP 和 env_allowlist 明确选择的值。不得用名单覆盖 HOME、TMP、加载器或沙箱代理变量；凭据值不进入 argv、公开能力或配置 hash。MCP 的宿主凭据解析仍按原配置授权，配置者需同时为真实网络连接声明允许域名。
5. state_dir 可选，必须是工作区/Git 之外的普通目录。持久 HOME 按当前工作区与配置身份分区，不能把不同 worktree/别名/配置的会话缓存混用。未声明时使用一次性 HOME，不声称原生会话文件可跨调用保留。显式 session ID 与底层协议/CLI 回执核验不变。
   可信 agent-cord 安装资产必须在可写工作区之外，状态目录也不得覆盖该安装。状态根要求当前用户拥有且非group/other可写，每个HOME限制0700；路径归属在创建新状态前核验，已有异常缓存不自动修复或删除。
6. 沙箱定义、固定策略进入新的 driver 配置身份，未声明保留旧域。能力公开 `workspace_isolation=os_sandbox` 与受限 policy/environment/network/state 描述，安装仍 unchecked；实际任务准备必须核验 runtime。worktree wrapper 保留 os_sandbox 声明，仍执行其实际物理身份检查。查询与协调读取同一能力，不公开路径、域名或环境值。
7. 初始化、agent 调用和收束共用原任务/查询预算；取消、超时、消费方退出必须终止整个进程组并清理一次性目录。Headless 真实退出和 helper 回执均须正常，ACP 仍按明确 end_turn/取消生命周期结束，不把宿主正常协议收束当作模型成功证明。

## 被否方案

- 只声明 os_sandbox 或添加 CLI 标志：不能证明实际约束已启用。
- 在单一 server 进程调用 SandboxManager：全局状态会让不同任务、宿主检查与模型连接配置互相污染。
- 默认继承全部宿主 HOME/env 或开放全部网络：会保留当前泄漏边界，不能称为隔离。
- 自动放行权限请求或把沙箱等同 Goal 完成：权限、交付证据与最终人工决定是独立维度。

## 验证与限制

覆盖 strict 配置/旧身份、当前能力和协调准入、真实两协议子进程、可写实现/只读评审、cord/Git/外部用户文件保护、网络白名单与未知拒绝、显式环境/持久状态和指定恢复、取消/超时/缺依赖、TCP Goal/最新快照/冷恢复/最终人工 gate。全部离线，不操作7306真实Draft，不调用付费模型。

先在本机 macOS 做真实 OS 反例，不将 Linux 结构支持宣称为已实际验收。沙箱不证明可写验证脚本可信、业务覆盖充分、对同 OS 用户宿主的抗篡改、原子源码冻结或任意底层 CLI 对网络代理/状态目录的兼容。逐任务自动 worktree 分配及可信验证资产仍需继续推进。
