# Headless真实进程完成：Human Review指南

## 问题与结果

Headless之前在看到result后跳过非零退出检查。CLI输出`result/success`或`turn.completed`后退出3或被信号终止，宿主可能把候选文本记为ok，写成评审报告、形成Goal ready或独立协调提议。真实离线fixture已先复现这些反例，execa实际结果中的failed/exitCode/signal是执行收尾事实。

现在完整流仍立即返回候选result；异常进程结束随后返回error。宿主读完整流，任何失败均阻止报告写回、完成复用和提议生成。失败候选文本/usage与已经写出的部分代码可作为历史，不能标为当前就绪。timeout和外部abort仍保持原分类，进程树完成收束后结束迭代。

ACP以session/prompt RPC完成为边界，宿主之后主动关闭长驻进程；不要求它因宿主终止而返回退出0。普通CLI退出0也不能代替Goal的实际测试、源码新鲜度和最终人工review。

## 配置身份迁移

所有原生HeadlessDriver使用`cord.agent-config.headless.v4`，绑定`completion_policy: process-exit-required.v1`与`launch_configuration_hash`。后者是原v1/v2/v3完整启动定义摘要，继续覆盖bin、前缀、new/readonly/resume四argv、独立配置是否声明和context_revision；env/凭据仍不参与。

已有有效argv不变，两个只读profile也不合并。旧身份任务/审批/协调按现有未退出恢复与输入新鲜度规则重验，不能声称旧ok已经包含退出证明。新策略下相同输入完成仍可复用，cold等待不重做。历史已退出节点不回滚；ACP和外部独立driver的身份不变。这是保守失效策略，平台不能恢复历史缺失的进程状态。

## 审查入口

1. [headless.ts](../../src/driver/headless.ts)：v4完成策略、完整旧启动定义hash、execa.failed/exitCode与timeout优先、流结束前清理。
2. [driver测试](../../tests/driver/headless-completion.test.ts)：10项真实Claude/Codex/文本模式、晚非零/信号、正常退出、result后timeout/abort、旧三个域迁移。
3. [宿主测试](../../tests/coordinator/headless-completion.test.ts)：3项可写/只读失败保留人工原稿、无ok/写报告/复用、旧完整未退出checkpoint重跑、新完成随后不重复worker。
4. [TCP测试](../../apps/server/tests/headless-completion.test.ts)：3项Goal预算内自动重做、持续失败无自测/指南/人审与cold保留失败、最新PRD协调失败/修复/冷恢复。失败轮次current=null表示没有可核验提议，不能显示“当前通过”。
5. [ADR-0090](../adr/ADR-0090-headless-process-completion.md)、[核心Feature](../core-features.md)：Goal交付与权限边界；普通driver失败可在原预算内修复，最终gate仍人工。

```bash
npx vitest run tests/driver/headless-completion.test.ts tests/coordinator/headless-completion.test.ts apps/server/tests/headless-completion.test.ts
npm test
npm run typecheck
npm run build:all
git diff --check
```

完整结果见[progress.md](../../progress.md)。确定性fixture不调用付费模型，也不操作原7306真实开发Draft；实际测试/构建/命令证据在本机临时目录，禁止将凭据、完整环境或运行数据入库。

阶段78最终1513项/110文件、typecheck/build:all/diff通过，16项新增回归全绿。首全量已有help关闭测试一次等待超时；单独19项和第二次全量通过，原因未定位，已补查询提前结束时的公共checks诊断，预算/生产逻辑未改。

隔离实际HTTP预览PID56978、http://127.0.0.1:49493：writer-model/high两次调用分别failed/ok，成功后宿主自测一次、attempt2 ready；cold保持原审批且不重做。PRD更新B后review-model/low协调先failed、修复后ok/current/wait，指南不被失败候选覆盖。审批1/人工决定0/采用0/仅deliver退出、doctor=true、付费调用0。`/tmp/cord-stage78-real-result.json`与`/tmp/cord-stage78-final-tests.json`保留证据；旧ready不冒称对应B需求。

## 限制

直接消费driver的调用方必须读完流，不能遇到第一个result就当作成功或终止迭代；提前return代表取消消费，不证明进程成功。vendor自己返回退出0但隐瞒失败仍需宿主验证发现。最新PRD更新后旧ready只作历史，修复后的current协调wait仅表示当前快照下的提议，不批准旧交付、不增预算或合入。配置策略升级不改变已经退出的历史节点，也不提供OS沙箱、模型权限/额度证明或远端副作用回滚。
