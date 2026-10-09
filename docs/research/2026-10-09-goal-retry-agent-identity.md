# Goal 续跑授权身份验收与 review 指南

日期：2026-10-09。原则见 [核心 feature](../core-features.md)，协议见 [ADR-0062](../adr/ADR-0062-goal-retry-agent-identity.md)。

## 问题与行为

旧实现多次校验 live resolver，却用另一次捕获的 resolver 派发。确定性 A/B/A 回归证明人工 token 校验的是配置 A，实际 worker.started 却记录配置 B。冷恢复也无法从聚合 input_hash 独立核验授权角色。

现在首次校验前捕获 resolver，校验与派发使用同一快照；授权记录完整 worker/supervisor/节点输入 hash。授权前配置变化拒绝，授权后的热重载不改变在途 worker。冷恢复与人审核验授权身份，漂移拒绝派发或记录放行；恢复原配置后显式恢复原 run/预算。首次 worker 派发前输入变化同样拒绝。旧授权三字段全缺省仍可读，但没有合法任务来源时不恢复派发。

## Review 定位

- `src/core/schema.ts`：完整三 hash 或全部缺省的兼容约束。
- `src/coordinator/goal-retry.ts`：授权前因果链与授权后任务归因；首条坏来源不回退后来成功。
- `apps/server/src/services/coordination-service.ts`：首次捕获配置，授权前重检当前身份，事件与派发共用 snapshot。
- `apps/server/src/services/run-service.ts`：启动/节点派发/冷恢复/人审共用身份检查，过期审批重检原 run，显式恢复不授予新预算。
- `apps/server/tests/goal-retry.test.ts`：重载、首次派发输入、旧授权、恢复与真实人工决策回归。

## 验证

20 项续跑回归及 Goal 交付/自动升级合计 43 项通过；全量 1016 项 / 74 文件通过，typecheck、build:all 与 diff 检查通过。冷配置恢复后明确人工决策可以完成原 run，仍有效 Goal 不重复 worker。

隔离 HTTP 使用真实 ACP fixture 子进程：首次失败自动升级，验收脚本模拟答复；重载使旧 token 409，恢复配置后授权一次并交付。冷配置漂移 failed，旧人审 409 且没有决策；恢复配置后显式恢复同 run、同审批，重复续跑命令返回同 run。最终 worker 2 次、supervisor 1 次、授权 1 次、gate 决策 0、done 退出 0、doctor=true。无付费模型调用，原真实 Draft 未操作。

Playwright/Chrome 在 1440、390、320 宽度验证同审批仍可见、已执行 Goal 的重复命令移除、无横向溢出与 pageerror；桌面与 320 截图已查看，无文字/控件覆盖。浏览器首轮文本精确定位与实际渲染标签不符，修正验收定位后通过，没有修改运行行为或重新调用 worker。

临时证据 `/tmp/cord-stage48-real-result.json`、`/tmp/cord-stage48-browser-result.json` 保存隔离工作区、事件及截图定位。运行数据、截图、临时脚本不提交。

## 限制

本次配置身份不包含环境凭据；外部角色改变仍需显式更新 context_revision。hash 与来源校验不能替代 OS 隔离或对共享可写验证环境的完整保护。显式恢复由 RunService.recover(run_id) 提供，未增加 REST 恢复入口；恢复仍遵守原尝试与时长预算。首次已启动 worker 后的正常输入演进由现有 Goal 新鲜度机制处理。
