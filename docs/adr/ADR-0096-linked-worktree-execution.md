# ADR-0096 ｜ 独立Git工作树与Agent执行身份

- 状态：accepted（原型已实现并验证）
- 日期：2026-10-11
- 关联：ADR-0093（隔离能力）、ADR-0094（能力准入）、ADR-0070（workspace lease）
- 来源：默认Goal交付和原子启动控制要求；当前共享工作区实现审查

## 背景

当前server把需求事件、worker cwd、源码扫描、宿主验证和review产物绑定到同一root，只提供共享lease。直接给单个worker换cwd会让宿主检查仍读旧源码、指南落到另一目录，破坏Goal就绪和恢复证据。独立worktree必须让整个工作单元拥有一致的root。

## 备选方案

1. 仅把能力枚举改为worktree。
2. 为每个节点临时换cwd，沿用原server的session与验证目录。
3. 提供显式linked worktree创建；每个工作树运行独立server/root，同树内仍使用原lease，实际绑定后再公开worktree能力。

## 决策

采用方案3作为可用原型。`cord worktree <path> [--base <ref>]`解析固定commit，创建detached linked worktree，不创建/切换主工作树分支。缺省HEAD要求源工作树干净；有未提交改动时需显式base，明确只检出所选commit，不复制当前dirty/ignored文件、旧事件流、依赖目录或凭据。目标必须不存在且在源工作树和Git公共元数据之外，禁止force。禁用本次Git checkout hooks/子模块递归；Git环境中的路径覆盖不参与操作。创建结果不确认时保留现场，不自动删除/重放。

server在实际linked worktree根启动时，AgentService读取Git的toplevel/git-dir/common-dir、worktree登记与gitdir反向引用，确认独立工作树后包装现有driver。包装层公开workspace_isolation=worktree，执行身份包含底层配置、规范root/metadata路径与目录dev/ino摘要；新任务和原生resume在底层agent启动前及完整流结束后重检cwd与工作树身份，取消任务零查询/派发，漂移为不可重试configuration错误。宿主源码/验证/人审输入和协调来源也重检绑定，重载不能替换当前工作树身份。普通主工作树、非Git目录、子模块保持原shared_lease；不能从YAML单方面声明更强隔离。

同一工作树内的worker、只读评审、独立协调、源码/verification、审批和冷恢复沿用当前root与事件协议。多个工作树有独立源码、session和lease，可以并行运行不同工作单元；本次不迁移正在运行的需求、不复制授权/预算、不自动合入或删除工作树。底层CLI帮助/ACP查询仍使用原实现，返回包装后的能力与配置身份。

## 理由（第一性原理推导）

隔离工作单元首先要保证执行、验证和产物针对同一份代码。现有server-root边界已经覆盖这些职责，可以复用它形成实际工作树隔离；仅调整worker的cwd不能证明结果。能力准入必须消费真实执行路径，工作树身份也须进入恢复与协调的新鲜度约束。

## 被否方案的否决理由（逐一）

- 方案1只有声明，没有实际独立文件树。
- 方案2将执行输入与验证输入分离，会把旧主目录的测试结果当成工作树的结果。
- 自动复制dirty文件、凭据、旧session或自动清理失败工作树增加未知输入和副作用；原型选择显式commit与保留现场。

## 关键实现注意点

1. 使用argv Git API，ref先解析为commit，再用于worktree add；目标存在/路径别名/非法参数先拒绝，不执行shell。
2. linked worktree共享Git公共元数据，不能声称OS、网络、权限或恶意进程隔离；验证器仍与worker共享可写工作树。只比较路径不足以拒绝目录替换，需核验登记、反向引用和目录身份；并不提供跨进程原子目录事务。
3. 依赖须在工作树内准备，不共享node_modules可写目录；不自动运行安装命令或额外模型调用。
4. 不给普通主工作树driver增加配置身份字段，旧配置保持兼容。查询与执行绑定当前实际工作树；工作树被替换时拒绝，不自动换到主目录。
5. 全部协议事实仍经events.append，workspace创建属于环境准备，不是SDLC推进/授权事件。
6. base含已跟踪的需求session、索引或SDLC管理数据时，创建前拒绝隐式复制旧授权；允许cord.toml、agents.yaml与knowledge文件，已有需求迁移另行设计。HEAD与源码变更沿用实际source/context身份，不要求worker提交代码；物理目录替换使旧配置失效。

## 证据来源

本机Git 2.50.1的worktree add帮助确认detach/checkout语义。实现前核对RunService、NodeRunner、Goal、verification-inputs与AgentService；21项真实Git/CLI/绑定回归、5项ACP/headless实际TCP通过，完整1663项/119文件、typecheck/build:all/diff通过。双工作树隔离预览审批各1/人工决定0/节点退出0/doctor=true，三视口6截图通过；来源与限制见[Human Review指南](../research/2026-10-11-linked-worktree-execution.md)。
