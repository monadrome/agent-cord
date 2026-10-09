# 人工处理卡点后的 Goal 续跑验收

日期：2026-10-09。协议见 [ADR-0059](../adr/ADR-0059-human-goal-retry.md)，原自动升级见 [验收记录](./2026-10-09-automatic-goal-escalation.md)。

## 交付行为

有效自动问题答复后，控制台展示当前可授权输入和原发布次数/时长预算；“重新执行 Goal”是独立命令。宿主在运行槽位与授权记录前重检，记录新 started 和 goal.retry.authorized，再派发固定配置的 worker。答复、旧 blocker、问题、预算与新 run 保留因果来源；原 failed run 和上游退出事实不回滚，最终 gate 不放行。

源码/事实变化时旧输入 token 返回 409，刷新后可授权最新输入。重复请求返回同 run；撤回、被替代答复、错误来源、归档或无授权中断均 fail-closed。授权后撤回答复仍保留历史授权，不自动取消已有 run；取消使用现有命令。

## 离线回归

11 项续跑测试覆盖成功到人审、不同幂等键并发、重复恢复、过期输入、缺/伪造/撤回答复、启动记录前竞态、授权追加失败和修复后新键重试、归档/额外预算字段拒绝、另一个 run 替代、索引删除、坏 actor/引用/重复/迟到授权、预算不匹配以及授权后撤回。

索引删除反例发现同版本新 run 的人审等待会污染旧 failed Goal 登记；修正为旧 run 按自身 blocked 事实恢复原失败原因。缺授权的半成品 started 不能派发；只有当前同轮次 failed 且确无授权/worker/Goal started 事实时允许新命令重试，副作用未知时拒绝。

全量离线测试 930 项 / 71 文件通过，typecheck、build:all 和 git diff --check 通过。状态验证使用需求/审批事实投影；warm runner 挂起时其运行登记仍可为 running，冷恢复投影为 waiting_human。

## 真实 Codex、HTTP 与浏览器

在新隔离微型仓库设置数字加法任务，business.json 表示由人工提供的外部验收就绪事实。测试包含外部就绪、正数、负数和零四个用例。

1. 真实 Codex worker 修复代码并报告外部事实未就绪；宿主实际检查失败，Goal blocked，真实 Codex supervisor 自动形成有限问题。
2. 浏览器验收脚本明确模拟人工答复及外部事实更新，不操作此前任何真实待审 Draft。答复本身没有启动 worker。
3. 使用旧 token 的授权请求被 409 拒绝，没有生成新 run 或额外模型调用；刷新当前依据后点击“重新执行 Goal”，记录一次人工新预算授权。
4. 同一实际 Codex worker 在新 run 下继续，自测四个用例通过，宿主生成当前通过事实与指南证据，停最终人审。
5. 总计 worker 2 次、supervisor 1 次、模拟澄清答复 1、授权 1；intake 退出 1、deliver/done 未退出、人工 gate 决定 0、未合入/发布。
6. 冷恢复保持审批 ID、原 failed run 和新授权来源，不重复模型；session doctor=true。

Playwright/Chrome 在 1440、390、320 宽度检查授权前的预算/按钮、成功后的新 run、按钮移除与最终审批。无横向溢出或 pageerror；桌面和 320 截图已查看，文字与控件无覆盖。首次截图跨同 hash 页面未刷新到已变更的输入，实际授权正确被拒绝；验收后按真实刷新状态继续，保留原答复且未重复发起模型。

临时证据 `/tmp/cord-stage45-real-result.json`、`/tmp/cord-stage45-browser-result.json` 保存工作区、运行/授权来源与截图位置；模型正文、截图和运行数据不提交。

## 范围限制

续跑授权使用原发布预算，没有动态增额、费用/token 配额或新权限授权。当前支持自动 ask_human 的有效答复；wait 与旧手动轮次不提供该命令。真实模型验证是微型场景，模拟人工处理不代表未授权自动代答。后续仍需权限策略、完整验收覆盖和资源治理，持续目标 active。
