# Goal卡点来源与同ACP自动监督：Human Review指南

## 修复范围

自动升级入口过去没有验证system actor的ID，历史请求读取却要求`goal-runner`。错误来源会先写入`coordinator.round.requested`，然后轮次读取报错。本阶段把来源判定统一到纯`resolveGoalBlocker`，在写请求前拒绝错误actor和重复目标ID，避免污染协调列表。

规则覆盖指定完成事件的type/ID、session/workflow scope/run/node/correlation、合法blocked payload、system/goal-runner actor/source。它只验证指定事件，最新run/Goal、请求/授权的因果前缀和seq仍由caller核验；不证明OS写者身份、真实模型使用或业务结论。

## 同ACP监督流程

工作流的`run.agent`与`goal.supervisor_agent`可以指向同一ACP别名；该agent同时提供可写launch和完整readonly_launch。首次Goal实现使用code配置，达到预算边界后宿主自动派发plan配置，Context Session Agent只可根据绑定blocker提出ask_human/wait。

最新PRD或只读配置改变时，旧提议与协调重试token失效；刷新后可明确重试同blocker，使用最新快照与固定resolver。协调重试不会派发实现worker或添加Goal尝试。冷恢复不重放已请求的supervisor。

记录答复只追加澄清事实，原run保持failed。独立`retry-goal`命令才授权新run及原发布预算，绑定当前输入、worker/supervisor配置和答复；重新自测通过后仍停在最终人工gate。测试中的新预算为1次/30秒，重复同幂等命令只产生一次授权。正常自动修复流程直接交付，不增加中途协调或人工问答。

## 审查入口

1. [goal-coordination.ts](../../src/coordinator/goal-coordination.ts)：共用来源函数、唯一目标、历史请求与父子来源约束，不从重复引用中选第一条。
2. [coordination-service.ts](../../apps/server/src/services/coordination-service.ts)：validateGoalBlocker写前和readGoalRetryState都使用共用核验，保持当前run/最新Goal与配置/输入重检。
3. [goal-retry.ts](../../src/coordinator/goal-retry.ts)：新预算授权的历史prefix与共享blocker来源，答复/原run/新run/发布预算血统继续有效。
4. [来源单元测试](../../tests/coordinator/goal-blocker-source.test.ts)、[升级回归](../../apps/server/tests/goal-escalation.test.ts)：错误actor先写坏请求的失败反例已复现并修复，目标重复ID写前拒绝，合法来源修复后可升级；各种绑定/source错误仍拒绝。
5. [同ACP真实TCP验收](../../apps/server/tests/acp-goal-supervision.test.ts)：code→plan自动升级、答复与授权分离、cold去重、最新PRD/profile变化、原budget与最终gate保持，以及happy path自动修复零中途问题。

## 实际证据

阶段72全量1404项/98文件、typecheck/build:all/diff与122个本地文档链接通过。隔离实际HTTP的调用为code、plan、plan，最后一次基于最新PRD重试同blocker；Goal尝试仍1、协调请求2、current/answerable=true。没有人工答复、新预算授权、人工gate决定或节点退出，doctor通过。该预览保留问题供查看，不自动回答。Playwright1440/390/320三截图通过，pageerror/写请求均为空，桌面与最窄截图已查看无覆盖或横向溢出。

浏览器路径为`/#/requirements/REQ-SUPERVISION/coordination`，应显示“Goal 自动升级”、当前依据、两项澄清选项，未选择时“记录答复”禁用，未答复时没有“重新执行 Goal”。截图/脚本只保存在临时目录。证据定位`/tmp/cord-stage72-real-result.json`、`/tmp/cord-stage72-browser-result.json`，完整记录见[progress.md](../../progress.md)。

全部验证使用确定性离线fixture，不调用真实LLM、不证明OS隔离；宿主自测/源码/产物核验与最终人工review仍独立。原真实开发Draft未操作，合入/发布与关键gate保持人工。
