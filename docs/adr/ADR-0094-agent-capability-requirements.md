# ADR-0094 ｜ Workflow Agent能力准入

- 状态：accepted（已实现并验证）
- 日期：2026-10-11
- 关联：ADR-0073（能力识别）、ADR-0081（只读映射）、ADR-0092（stdin输入）、ADR-0093（工作区隔离）

## 决策

workflow 节点的 `run` 增加可选严格 `require_capabilities`，可要求 `transport`、`prompt_input`、`native_resume`、`workspace_isolation`、`readonly_launch`、`readonly_resume`。字段至少声明一项，值必须是公开能力枚举；未知或缺失能力均 fail-closed。

同一准入函数用于四个位置：Context Session Agent 的 eligible_nodes、NodeRunner 实际派发、未退出 checkpoint 复用和发布后的协调输入。能力不满足时只能提出 wait/ask_human，不能调用 driver、代写产物、形成 Goal ready 或复用旧完成。节点缺省字段保持兼容；声明进入 workflow/input identity，因此修改要求会使旧提议/完成重新核验。

该字段控制宿主准入，不安装/探测 agent，不改变 Agent configuration_hash，也不把静态能力声明变成模型权限、worktree 或 OS sandbox 证明。`require_readonly_mapping` 保留作为专用兼容字段，通用要求与它同时满足。

## 验证

覆盖 stdin/argv、ACP/headless、native resume、shared_lease和readonly映射的匹配/缺失/冲突，断言协调只能wait、派发零调用、checkpoint不复用；合法能力仍可执行。发布 schema、能力快照、实际 TCP Goal/最新PRD/cold与人工gate沿用现有边界。最终定向31项、全量1600项/116文件、typecheck/build:all/diff通过。人审指南见 [能力准入研究](../research/2026-10-10-agent-capability-requirements.md)。
