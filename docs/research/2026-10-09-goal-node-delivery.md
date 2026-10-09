# 节点内 Goal 自主交付原型验收

日期：2026-10-09。设计原则见 [核心 feature](../core-features.md)，原型协议见 [ADR-0056](../adr/ADR-0056-goal-node-execution.md)。

## 结果

已实现一个未退出节点内的代码/宿主验证/失败修复/review 指南闭环，覆盖注册的 ACP 与 headless。推荐“Agent 协作 · Goal”模板及 [goal-sdlc.yaml](../../examples/goal-sdlc.yaml) 使用该模式；旧发布版本不自动迁移，最终人工 gate 保持独立。

宿主命令采用 argv 直接 spawn、独立进程组、超时/取消回收，完整输出流计算 hash，原输出只保留有界内存尾部。Goal 尝试与预算落事实，成功 task 不冒称目标就绪。就绪核验当前源码/依赖、完整指南及对应的宿主验证事件；结果或输入变化后不能复用旧 ready。

## 离线验证

- 首轮 9 个反例全部失败，证明原代码存在一次调用成功即返回、测试失败无法自动修复、缺指南不阻断与旧源码交付复用问题。
- Goal 12 项覆盖正常修复、空/缺章节报告、无进展、环境错误、输入变化、取消、总预算、存储追加失败和结果替换。
- 宿主命令 5 项覆盖完整输出 hash/有界尾部、argv 无 shell、超时/取消杀父子进程、缺二进制与预取消的未知退出码。
- server 4 项使用真正 ACP/headless 离线子进程：首次写坏值、实际测试失败、第二次修复、真实通过事实、最终人审挂起；冷恢复不重跑，源码变化旧审批 409，再执行新尝试。持续失败归 run failed 并有明确错误，需求显示 blocked。
- 当前声明的指南可只读读取；未声明、管理路径、缺失和符号链接分别拒绝，文件访问边界不放宽。
- 最终 `npm test`：895 测试 / 67 文件通过；`npm run build:all`、`npm run typecheck` 与 `git diff --check` 通过。

## 真实 Codex 与 HTTP

隔离微型 git 仓库使用 Codex CLI 0.160.0 headless，新建需求并启动 Goal。目标是将 add(a,b) 的减法实现修复为数字加法，保留现有正数、负数、零的测试与 package.json。

实际结果：

- worker 调用 1 次，只修改 src/add.js；测试和 package.json 没有变更。
- 宿主实际运行 Node --test，3 用例通过、退出码 0；source_hash 绑定 src、tests 和 package.json。
- review.md 提供变更文件/符号、验收用例与限制，宿主附实际 argv、退出码、耗时、输出 hash 和事件 ID。
- Goal ready 后直接等待最终人工 gate；中途人工决定 0、节点未退出、未合入或发布。
- 同 run 重启后审批 ID 保持，没有重复 worker；重建投影后的 session doctor=true。

临时证据位于 `/tmp/cord-stage42-real-result.json` 与 `/tmp/cord-stage42-browser-result.json`，原始模型正文与截图不提交。预览操作路径：需求 REQ-GOAL-REAL → 文档 → review.md；人工审批仍未决。

## 浏览器验证与发现

第一次浏览器核验发现自定义 review.md 虽在磁盘上生成，控制台仅列固定四份快照。已补齐 server 当前 SDLC artifact 投影与受控只读接口；文档页复用原文与 Markdown 预览，保存保持禁用，来源导航使用完整声明路径。

Chrome/Playwright 在 1440、390、320 宽度验证指南的变更/验收/风险及宿主证据、保存禁用与最终人审可见；页面无横向溢出、pageerror=0。桌面和 320 截图已查看，未见文字覆盖或控件重叠。

## 范围限制与下一步

- 实际模型样本是微型功能冒烟，不能外推复杂目标成功率或“大多数是 happy path”；自动修复路径由离线真子进程明确验证。
- 指南目前核验结构与实际宿主证据；完整业务验收覆盖和异构独立语义审查仍需增强。
- 检查脚本、依赖与环境仍是工作区信任边界，源码摘要不等于恶意 worker 防篡改。原输出不持久化，事件元信息是当前证据定位。
- 卡点以 run failed、failure_kind 与原因留痕，尚无完整的结构化人工答复续跑；独立协调尚未自主监督 Goal。总时长/次数已可执行，费用/token 预算未实现。
- ACP 权限策略不因 Goal 改变；最终 review、合入和关键 gate 仍人工。持续优化目标保持 active。

阶段 43 补充：Context Session Agent 从当前事件流投影 Goal 状态。blocked/invalid/cancelled Goal 不能继续 advance，可引用当前 Goal event_id 生成 ask_human/wait Draft；原始日志和命令输出不进入 prompt。该观察不自动创建轮次、不自动发送问题、不扩充预算，人工仍通过既有澄清和 gate 入口决定。
