# 跨 run worker 复用与来源追溯验收

日期：2026-10-08。范围：隔离临时 git 工作区、真实离线只读 worker fixture、真实 Claude architect 协调、实际 HTTP 与 Playwright/Chrome。未批准 gate、未采用提议、未合入 Draft。

## 问题与实现

3 个反例先复现：有效跨 run 复用没有审计事实、协调投影为 missing、复用追加失败无法阻断后续 gate。输入变化重跑的对照通过。ADR-0049 后新增 agent.task.reused、原完成引用校验与恢复去重，任务观察区分 reused/ok，执行观察身份升级 v6。

扩展回归覆盖缺失/未来/自引用/错误类型/错误 scope、被新任务覆盖、摘要/correlation 不符、坏最新复用去重、旧无 run_id 的显式绑定以及原完成与调用元信息一致性。交接审查补充重试编号超过上限的三项反例，全部先复现，再验证 checkpoint 拒绝、worker 重跑与合法新完成复用恢复。记录写失败上抛，不进入后续 gate；修改需求后仍重新执行，不记录伪复用。

## 实际链路

初次 run 调用只读 fixture，宿主保存报告，任务 ok 并停在人工 gate。真实 Claude 返回 wait 并引用原 completed。随后显式取消该临时 run，在输入/配置/报告不变的同版本下启动新 run：没有新的 worker 调用或 completed，只有一个 reused 指向原始完成，报告字节不变。

server 重启保留新审批 ID，不重复追加复用事实。第二次真实 Claude 明确写出 reused、原 completion_event_id、未重新执行，并引用当前复用 event_id，旧轮次失效。整个链路 worker 实际调用 1 次、started/completed/reused 各 1 条，human.decision/node.exited/adopted=0，PRD 不变，doctor=true。

Playwright 与本机 Chrome 在 1440/390/320 宽度验证“提议→复用事件→原完成事件”，展开正确 run/status，tooltip 与来源容器边界正常，无横向溢出/pageerror。桌面/手机截图经查看无重叠；运行事实、模型正文和截图仅保留在临时目录。

## 验证与边界

最终全量 793 测试 / 62 文件、build:all/typecheck/git diff --check 通过，原真实开发 Draft 实时仍为审批 1、人工决定 0、done 未退出。阶段 35 预览重启到补齐校验的源码后，started/completed/reused 仍各 1 条，最新 wait 提议 current=true，审批 1、人工决定/节点退出 0。

复用只表示记录时宿主接受该 checkpoint，不认证事件作者、OS PID、模型质量或外部 CI，不代替当前机器验证与人工 gate。没有当前 run_id 时不猜测运行身份，旧观察 hook 可省略有默认值的新字段。纯 hash/reducer 未改变。
