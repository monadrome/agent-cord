# 宿主检查只读沙箱：Human Review指南

## 配置与行为

```yaml
run:
  agent: implementer
  goal:
    inputs: [src, tests]
    check_sandbox: readonly_workspace
    checks:
      - id: offline-unit
        bin: node
        args: [--test, tests/unit.test.mjs]
        timeout_ms: 120000
```

片段需放在有review artifact、验收条件和最终人工gate的完整Goal流程中。`readonly_workspace`只限制宿主检查进程，不修改worker启动权限，也不把Agent工作区能力改成os_sandbox。未声明保持既有裸检查；未知枚举发布时拒绝。

运行前提为macOS/Linux、Node>=22.12与可选固定依赖`@anthropic-ai/sandbox-runtime@0.0.79`。macOS使用sandbox-exec，Linux需要bubblewrap及runtime检查的依赖；缺依赖、初始化/包装失败、不支持平台时不运行裸命令，形成环境卡点。本轮在macOS进行实际原生验证，Linux执行路径尚无实际验收。

| 项目 | 限制 |
|---|---|
| 源码 | 当前规范工作区可读不可写；bin/args不含NUL，字面参数原样传递 |
| 事件与Git | 工作区cord目录、gitfile/目录及linked公共Git元数据不可读取或写入 |
| 用户与其他工作区 | 默认拒绝根下读取，仅重开当前工作区、临时scratch和系统运行目录 |
| 临时文件 | 每检查独立HOME/TMPDIR，只允许scratch及必要stdio/设备写入；共享/tmp/claude明确禁写 |
| 环境 | 仅继承PATH和固定locale，HOME/TMP等由宿主生成；凭据、NODE_OPTIONS、shell/Git覆盖不传入 |
| 网络与IPC | 外网、loopback、Unix socket及额外Mach/Apple Events授权关闭；测试不继承宿主控制IPC |
| 取消与超时 | 准备/helper/原生检查纳入既有检查预算，整组收束，信号/非零/未确认结果不能passed |

检查如需写源码目录、测试缓存、绑定本地端口或使用用户凭据，会实际失败。检查必须适合此边界；不通过删除必需测试、改变验收条件或自动裸执行来绕过。安装依赖应先在授权的工作树准备，检查进程不自动联网安装。`PATH`中的工具、系统运行目录和宿主安装位置属于信任边界，读取范围并不只包含goal.inputs。

## 证据与审查入口

1. [ADR-0097](../adr/ADR-0097-sandboxed-host-checks.md)：约束与选型；[官方runtime](https://github.com/anthropics/sandbox-runtime)为Apache-2.0/research preview。
2. [schema.ts](../../src/core/schema.ts)：check_sandbox严格枚举与bin/args的NUL拒绝。
3. [host-verification.ts](../../src/workflow/host-verification.ts)：原模式兼容、新策略command hash、私有环境/目录、控制通道与实际输出hash。
4. [sandbox-check-helper.ts](../../src/workflow/sandbox-check-helper.ts)：每检查独立SandboxManager、固定版本/依赖检查、原生限制、shell字面引用和真实退出状态。
5. [goal.ts](../../src/coordinator/goal.ts)、[goal-evidence.ts](../../src/coordinator/goal-evidence.ts)：worker获知检查边界、指南实际证据与ready/恢复/协调/人审统一hash。
6. [原生检查测试](../../tests/workflow/sandboxed-host-check.test.ts)、[来源测试](../../tests/coordinator/goal-evidence.test.ts)、[TCP Goal测试](../../apps/server/tests/sandboxed-goal.test.ts)：缺runtime、读写/网络拒绝、实际signal/非零/timeout/cancel/并发、裸hash反例、冷历史与人工gate。

声明模式时command_hash使用`cord.goal-command.v2`，绑定原命令、readonly_workspace和`readonly-workspace.srt-0.0.79.v1`策略；裸模式保持v1。Goal字段进入workflow/input身份。旧裸检查即使退出0也不能作为严格ready来源，模型自述与stdout伪造JSON不控制宿主IPC。通过后指南包含实际隔离模式和版本；完整日志仍只留内存反馈，事件持久化hash/退出状态与摘要，不新增凭据或原始输出字段。

## 验收与复核

```bash
npx vitest run tests/workflow/sandboxed-host-check.test.ts tests/workflow/host-verification.test.ts tests/coordinator/goal-evidence.test.ts apps/server/tests/sandboxed-goal.test.ts
npm test
npm run build
npm run typecheck
npm run build:all
git diff --check
```

本轮完整1680项/121文件通过，build:all与typecheck通过。新增回归17项，包含9项检查/发布用例、1项ready模式身份用例和7项实际TCP Goal用例；macOS限制经过真实子进程验证，未安装runtime/Node版本不足/其他平台的原生成功测试显式跳过，缺依赖拒绝路径仍验证，不能据此声称Linux已验收。编译后入口实际严格检查通过，npm pack dry-run确认helper随包发布。

最终本轮265个本地文档链接无缺失，git diff --check通过。

实际ACP/headless Goal从首次坏业务值自动修复为fixed，宿主严格检查失败→通过，current ready与review指南完整，冷启动不重复worker、审批ID保留；最新PRD使旧提议失效。源码/事件写入被拒绝，原文件/事实保留，冷恢复不重复失败worker；伪造裸hash的实际冷历史不批准原严格ready。所有最终人工gate未决，不调用付费模型。

独立Git两工作树实际TCP预览各worker2次、检查failed→passed、当前wait=true、doctor=true、审批1/人工决定0/节点退出0，主树业务值initial不变。Playwright 1440/390/320共6截图，完整只读review指南包含readonly_workspace/Runtime版本/实际命令/验收矩阵，无pageerror或页面横向溢出；已查看桌面和320截图。临时证据在`/tmp/cord-stage87-real-result.json`、`/tmp/cord-stage87-browser-result.json`，不入Git。

## 限制

同一OS用户的worker仍可能修改宿主helper/运行时、验收脚本或已有运行材料。原型不是恶意worker抗篡改证明，仍需独立可信安装和不可由实现者修改的验证资产。系统运行目录如/etc、/opt可读，不能保证其中没有敏感数据；stdio与必要设备仍按runtime开放。网络/文件限制不替代完整虚拟机、容器或恶意代码隔离审计。

该严格模式仍直接读取当前工作树，没有冻结代码快照；前后source/context核验拒绝观察到的漂移，无法承诺跨进程原子文件树。依赖与校验脚本必须纳入声明源码范围来约束它们的新鲜度。运行时是固定preview版本，升级要更新策略hash、ADR和实际限制回归，不能偷偷放宽规则。
