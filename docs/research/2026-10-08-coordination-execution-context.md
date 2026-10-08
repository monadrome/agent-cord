# 协调执行观察验收

日期：2026-10-08。范围：隔离临时 git 工作区、真实离线 worker 子进程、本机 Claude architect 协调；未采用提议、未批准人工 gate、未合入 Draft。

## 反例与实现

9 个核心反例先全部复现：任务 started→failed 不改变协调输入、活动 run 接受 advance、非法宿主观察未阻止调用。ADR-0048 后，worker 任务记录 run_id，宿主提供当前 run 和最新任务的受限观察；prompt/hash/完成/查询/采用共用它，活动 run 只能 wait/ask_human，任务来源链接打开对应事件。

首轮扩展定向 71/73 通过。一个活动测试使用 fail fixture，该模式立即退出且忽略 sleep，改为真实静默 fixture；旧采用写失败后同轮重试用例因新增 run 事实使观察变化，改为旧提议 409、重新协调后采用。没有放宽新鲜度规则。

## 实际链路

宿主注册离线 worker fixture 与真实 Claude 命名角色。worker 第一次以实际退出码 3 失败，run=failed/inactive；协调者得到任务 failed、failure_stage=driver，严格 wait Draft 引用该 completed event_id，并明确 active=false。

server 重启不重放失败 worker 或模型。修复 worker 配置后启动新 run，生成计划 Draft 并停在人工 gate；worker 任务为 ok，run 仍 active。真实协调者引用新的 completed event_id，并区分 ok 与 active=true；旧轮次 current=false，输入和 execution_context_hash 均不同，任务正文/错误日志未通过观察注入。

两轮均未调用工具，PRD 不变，human.decision/node.exited/adopted=0，session doctor=true。任务成功仅证明 fixture 产出完成，不代表机器验证、模型评审或人工审批通过。

关闭人工等待的宿主再启动，active=false、run 登记恢复为 waiting_human，旧活动轮次失效。第三次真实 Claude 协调引用同一 ok 任务并明确 active=false，没有 worker 重放或新工作流事实；新轮次 current=true，人工 gate 继续未决。

## 回归与边界

Playwright 与本机 Chrome 验证 1440/390/320 宽度：任务来源链接均导航到并展开对应 agent.task.completed，payload 的 run_id/status 与验收事实一致，无横向溢出或 pageerror。桌面/手机截图经查看无文字重叠；截图先重置滚动位置，避免固定导航出现在完整页面截图中段的捕获伪影。验收工具单独装于临时目录，未改变应用依赖。

全量 765 测试 / 61 文件、build:all/typecheck/git diff --check 通过。覆盖当前 scope/run、缺失/坏最新/旧来源、重试编号、观察读故障、在途变化与恢复、冷 started 语义和原生 worker run_id。

run.active 是当前匹配且未终态的宿主槽位，不能当作 OS PID 存活证明。旧无 run_id 任务保留审计与既有 checkpoint 复用，但不猜测当前来源；任务事实也不证明仍对应最新源码/文档。真实运行数据、模型正文和截图只保留在临时工作区。
