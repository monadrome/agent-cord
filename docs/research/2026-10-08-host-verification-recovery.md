# 宿主机器验证与重启恢复验收

日期：2026-10-08。验收使用独立 clone（基线 `6c5e345`）执行宿主离线命令，server 从当前工作树载入本次恢复修复；不调用模型、不批准人工 gate、不提交 Draft。

## 场景

验证节点先因缺少 `offline-tests` 结果进入 escalation 等待；关闭 server 再启动，原 run 没有活跃 executor。宿主获取当前 verification context，在 clone 执行以下真实命令：

```bash
node node_modules/vitest/vitest.mjs run tests/core/hash.test.ts tests/workflow/scope.test.ts
```

命令退出码为 0，13 个测试、2 个文件全部通过。随后通过 REST 提交原 run ID、输入 hash、命令 hash、输出 hash、耗时与状态，不把 stdout/stderr 正文写入事件流。

## 结果

提交成功后恢复同一 run，机器 gate 通过并进入 `human_confirm`。再次重启不重复恢复已经消费该结果的 executor，审批 ID 保持不变。运行登记只有一个，`human.decision.recorded=0`，没有节点退出；clone HEAD 保持原基线、已跟踪文件无差异、session doctor=true。

新增 REST 回归另外覆盖早到结果、并发结果、无关验证、失败后恢复、人工终审和取消前后及取消/恢复并发。clone 命令证明真实执行结果能接入恢复路径；本次实现本身由当前工作树的全量 586 测试、构建和类型检查验证。该验收依赖受信宿主如实提交结果，不构成外部 CI 身份认证或任意命令执行证明。
