# ADR-0069 ｜ 同 workspace agent 执行 lease

- 状态：accepted（进程内隔离原型）
- 日期：2026-10-09
- 关联：ADR-0011（每任务 subprocess）、ADR-0025（取消与恢复）、ADR-0027（工作区 agent 配置）、ADR-0068（只读工具审计）
- 来源：RunService 并发边界审查；同一 server root 下不同需求可同时修改共享源码

## 背景

RunService 原来只按 `req_id` 限制 active run。两个需求使用同一个 server workspace 时可以同时派发 ACP/headless worker，互相看到未提交源码、测试临时文件和需求外的变更；事件流虽然按需求隔离，物理工作区却没有隔离。文档安全基线要求独立 worktree/进程，但当前实现尚未提供 worktree 生命周期。

## 备选方案

1. 继续允许同 workspace 并发，依赖 agent 自觉只修改自己的路径。
2. 每个 run 自动创建 git worktree/copy，并在结束时合并回主工作区。
3. 在 worktree 尚未实现前增加 server 进程内 workspace lease；同 root 同时只允许一个含 `node.run` 的 run。

## 决策

采用方案 3 作为过渡性 fail-closed 边界。RunService 在 start、冷恢复和原授权 Goal 恢复派发前占用 workspace lease。新 start/Goal 授权或显式恢复命令遇到占用返回 conflict/409，不追加新的启动、授权或恢复请求事实，不派发 worker。没有 `node.run` 的离线流程不占 lease。启动失败无条件释放；已经派发的 executor 只在 finally 收束后释放，索引终态不证明进程已结束。关闭期间停止新增派发，重复释放核验 req_id/run_id。不同 RunService 实例各自维护 lease。

冷恢复遇到占用时保留原 run/status/预算，不写 failed，不创建新 run；暂存原 run_id，lease 释放后经既有串行恢复器重新核验全部事实再恢复。再次重启可从原启动事实重建这些待恢复运行，取消或被更新 run 替代时不派发。冷人工等待没有活动 executor，不持有 lease；未来恢复仍先获取 lease，审批继续核验当前源码/证据，lease 不保证交付版本在审查期间冻结。

lease 覆盖只读和可写 agent run，因为只读命令也可能生成临时文件、读取不一致源码或影响外部工具缓存。它不改变目标级 Goal 预算、人工 gate、ACP permission 或 agent 配置身份；冲突只阻止新的 run，不自动排队、不扩预算、不改旧事件。

## 理由

1. 共享目录并发是物理状态污染，不能靠需求级事件 scope 或 prompt 约束解决。
2. 新启动用 409 明确拒绝，不登记未授权的队列；已授权恢复继续使用原 run 的启动事实，避免资源竞争耗尽人工注意力或改写执行失败。
3. lease 不需要修改 core schema/ports，能先约束当前单进程 server 的真实风险，同时保留后续 worktree/copy 迁移空间。

## 被否方案的否决理由

- 方案 1：同一测试/源码目录的写冲突会造成不可归因的验证和 artifact 证据，违反 Goal 当前输入绑定。
- 方案 2：自动合并、冲突处理、未提交变更归属和跨平台 git 状态需要独立协议；在没有明确产物合并事实前不能偷偷把 worker 修改复制回主目录。
- 新启动的自动等待队列：未落盘的排队授权在进程崩溃后无法恢复；原 run 的恢复引用则可从既有事实重建。协调观察的 active=false 明确说明延后 run 尚无活动执行器。

## 限制与后续

这是单个 RunService 进程内的 lease，不是跨 daemon/机器的分布式锁；server 多副本或外部进程仍可能写同一目录。它也不阻止 agent 自己启动的子进程访问 workspace 外路径。后续应为高风险 Goal 增加独立 git worktree 或 OS/container sandbox，并把 lease/queue 状态纳入可恢复事件协议。

## 验证重点

同实例不同需求并发只登记一个 run；真实 ACP/headless 在途取消回收进程才释放；登记/启动事实/worker 失败释放；不同 root 可并发；无 agent 流程兼容；多个冷运行和索引删除后串行恢复；延后取消不派发；Goal 新授权和恢复占用时不落额外事实、释放后原 token 可用；关闭不重复占用或遗留 lease。
