# 活动 run 等待投影与 Human Review 指南

## 问题

上一轮ACP交付集成验收发现：已有合法Goal ready和最终审批，需求状态waiting_human，直接getRun却始终running。RunService只在executor返回后登记状态；正常人工gate promise挂起没有返回。控制台运行实例与协调run.status读取该登记，无法准确描述当前等待。

## 行为

新增server纯函数`project_active_run_wait`。只投影当前本机活动槽位且登记为running/waiting_human的run，核验唯一workflow.run.started与SDLC/version/revision/来源绑定，再消费当前同workflow/revision的gate等待和有效人工决定。valid选择必须等待ID、evaluation_hash、允许选项、chosen_index、human actor和事件顺序一致；选择说明输入已给出，不是gate通过。invalidated/resolved/当前取消清除等待，其他run迟到取消不污染当前。

`getRun`、REST运行列表、需求active_run、`latestRun`及协调执行观察共用该投影。列表同需求共用一次严格事件读取，协调沿用现有同批事实；原始SQLite登记与同步listRuns保留恢复/维护用途。活动查询失败时拒绝旧状态，异步读取期间取消则保留最新登记终态，历史/其他run不借用当前等待。

查询没有追加事件、写结束时间、产生人工决定或释放lease。等待状态仍active=true，独立协调不能据此启动新run或complete。正常零人工的Goal修复路径保持原样，最终人工gate仍人工。

## 操作路径

1. 使用Goal流程启动代码Draft，自主实现/修复/宿主检查完成后进入最终审批。
2. 需求概览和“运行实例”的状态都显示“等待人工”；`GET /api/v1/runs/:run_id`与`GET /requirements/:req_id/runs`同样返回waiting_human。
3. 独立协调读取该状态，明确该执行器仍active，输出wait/ask_human Draft。
4. 人工输入后显示正在继续处理，宿主gate重新核验，再决定推进/拒绝；恢复与取消沿用已有规则。

## 人审重点

- `apps/server/src/services/run-status.ts`：活动/终态/历史边界、启动绑定、等待与有效选择、多个等待逐项校验。
- `run-service.ts`：严格读取、不回退旧状态、readRuns按需求共享事件、读取期间取消时再读登记、latestRun共批投影。
- `app.ts`：运行列表/dashboard使用公开readRuns；控制台不新增状态机。
- `run-status.test.ts`与`active-run-status.test.ts`：真实TCP HTTP、gate.waiting落盘/ask前窗口、选择后worker、失效重检、取消、不可读后恢复、冷恢复/索引重建、run/revision隔离。

新的查询语义使旧workspace lease测试中“已有审批仍running”的断言改为waiting_human；lease仍占用、原启动/任务数量保持。已有Goal交付测试也直接核验实时run waiting，不必重启才能正确展示。

## 验证与边界

完整离线测试与真实fixture子进程覆盖活动等待、成功/拒绝选择、异常/恢复、版本/历史边界。隔离TCP HTTP实际Goal worker调用2次，协调1次；单run/列表/需求active_run/协调prompt均waiting_human，SQLite仍running、active=true，审批1/人工决定0/节点退出0/doctor=true。临时数据与截图保留/tmp，原真实Draft未操作。

该投影只修正本机活动run的人工输入等待，不重构完整run终态算法或同版本跨run的workflow历史。inactive历史仍使用原登记；跨daemon本机槽位并不共享。当前状态不证明审批依据仍新鲜或源码已冻结，放行时已有宿主输入/Goal ready核验继续执行。

最终验证：`npm test`1250项/84文件，`npm run typecheck`、`npm run build:all`、`git diff --check`与113本地文档链接通过。浏览器1440/390/320三张截图确认运行实例“等待人工”，无pageerror或页面横向溢出；证据`/tmp/cord-stage62-real-result.json`、`/tmp/cord-stage62-browser-result.json`和`/tmp/cord-stage62-final-tests.json`。
