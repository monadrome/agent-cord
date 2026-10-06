# ADR-0024 ｜ checker 参数化：checks[].with 与参数化内置 checker

- 状态：accepted（设计定稿，原型已实现）
- 日期：2026-10-06
- 关联：ADR-0014（三级校验器——本 ADR 扩展 L1 内置档的表达力，不引入 L2 CEL / L3 插件）、ADR-0018（DSL 内核实现）、ADR-0022（SDLC 定制模型）
- 来源：可插拔 SDLC 差距分析（2026-10-06）：自定义 SDLC 可用的 checker 积木只有 3 个无参内置，表达力≈换节点顺序

## 背景

ADR-0014 定了三级校验器：L1 内置枚举 / L2 CEL / L3 外部插件。当前实现只有 L1 的 3 个 checker（`anchors-present` / `ledger-has-confirmed` / `vote-confirmed`），且 `checks` 项只有 `ref` 一个字段（`schema.ts`：`z.array(z.object({ ref }))`）——checker 无法从 YAML 接收参数。后果：自定义 SDLC 连「要求 plan.md 存在且非空」这种最基本的门禁都表达不了（`anchors-present` 只看锚点数组，不看文件）；每个新校验诉求都要等 L2/L3 落地，而那是协议级工作。

## 备选方案

1. **直接加速 L2 CEL**：CEL 表达力全覆盖参数化需求。但 CEL 求值器是单维护者库（ADR-0018 已识别为最大单点依赖风险之一），端口隔离 + 一致性回归测试是数天级工作，而「文件存在/含某小节/锚点数量」这类高频诉求用 CEL 属于杀鸡用牛刀。
2. **checks[].with 参数化（选定）**：`checks` 项增加可选 `with: Record<string, unknown>`，经 `CheckerContext.params` 传给 checker；同时扩充参数化内置 checker 家族。不改三级结构，CEL/插件路线不受影响。
3. **checker 名内嵌参数**（如 `file-exists:plan.md`）：零 schema 变更，但参数无类型无校验、字符串解析约定自定，容易劣化成微语法。

## 决策

1. **schema 扩展**：`checks: [{ ref: string, with?: Record<string, unknown> }]`。`with` 原样传入 `CheckerContext.params`；checker 自行用 zod 校验参数，**参数非法一律 block（fail-closed），不静默用缺省值猜**。
2. **新增 5 个参数化内置 checker**（全部只读、确定性、fail-closed）：
   - `file-exists { path }`：session 目录内文件存在（path 禁止跳出 session 目录）；
   - `file-nonempty { path, min_bytes? }`：存在且非占位内容（去空白后长度 ≥ min_bytes，默认 1）；
   - `doc-has-section { path, heading }`：Markdown 含指定标题（`#` 前缀匹配，大小写不敏感）；
   - `anchors-min-count { min }`：证据锚点数量下限（`anchors-present` 的参数化泛化）；
   - `event-emitted { type, within_node? }`：事件流中出现过某类型事件（如 `agent.task.completed`），可选限定当前节点。
3. **L2 CEL / L3 插件路线不变**：参数化内置只覆盖「读快照/事件流的确定性判定」；条件表达式仍属 CEL，外部系统交互仍属插件。内置家族新增成员走本 ADR 注意点清单评审，不另立 ADR。
4. **schema 演进合规**：`with` 是 v1alpha1 内非破坏性字段新增（ADR-0014 注意点 4：非破坏性变更走 v1 内字段新增）；旧定义无 `with` 行为不变。

## 理由（第一性原理推导）

1. **从「校验逻辑高频多变」（ADR-0014 背景约束 4）反推**：L1 档的价值是覆盖高频确定性判定；3 个无参 checker 的覆盖面约等于零。参数化让 L1 从「枚举具体判定」升级为「枚举判定种类」，覆盖面随参数空间展开而不是随代码行数。
2. **从「fail-closed」反推**：参数错误的处理只有两条路——block 或猜缺省。猜缺省意味着「配错的 gate 静默放行到错误语义」，违反无证据不入账精神；block 把配置错误显形为可审计的门禁拦截。
3. **从「表达力缺口怎么补最省」（ADR-0014 理由 4）反推**：CEL 填的是「轻量条件」档，但引入它的固定成本（求值器端口 + 一致性回归）与本次要解决的诉求（文件/事件/锚点的确定性判定）不成比例；先把 L1 参数化做厚，CEL 留给真正的条件表达式诉求。
4. **安全边界**：`with.path` 一律限制在 session 目录内（resolve 后必须仍在目录下），防 `../../etc` 越界读——checker 是只读的，但只读也有信息泄漏面。

## 被否方案的否决理由（逐一）

- **直接加速 L2 CEL**：固定成本与诉求不成比例；单点依赖风险（ADR-0018）不应为「文件存在」级诉求买单。CEL 路线保留。
- **checker 名内嵌参数**：无类型、无校验、自造微语法，正是 ADR-0014 否决「YAML 内嵌脚本」的同款劣化路径的袖珍版。
- **with 参数非法时用缺省值**：静默改变门禁语义，违反 fail-closed。

## 关键实现注意点

1. `CheckerContext.params` 缺省 `{}`；未声明 `with` 的 check 行为与 M2 完全一致（向后兼容）。
2. path 参数统一经「resolve + 前缀校验」后才允许读盘；符号链接不特殊处理（session 目录是工作区内部资产）。
3. `event-emitted` 通过 `ctx.session.events` 读事件流；无 session（跨进程调用）时退回读 `<session_dir>/events.jsonl`。
4. 新增内置 checker 的准入清单：只读、确定性（同输入同结论）、参数 zod 校验、失败原因文案可定位配置错误。
5. SDLC validate 复用 `findUnknownCheckers`，参数合法性不在 validate 期静态校验（参数 schema 归各 checker 自治，运行期 fail-closed 已兜底）。

## 证据来源

1. 可插拔 SDLC 差距分析（2026-10-06，会话内）：内置 checker 仅 3 个且无参数通道，`checks` schema 冻结在 `{ref}`。
2. ADR-0014（三级校验器分工与「表达力缺口怎么补最省」推导）、ADR-0018 注意点 2/3（CEL 依赖风险与可信性分级）。
