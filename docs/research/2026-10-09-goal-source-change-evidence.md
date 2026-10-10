# Goal 宿主源码变更证据

日期：2026-10-09

## 结论

自测通过和 review 指南有“变更”章节，仍不足以证明变更定位完整。复用现有安全源码扫描，以首次实际输入为基线生成新增/修改/删除清单，可以让 reviewer 从宿主证据找到实际路径，并避免把用户原有未提交代码误归因。

`review_changes: true` 在推荐 Goal 模板/示例默认开启；旧发布流程保持原语义。首次 started 保存有界 manifest，ready 保存完整 delta 与基线 event 引用。恢复、协调、post 人审共用重算，缺失、漏项、错引用或伪造清单不能作为就绪交付。

## Human Review 指南

先看 `src/coordinator/goal-changes.ts` 的纯计算和重算，再看 `goal.ts` 的首次基线落盘及指南写回。修复尝试不能把 broken 版本重新作为初始源码；首次已有未提交内容属于基线，宿主只报告其后发生的变化。`goal-evidence.ts` 必须从首条合法 started 应用 delta，重算到实际宿主验证的 source_hash。

源码路径/kind/mode/content_hash 来自 `apps/server/src/services/verification-inputs.ts` 的同一次安全扫描，旧 source_hash 域保持不变。manifest 不含正文，常规验证 context REST 不返回全清单。源清单和 delta 各限制 10,000 项及 1,000,000 序列化字符，不生成部分清单；推荐流程范围过大时明确阻断。

验证入口：`tests/coordinator/goal-changes.test.ts`、`goal.test.ts`、`goal-evidence.test.ts`，以及 server 的 `goal-delivery.test.ts` 与 `verification-inputs.test.ts`。覆盖增删/权限/类型/空变更、自动修复/中断恢复、缺 hook、bad baseline/漏项、伪造人审、ACP/headless 真子进程、冷审批保留和旧契约兼容。真实模型与原真实待审 Draft 未操作。

实际操作路径：启动 Goal 后，在需求“文档”页选择 `review.md`，找到“宿主源码变更”；表格显示声明范围内的路径、状态和前后身份，基线事件可在事件页复核。最终人审始终由人决定。隔离预览与截图证据位于 `/tmp/cord-stage57-preview-result.json` 和 `/tmp/cord-stage57-browser-result.json`。

表内文件摘要展示前 12 位，避免移动端每个文件占用多行 hash；完整元信息保存在基线/ready 事件且仍全量参与重算，指南的整体 source_hash 也保持完整。

2026-10-10 完整验证：1156 项 / 80 文件离线测试、typecheck/build:all/diff、180 本地文档链接通过。Playwright 1440/390/320 视口三行四列清单、来源 event_id、无横向溢出/单元格溢出及 pageerror 已验证，桌面/手机截图已检查。隔离 Goal worker 两次自主修复后就绪，审批 1、人工决定 0、节点退出 0、doctor=true，预览 `http://127.0.0.1:53563/#/requirements/REQ-GOAL-CHANGES/docs` 可查看。

## 限制

清单只证明声明范围内前后观察，不证明仓库所有变更属于当前 worker、测试充分性、业务验收或外部副作用。删除后又恢复原字节属于相对基线无变化，不宣称记录了中间每次编辑；rename 表示删除+新增。扫描/事件来源仍依赖受信宿主，不构成恶意 worker 抗篡改或跨进程原子文件树证明。
