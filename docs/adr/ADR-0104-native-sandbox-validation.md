# ADR-0104 ｜ 跨平台原生沙箱验收入口

- 状态：accepted（已实现，macOS与Ubuntu22.04 ARM64实际验收）
- 日期：2026-10-13
- 关联：ADR-0097、ADR-0100、ADR-0101、ADR-0102、ADR-0103

## 问题与决策

helper声明支持Linux，但现有实际OS与TCP测试只在macOS开启。普通测试在Linux跳过原生检查不能作为跨平台通过证据。

增加独立 `npm run test:native-sandbox`：要求普通用户、Node>=22.12、固定Sandbox Runtime0.0.79、完整无告警的原生依赖；Linux额外实际执行bubblewrap用户/进程/网络命名空间探针。失败立即停止，不降级裸执行，不调整产品权限、不以测试skip冒称支持。

共享测试开关保留macOS当前离线测试行为；Linux只有显式 `CORD_NATIVE_SANDBOX_TESTS=1` 开启实际沙箱测试，显式模式的基础依赖缺失在导入时失败。入口执行8个现有核心/driver/TCP文件，以原测试预算、两worker并发和10分钟整组上限运行，JSON报告必须全部passed且0 skip、0 todo、8个文件，才输出验收通过。

加入普通用户Ubuntu22.04/Node24 CI，安装bubblewrap、socat、ripgrep，固定npm lock依赖并构建后执行严格入口。自动触发仅与相关源码/测试变化关联，workflow不调用付费模型、审批或发布。机器原生策略与当前事件/hash/恢复语义不因平台验收放宽。

Linux首轮114项中23项失败：Git2.34.1不支持worktree list的-z；runtime的denyRead目录使用可写tmpfs遮罩，即使denyWrite也允许在遮罩内创建文件（不会写回宿主）。保留原拒写断言，两个helper通过本次私有scratch内的可信bubblewrap适配器，在挂载完成后对最终tmpfs追加--remount-ro；子挂载的代码/scratch写权限保持。只解析固定runtime的结构化argv与有界NUL参数文件，不解析shell文本；未知选项/格式拒绝启动，适配器不向agent传递IPC。

Worker策略升为workspace.srt-0.0.79.v3，宿主检查策略升为readonly-workspace.srt-0.0.79.v2；固定资产命令hash也绑定宿主策略，旧证据不能直接复用。Git采用core.quotePath=false的porcelain行记录，当前canonical根禁止控制字符，必要的JSON兼容路径引用严格解码，保留反向引用与物理目录身份核验。Linux bubblewrap把SIGTERM表示为143，仍是failed且保留真实退出码，不推断为成功。

## 验收与边界

必须证明两协议Worker的真实写/读/网络限制与取消回收、当前全文副本、宿主只读检查、独立固定验证资产、冻结源码cwd和TCP Goal失败→自主修复→passed→只读报告→最新协调→冷恢复→最终人工未决。

实际环境的用户、架构、Node、runtime、依赖与测试报告要记录；无可用Linux或CI未完成时明确未验收。Ubuntu22.04不代表其他Linux发行版/内核/容器策略均可运行，尤其禁止用户命名空间的宿主必须fail-closed。worker安装、真实厂商/网络凭据与业务覆盖仍属独立验收。

2026-10-13：macOS ARM64/Node26.8.2与专用Lima Ubuntu22.04 ARM64/kernel5.15/UID501/Node24.21.0（Git2.34.1、bubblewrap0.6.1、ripgrep13）各114项/8文件零skip通过。两平台实际覆盖两协议自主修复/当前全文/固定资产/冻结源码/冷恢复/最新协调与最终人工未决。CI已配置，尚未核验GitHub运行结果；详情与复现见[人审指南](../research/2026-10-13-native-sandbox-validation.md)。
