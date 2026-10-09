# 原授权 Goal 恢复验收与 review 指南

日期：2026-10-09。原则见 [核心 feature](../core-features.md)，协议见 [ADR-0063](../adr/ADR-0063-goal-recovery-command.md)。

## 行为变化

配置恢复或授权后中断的 Goal 以前只有内部 recover 可用；REST 重放 retry-goal 只返回旧 run，普通 start 会创建新 run。现在公开恢复依据与操作：GET/POST `/api/v1/runs/:run_id/goal-recovery`，控制台详情页显示“恢复原 Goal”、原剩余次数和截止时间。

恢复请求引用原授权、checkpoint、当前输入及 worker 身份，先持久化 `goal.recovery.requested` 再恢复同 run。没有新预算、没有新授权、不自动放行。当前 ready 仍有效时恢复原审批；需要新尝试时保留已消费编号和第一次尝试的 deadline。耗尽/blocked、旧输入、配置漂移、取消、非当前/非授权和坏来源拒绝。已消费恢复不触发自动循环，请求未消费时冷恢复仍须重检输入。

## Review 定位

- `src/core/schema.ts` 与 ADR-0063：恢复事件及 strict 字段约束；不包含模型正文/命令输出或凭据。
- `src/coordinator/goal-recovery.ts`：纯恢复 token、checkpoint、原授权与请求因果链、已消费判定；历史事实不修改。
- `apps/server/src/services/run-service.ts`：固定配置重检、首 await 前运行槽位、事件先于派发、冷恢复未消费意图、ready 复用及预算边界。
- `apps/server/src/services/index-store.ts`：恢复 running/waiting_human 时清除派生旧 finished/error；原失败事件仍可查。
- `apps/server/src/app.ts`、`contracts.ts`：REST 与 server 恢复依据投影；共享幂等机制。
- `apps/console/src/api.ts`、`pages/RequirementDetail.tsx`：typed client 与原 Goal 恢复按钮，前端不推导预算或授权。

## 验证范围

30 项续跑与恢复测试涵盖同 run/同审批、写失败、不同键并发、重放、旧 token、请求后中断/输入变化、冷身份漂移/还原、归档原版本、取消/未授权、耗尽/过期 ready、原 deadline 与剩余次数、索引删除、坏请求来源、消费后不循环和 typed client 真实 HTTP。全部离线测试 1026 项 / 74 文件通过，typecheck/build:all/diff 通过。

隔离真实 ACP fixture 场景模拟原授权落盘后首次派发前中断：worker 1/supervisor 1，冷漂移不允许恢复，还原配置后 available=true。浏览器先验证当前恢复依据，修改 PRD 后旧输入 409 且没有模型调用；还原 PRD 后点击恢复，原 run 继续，自测通过、指南齐备，停最终人审。worker 总计 2、授权 1、恢复请求 1、gate 决策 0、done 退出 0。

恢复后再次冷启动，审批 ID 保持、worker 不重复，doctor=true；派生运行登记不再显示旧失败文案，原事件历史保留。

Playwright/Chrome 检查 1440/390/320 的恢复前后界面，无横向溢出或 pageerror，桌面与 320 截图已查看。临时证据 `/tmp/cord-stage49-real-result.json`、`/tmp/cord-stage49-browser-result.json` 保存工作区/请求/截图定位。原真实 Draft 未操作；本轮无需付费模型调用，fixture 验证真实协议/子进程和宿主执行路径。

## 限制与后续

公开恢复仅覆盖已具人工续跑授权的当前 Goal；普通 failed run 与新的权限/额度继续使用现有入口，不泛化授权。共享可写工作区和脚本仍是信任边界，hash 不代表抗恶意篡改。完整验收条件覆盖、跨 driver 命令/网络授权与费用/token 治理仍待完善，持续目标保持 active。
