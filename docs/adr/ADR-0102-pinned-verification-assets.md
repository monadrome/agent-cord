# ADR-0102 ｜ 固定内容的独立验证资产

- 状态：accepted（已实现，macOS离线验收）
- 日期：2026-10-12
- 关联：ADR-0097（宿主检查限制）、ADR-0100（Worker限制）、ADR-0099（当前Goal门禁）

## 问题与决策

Worker可以修改工作区中的测试文件，而宿主直接运行它们。只读检查限制检查自身的写入，却不能证明运行的测试资产未被实现者改写。需要可发布的独立验证文件内容约定，不把任意npm test命令误称为可信验证。

GoalCommand增加可选`assets:{root:absolutePath,files:[{file,content_hash}]}`，严格唯一规范文件清单，最多128项。root必须是本工作区/Git之外的普通目录；每项必须独立普通文件，无链接/硬链接，内容hash匹配已发布值。配置不自动冻结当前测试、不猜测Git基线、不自动批准资产更新。系统解释器/bin仍属于可信安装边界。

带assets的命令必须使用绝对bin、声明`check_sandbox:readonly_workspace`。args中至少一个明确的`{{check_assets}}`根或`{{check_assets}}/<declared-file>`定位符；只展开规范独立定位参数，不对任意用户正文做字符串替换，未知/未声明文件与缺资产的定位符拒绝。实际bin不能位于可写工作区、cord/Git或资产目录；检查只读取原当前源码，不迁移其cwd。

宿主每检查在自己的scratch创建pinned-check-assets副本，二次完整读取核验原文件组，最多单16MiB/总64MiB，复制字节保持原文。副本文件0400/目录0500，检查沙箱denyWrite包含整棵副本，缓存仅其余scratch；原资产路径不自动开放。命令argv绑定本次副本，正文不入事件/IPC，实际命令结束后再核验原pin，清理在检查进程树收束后进行。缺失/漂移/非法/资源/准备失败为环境错误，不裸执行、不反馈为可自动改测试的普通业务失败。

带assets的goalCommandHash使用新域cord.goal-command.v3，绑定发布命令、check sandbox与pinned-check-assets.v1策略/声明资产摘要。原无assets命令hash保持。验证通过事实和ready来源使用同一hash，指南给出固定文件/hash和资产摘要；不接受仅报告或旧未绑定结果。

RunService.readNodeInput在Goal验证、人审、恢复和协调当前就绪核验时重读同一资产pin，漂移不可读即fail-closed；未声明保持原输入域。原始资产变化不会靠旧私有副本保持当前ready，恢复原pin后可重新核验尚未处理的审批。是否扩大权限、修改已发布验收或授予新Goal预算仍独立人工决策。

## 被否方案

- 单凭源码hash/test输出：无法确定运行的是原验证要求，修改测试后同样可通过。
- 自动取当前文件hash：Worker已经改写时会把新内容认证为可信。
- 开放外部资产原目录或直接运行裸命令：可写/文件替换和网络副作用不受已有检查限制。
- 同时冻结整个源码：是另一项更大交付边界，本阶段不能声称已完成源码冻结。

## 验证与限制

覆盖发布/库参数、旧hash兼容、pin/路径/链接/资源/取消/读故障、命令开始后资产替换、真实检查副本只读与字面argv/非零；两协议可写Worker改本地测试无法通过独立验证，正常业务失败→自动修复→当前ready/readonly/最终人审；资产在等待/cold改变拒绝旧审批/协调，缺来源不沿用旧验证。最终全量1869项/130文件、root build/typecheck/build:all/diff、308链接、compiled/pack与18截图通过；实际TCP固定资产验证结果见[Human Review指南](../research/2026-10-12-pinned-verification-assets.md)。全部离线，不操作7306真实Draft，不付费模型或子agent。

可信资产仍是显式配置者的责任，hash只证明所声明字节。验证器可以主动加载可写源码（被测对象）或不安全依赖，所以不证明业务充分、动态依赖安全、可信系统解释器完整性或宿主同OS用户抗篡改。Linux真实路径、冻结源码和每节点worktree分配仍待推进。
