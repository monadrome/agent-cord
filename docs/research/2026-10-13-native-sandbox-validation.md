# 跨平台原生沙箱：Human Review指南

## 行为与环境

`npm run test:native-sandbox`实际检查依赖及Linux用户/进程/网络命名空间，再运行8组OS/TCP测试。只有8个唯一文件、非空且全部passed、数量一致、0 skip/0 todo才通过。缺依赖、不支持平台、未知runtime、namespace失败、超时/中断立即失败；10分钟整组上限与1秒SIGKILL收束不增加单测试预算。

| 实测环境 | 依赖 | 原生结果 |
|---|---|---|
| macOS ARM64、普通用户、Node26.8.2 | Sandbox Runtime0.0.79、sandbox-exec | 114项/8文件、0 skip |
| 专用Lima Ubuntu22.04 ARM64、kernel5.15.0-173、UID501、Node24.21.0 | Runtime0.0.79、Git2.34.1、bubblewrap0.6.1、socat、ripgrep13.0.0 | 真实namespace探针及114项/8文件、0 skip |

Linux机器使用`--plain --mount-none`，只复制项目源码，不共享宿主目录、Git凭据或真实需求。OrbStack原外盘symlink未改动。测试使用离线agent fixture与本地HTTP服务，无付费模型、真实厂商凭据、自动人工决定或原7306 Draft操作。

## 修复与审查

首轮Linux91通过/23失败后保留原断言，查明三种差异：

1. Git2.34.1实际拒绝`git worktree list --porcelain -z`。改为禁用非ASCII引用的porcelain行记录；canonical根拒绝控制字符，引用路径严格解码，继续核验登记、Git反向引用和物理目录身份。空格/中文/引号/反斜杠路径回归通过；未确认创建仍保留现场，不删除或重放。
2. Runtime0.0.79使用可写tmpfs隐藏denyRead目录，denyWrite不阻止遮罩内创建文件。虽然原宿主未变，但不满足项目拒写要求。[可信适配器](../../src/sandbox/linux-bwrap.ts)只解析固定runtime结构化bubblewrap argv和有界NUL参数文件，在全部挂载完成后把最终tmpfs remount-ro。子挂载的私有scratch和代码保留原权限；未知格式不启动。事实/Git直接写、符号链接写、目录改名、只读代码写和用户目录写均继续拒绝。
3. bubblewrap把SIGTERM表示为143。保留实际退出码并要求failed；macOS仍保留null信号表示，模型/检查stdout不能覆盖真实结果。

Worker策略升级`workspace.srt-0.0.79.v3`，宿主检查升级`readonly-workspace.srt-0.0.79.v2`；带固定资产的命令hash也绑定宿主策略。旧checkpoint/ready/审批依照原新鲜度机制重验，固定资产pin自身不变；裸driver和裸检查hash保持原语义。

两个helper接入相同适配器：[Worker](../../src/driver/worker-sandbox-helper.ts)、[宿主检查](../../src/workflow/sandbox-check-helper.ts)。适配器在本次scratch生成受控启动脚本，宿主先读取参数后才派发agent，agent不继承可信控制IPC；编译包包含对应模块。源码与可信安装仍必须分开。

## 验收路径

```bash
npm ci
npm run build
npm run test:native-sandbox
```

Linux要求普通用户、Node>=22.12，安装bubblewrap/socat/ripgrep并允许用户命名空间。普通`npm test`的Linux原生默认skip不能作为支持证据；显式入口设置`CORD_NATIVE_SANDBOX_TESTS=1`并拒绝缺依赖。

实测覆盖ACP/headless可写实现/真实readonly、环境与网络名单、持久session、当前全文副本及清理、可信验证资产、冻结源码，以及TCP失败→自主修复→真实passed→只读报告→最新Context Session Agent→cold原run/预算/来源→最终人工未决。漂移、伪造stdout、非零/信号、取消与超时继续fail-closed。

入口报告与进程回收另用离线替身验证，替身结果不作为原生OS证据。Ubuntu x86_64 GitHub Actions已配置，当前尚未核验运行结果；其他发行版/内核/容器策略、真实厂商及可信工具链需独立验证。实际OS通过不证明业务覆盖充分或允许自动合入。

本阶段全量1913项/133文件通过，typecheck/build:all/diff通过；两平台编译后Worker/宿主严格检查通过，Linux实际fd9 NUL参数文件的只读遮罩/子缓存可写通过。npm pack dry-run为210文件，包含两个helper及编译适配模块；856本地文档链接无缺失。整体持续优化目标仍active，本阶段不视为全部目标完成。
