# 同 workspace agent 执行 lease

日期：2026-10-09

## 发现

当前事件流按需求隔离、RunService 也只限制同一 `req_id` 的 active run，但所有 worker 的 `cwd` 都是 server `workspaceRoot`。因此两个需求可以同时运行自定义 ACP/headless agent，并共享未提交源码、测试缓存和外部工具临时目录；事件 provenance 无法修复这种物理写冲突。

开源编码 agent 编排实践通常把每个任务放进独立 git worktree 或沙箱；agent-cord 当前没有安全的自动合并协议，不能把 worktree 变更静默复制回主工作区。现阶段最小可验证措施是同 root 单槽 lease，等独立工作区和合并事实成熟后再放开并发。

## 采用方案

RunService 在启动、恢复和人工授权 Goal 派发前占用进程内 workspace lease。新启动/授权/显式恢复冲突立即 409，不写额外事实；无 agent 的纯 workflow 不占用。启动失败无条件释放，活动 executor 等 finally 收束后释放，不能把索引 failed 当作进程已结束。不同 RunService 的 lease 相互独立。

已有授权 run 的冷恢复冲突保留原身份/状态/预算，lease 释放后自动经既有恢复器重检再派发；重启或索引删除可由原启动事实重建，没有新的排队授权。冷人审等待没有活动 executor，不持 lease，审批仍重检代码与证据的新鲜度。

## 限制

进程内 lease 不能防止另一个 daemon、IDE 或手工命令同时写目录，也不提供 worktree、网络隔离或 OS 级沙箱。它只把当前 server 内最容易发生的并发污染从“未定义行为”变成明确冲突，后续仍需独立 worktree/copy 与跨进程锁定设计。

## Human Review 指南

重点查看 `apps/server/src/services/run-service.ts` 的 `reserveWorkspace`、`releaseWorkspace`、启动 catch 与 executor finally。资源冲突必须发生在新启动/授权/恢复请求落盘之前；恢复延后只保留已授权的原 run_id，后续仍走既有来源、输入身份和预算核验。

操作路径：同一服务下创建两个含 agent 的需求，启动 A 后启动 B 应返回 409，B 不应出现启动/任务事实；取消 A 并确认子进程退出后，B 可以启动且仍停在自己的人工 gate。已有多个未完成 run 冷启动时只派发一个；释放后其他原 run 自动重检恢复，取消的 run 不复活。该路径已经由离线 ACP/headless 子进程和真实 HTTP 验收，证据在 `/tmp/cord-stage55-http-result.json`，验收服务已关闭，没有付费模型调用。

回归入口是 `apps/server/tests/workspace-lease.test.ts` 与 `apps/server/tests/goal-retry.test.ts` 的工作区占用用例；另检查 registry 热重载测试仍证明旧 run 的后续节点使用旧配置、新 run 使用新配置。核心 schema/ports 没有变化，关键 gate、Goal 预算与人工最终 review 保持现有契约。

业务限制：热人审等待中的活动 executor 继续持有 lease，直到流程完成、取消或关闭；冷人审等待无活动 executor，不持有 lease，后续审批仍核验当前版本。此设计牺牲共享目录并发吞吐，实际隔离工作区与跨 daemon 保护尚需后续实现。
