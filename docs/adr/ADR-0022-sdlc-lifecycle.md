# ADR-0022 ｜ SDLC 定制模型：版本生命周期与运行实例绑定

- 状态：accepted（设计定稿，MVP 已实现 validate/publish 与版本绑定；图形编辑器后置）
- 日期：2026-09-24
- 关联：ADR-0014（工作流/门禁 DSL）、ADR-0018（DSL 内核实现）、ADR-0021（server 分层与派生索引）
- 来源：[docs/proposal-console-platform.md](../proposal-console-platform.md) §5/§6（默认 SDLC、定制模型）

## 背景

控制台方案要求「不改代码即可定制 SDLC」。但 M2 的 `WorkflowDefSchema`（`agent-cord.dev/v1alpha1`，kind=Workflow）已是冻结契约，修改须经 ADR；而方案草案中的 `agent-cord.dev/sdlc/v1alpha1` 示例与现有 gate 形状（`attach.node`、`role`、`pass` 结构）不一致。需要拍板：SDLC 是不是新 schema、版本怎么存、运行实例怎么绑定、允许定制什么。

## 备选方案

1. **新建 `sdlc/v1alpha1` schema**：产品语义干净，但与 WorkflowDef 双 schema 并存，执行器要适配两套；
2. **SDLC = WorkflowDef 的产品化封装**：不新增事件/schema 契约，SDLC 版本文件内容就是 `WorkflowDef` YAML，server 在其上加生命周期与版本目录；
3. **SDLC 定义入库（SQLite）**：省目录管理，但违反「定义可 git 版本化、可文本 diff 人审」。

## 决策

1. **SDLC 定义 = 现有 `WorkflowDef`（`agent-cord.dev/v1alpha1`, kind=Workflow）**，不新增 schema。`sdlc/v1alpha1` 作为后续独立 packaging（角色、审批人、上下文包等扩展字段）预留，MVP 不引入。
2. **版本化存储为文件**：`cord/.sdlc/<sdlc_id>/draft.yaml`（草稿，可改）与 `cord/.sdlc/<sdlc_id>/v<N>.yaml`（已发布，不可原地修改）；`v<N>.yaml` 头部注释记录发布时内容哈希与发布时间。文件进 git，可 diff、可人审。
3. **生命周期**：`draft → validated → published → archived`。validate = schema 校验 + 引用完整性 + 拓扑无环 + checker 引用可解析（全部复用 `parseWorkflow/topologicalOrder/findUnknownCheckers`），不产生文件副作用；publish = 先 validate，再递增版本号写 `v<N>.yaml`；archive 标记版本停用（不改变文件内容，登记于索引）。
4. **运行绑定**：启动 run 时绑定具体 `{ sdlc_id, sdlc_version }` 并登记进 runs 索引；后续版本变更不影响在途/历史 run。默认 SDLC（`simple-sdlc` v1：`intake → align → plan → implement → verify → review → done`，含 anchors-present 证据 gate 与 review 人工确认点）随 server 启动幂等物化，开箱可跑。
5. **禁止项**（validate 期拒绝）：无 gate 的流程（至少一个证据 gate）、checks 为空、checker 引用不可解析、节点依赖成环。任意脚本/shell 不在 DSL 表达力内（`checks.ref` 只能引用注册表中的 checker 名），天然不可注入。
6. **UI 产物**：console 的 SDLC 编辑以表单/YAML 文本生成上述文件内容，不允许任意脚本；图形 DAG 编辑器后置（M3）。

## 理由（第一性原理推导）

1. **从「契约只有一份」反推**：双 schema 意味着执行器/校验器/前端各维护两份映射，漂移只是时间问题；WorkflowDef 的表达力已覆盖方案默认 SDLC 的节点/依赖/gate/人工确认需求。
2. **从「定义是人审资产」反推**：SDLC 变更是低频高影响操作，必须能 git diff 评审——文件存储是满足这一点的最便宜形态，也顺带满足「发布版本不可原地修改」（改已发布文件会在 git 中显形）。
3. **从「fail-closed」反推**：定制能力的边界 = DSL 的表达力边界。DSL 不支持任意命令，则 UI 定制天然无法引入脚本执行入口，不需要额外的运行时沙箱。

## 被否方案的否决理由（逐一）

- **sdlc/v1alpha1 新 schema**：否决（现阶段）——与 WorkflowDef 双份契约、执行器双适配，收益只有命名语义；待出现 WorkflowDef 表达不了的字段（角色绑定、上下文包）时再立新 ADR 扩展。
- **SDLC 入库**：否决——违反「人审资产进 git」与「数据库只存派生索引」（ADR-0021 决策 3）。

## 关键实现注意点

1. 发布版本号按目录内已有 `v<N>.yaml` 递增，不重用已归档版本号。
2. validate 返回结构化 issues（带字段路径）与内容哈希，供 UI 展示与发布前确认。
3. 默认 SDLC 的 review 节点 gate 为 `pass.human_confirm: true` + `on_fail: escalate`，保证至少一个人工确认点（方案 §5 硬性要求）。
4. 归档/迁移事件类型（`sdlc.*`）待引入时再走 schema 变更 + ADR 流程，MVP 只用索引登记。

## 证据来源

- [docs/proposal-console-platform.md](../proposal-console-platform.md) §5/§6/§9 Phase 3
- ADR-0014（三级校验器、双注册表）、ADR-0018（加载期校验与拓扑无环）
