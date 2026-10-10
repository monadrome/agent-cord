# ADR-0075 ｜ ACP 启动选择与 session 配置一致性

- 状态：accepted
- 日期：2026-10-10
- 关联：ADR-0073（严格启动）、ADR-0074（能力观察）、ADR-0055（宿主 Goal）

## 背景

现有驱动核验 session/set_config_option 回执，但 config_option_update/current_mode_update 仅作为 metadata，后续选项漂移不会使任务失败。launch.mode 只支持旧 set_mode，即使 agent 仅提供新 configOptions 也无法启动。设置模式后改变模型默认值或选项列表，驱动还沿用 new/load 的旧状态。

ACP 配置选项协议要求设置响应/更新提供完整当前状态，category 仅用于 UX；当新旧接口同时存在时应优先 configOptions。旧 set_mode 的成功回执没有 currentModeId，不能发明必需通知或声称独立验证其内部实际状态。

## 决策

1. `launch.option_ids.mode` 显式映射 mode 到 select 选项，使用 set_config_option 和最终完整回执；模式 ID 不依赖 category。无映射时保持旧 modes/set_mode 通道，空成功回执为协议确认，已有对应 current_mode_update 若矛盾则拒绝。
2. 每次执行独立维护 session mode/config 的最新结构化状态，使用 new/load、设置回执和当前 session 的更新。无 category/grouped/boolean 均遵循精确 ID/允许值；重复 ID/值、缺失已选选项、类型改变或不能重算时 fail-closed。来自外部 session 的更新不改当前状态。
3. 启动设置阶段可改变尚待设置的默认值，最终必须所有显式选择一致。进入 prompt 后，任何显式模型/effort/mode/扩展值漂移立即记录不可重试 configuration error、取消并收束；同值更新合法。模型正常自适应的未显式选项不冻结。观察到矛盾不可被后续恢复或成功 result 擦除，任务不能形成 Goal ready 或写回成功产物。
4. readonly 拒绝扩展配置和非 plan 的显式 mode，已有宿主只读工具审计/权限/最终 gate 保持原边界；协议状态一致不等价于 OS 隔离或业务正确。
5. 有 mode 选项映射时采用新 ACP 配置身份域，并绑定版本化 session 状态核验策略，原 v4 启动选择也因执行契约增强而变更身份，冷恢复保守重验。未声明 launch 的旧 ACP 默认配置兼容。

设置顺序确定为 mode 映射、按 ID 排序的扩展、model、effort；每步使用当时完整选项，不预先用 plan 模式的初始候选拒绝 code 模式模型。配置键序不影响有效身份或实际调用顺序。

## 验证

离线真实子进程覆盖 config-only mode、legacy 空回执、模式更新改变选项、启动前/执行中漂移、同值/外部 session 更新、重复结构、设置异常与原生 resume。server/Goal/独立协调覆盖无成功写回/不重复无效配置/不形成 ready、修复配置后新执行及人工终审保持。

异步通知可能在 prompt 已发出后才被宿主观察；此时保证立即取消、拒绝成功交付，不能保证未发生模型消耗或副作用。既有 OS/文件预授权与宿主源码/验证控制仍必需。协议回执和状态更新不能证明实际底层模型调用，未观察到的漂移也无法由本层推断。
