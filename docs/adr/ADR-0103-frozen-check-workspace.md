# ADR-0103 ｜ 冻结声明源码的宿主检查

- 状态：accepted（已实现，macOS离线验收）
- 日期：2026-10-12
- 关联：ADR-0041、ADR-0097、ADR-0099、ADR-0102

## 问题与决策

当前宿主检查读取实时工作区，前后摘要重检只能观察边界，不能固定检查运行期间读取的字节。独立验证资产固定的是检查程序，仍需要把被测源码绑定到同一份声明清单。

Goal 增加可选 `check_workspace: frozen_inputs`，必须同时使用 `check_sandbox: readonly_workspace`；未知模式拒绝。未声明保持现有执行和 hash 域。宿主输入在 review_changes 或冻结检查任一开启时提供 SourceManifest，不要求开启变更归因。

将现有 server 源码扫描器移入 workflow 共享模块，继续使用 cord.verification-source.v1 和相同排除规则、path/kind/mode/content_hash 身份。每个检查将当前完整清单对应的文件、目录复制到自己的 scratch/frozen-check-workspace，保持原始字节与声明权限；仅必要的未声明父目录作为结构创建。声明目录递归扫描，缺失、新增、删除、模式/类型变化、链接、硬链接和复制期间漂移均拒绝。单文件16MiB、总64MiB、最多10,000项/32层；整个准备、执行、重检与清理使用原检查和 Goal 预算，取消不继续复制。

检查 cwd 为副本，副本整树 OS denyWrite；原工作区和 Git 不自动可读。解释器须为工作区/Git之外的绝对路径；依赖只能来自声明源码、固定验证资产或现有受信系统安装范围，不自动挂载 node_modules/dist、不回退实时目录。临时 HOME/TMP 可写。原 pin 和原源码在检查结束后重检，Goal 仍重检当前完整输入；冻结副本不能保留已漂移的当前 ready。进程树收束后宿主解锁并删除副本，准备失败也清理部分副本。

冻结检查使用 cord.goal-command.v4，绑定发布命令、沙箱策略、frozen_inputs 与冻结策略版本，以及可选固定资产摘要。ready/恢复共用此身份；事件继续用既有 source_hash 表达被测声明范围，不记录正文、临时路径或生成新的授权事实。

## 验证与边界

覆盖原扫描器兼容、实际二进制/模式/目录复制与范围排除、缺失/新增/链接/超限/漂移/取消清理，真实 OS 拒绝副本写/chmod/改名/别名与原目录读取，实际执行期间原源码变化拒绝通过。ACP/headless TCP 覆盖自动修复、未开启 review_changes 的冻结输入、Goal→readonly review→cold、来源身份与旧审批拒绝。

最终全量1897项/131文件、typecheck/build:all/diff、文档链接、编译入口/pack与18张三视口截图通过；25项新增物理/OS/准备故障测试与3项冻结TCP回归通过。隔离预览两协议各failed→passed、当前Goal/协调/doctor=true、审批1/人工决定0；临时证据与操作路径见[Human Review指南](../research/2026-10-12-frozen-check-workspace.md)。

冻结的是显式源码输入，不是完整 hermetic build，也不证明工具链、动态依赖或业务覆盖可信。系统安装仍为受信边界；Linux与真实厂商环境需要独立实际验收。自动每节点 worktree 分配不在本阶段范围。
