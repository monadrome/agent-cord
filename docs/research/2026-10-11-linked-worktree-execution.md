# 独立Git工作树执行：Human Review指南

## 使用与交付边界

```bash
npm run cord -- worktree /absolute/path/to/draft --base HEAD
CORD_ROOT=/absolute/path/to/draft CORD_PORT=7251 npm run serve
```

第一条命令在当前Git仓库的明确commit创建detached linked worktree，输出JSON：root、git_directory、common_directory、head_commit和identity_hash。父目录须已存在，目标路径须不存在且位于源树/公共Git元数据之外；不force、不创建或切换主分支，不自动删除失败现场。省略`--base`时源工作树必须干净；显式base只检出commit，不额外复制源目录中的dirty/ignored输入、旧授权、缓存或凭据。

base含已跟踪的需求session、索引或SDLC管理文件时创建前拒绝。`cord/agents.yaml`、`cord/cord.toml`和`cord/knowledge/`允许随代码版本进入新树；配置中的凭据应为环境引用，安装依赖与补充最新PRD在新工作树内进行。不自动安装依赖或迁移已有运行。可通过原始平台安装位置启动server，`CORD_ROOT`决定worker、宿主检查、事件与报告根；验证命令所需依赖必须在目标工作树内准备。

server核验linked根后，Agent清单/inspect与Context Session Agent能力快照公开`workspace_isolation=worktree`。节点可声明：

```yaml
run:
  agent: implementer
  require_capabilities:
    workspace_isolation: worktree
```

普通主工作树、非Git工作区和子模块仍是shared_lease。直接实例化ACP/headless driver也保持原声明，工作区宿主包装才提供绑定；包装不会修改底层实例。工作树内同一server仍使用原lease，两个不同工作树各有独立源码、session、index与lease，可以同时交付不同目标。

## 审查入口

1. [ADR-0096](../adr/ADR-0096-linked-worktree-execution.md)：完整执行单位、能力、恢复与限制。
2. [worktree.ts](../../src/workspace/worktree.ts)：argv Git操作、固定commit、目标/旧数据拒绝、登记/反向引用/目录身份、派发前后和resume校验。
3. [cli.ts](../../src/cli.ts)：worktree薄入口、JSON结果、linked树公共Git配置doctor。
4. [agent-service.ts](../../apps/server/src/services/agent-service.ts)：固定resolver、底层inspect与包装身份、重载拒绝根漂移。
5. [run-service.ts](../../apps/server/src/services/run-service.ts)、[coordination-service.ts](../../apps/server/src/services/coordination-service.ts)：源码、验证、人审与当前提议共用物理工作树核验。
6. [创建/身份测试](../../tests/workspace/worktree.test.ts)、[真实TCP交付测试](../../apps/server/tests/worktree-execution.test.ts)：真实Git与离线ACP/headless子进程。

## 验收路径

| 条件 | 实际证据 |
|---|---|
| 新工作单元独立 | 两树固定同一commit，独立git-dir；更改一树源码不影响另一树/主树 |
| 不暗中丢弃/复制输入 | dirty默认拒绝；显式base保持源dirty不变，旧session/ignored凭据不复制，已跟踪旧授权拒绝 |
| 准入能力来自实际执行 | server-root核验后cap=worktree；配置hash绑定root/metadata，普通根保持旧身份 |
| 参数/副作用边界 | existing/越界/路径别名/非法ref先拒绝；本次hook与Git环境覆盖禁用；失败保留现场 |
| 模型/模式一致 | ACP writer large/high/code、readonly small/low/plan；headless writer/high、reviewer/low，调用和实际文件位于目标树 |
| 完整交付 | 当前worktree源码通过宿主命令、验收矩阵与变更指南，只读报告由宿主代写，最终人工gate未决 |
| 最新需求协调 | PRD A→B使旧轮次过期，新prompt只包含当前B；一树需求更新不使另一树提议过期 |
| 冷恢复 | 原run/审批ID保留且无重复模型调用；持久等待的active状态变化使旧轮次过期，显式新协调读取最新观察 |
| 身份漂移 | gitfile缺失/复制/执行中变化/物理目录替换拒绝；等待中的审批/协调/重载拒绝，恢复原根后可继续查询 |
| 查询与人工权限 | ACP inspect无prompt、无worker调用；无自动人工决定、done退出、合入或发布 |

```bash
npx vitest run tests/workspace/worktree.test.ts apps/server/tests/worktree-execution.test.ts apps/server/tests/agent-registry.test.ts tests/cli/doctor.test.ts
npm test
npm run build
npm run typecheck
npm run build:all
git diff --check
```

先通过账本读取接口重建派生投影再运行doctor；doctor本身只报告投影漂移。完整验证为1663项/119文件、typecheck/build:all/diff通过；最终文档257个本地链接完整。

隔离实际预览包含ACP/headless两棵工作树：并发Goal实现、自测、只读协调、独立配置身份与lease均通过，主树业务值保持initial；各审批1、人工决定0、节点退出0、当前wait提议与doctor=true。Playwright 1440/390/320共6张截图，工作树能力/只读ACP无prompt查询正常，无pageerror或页面横向溢出；已查看桌面与320截图。临时证据位于`/tmp/cord-stage86-real-result.json`、`/tmp/cord-stage86-browser-result.json`，不入仓库；预览只使用离线fixture，无付费模型调用。

## 限制

该原型按整个server/root隔离工作单元，不是一个server内部按节点自动分配工作树。Git公共配置、对象、refs仍共享；CLI/工具未被OS禁止访问其他路径或网络，验证器与worker仍共享可写环境。没有自动清理、自动合入、凭据复制或旧需求迁移；不把worktree当os_sandbox。目录身份的dev/ino对移动/重建不便携，变化需要重新核验旧授权和交付，不能靠重载悄悄接管。

验证使用离线fixture和真实Git/协议/进程/TCP，不调用付费模型；证明宿主控制契约和实际工作树边界，不能证明任何LLM的业务质量或账户额度。最终review、合入、发布和关键gate保持人工。
