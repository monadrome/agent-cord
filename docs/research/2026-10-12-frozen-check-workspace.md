# 冻结源码检查：调研与 Human Review 指南

## 实现前调研

现有 verification-inputs 扫描器已经记录规范路径、类型、权限、内容 hash，并重检目录清单和文件元信息；source_manifest_hash 使用同一 cord.verification-source.v1。复用它能够避免复制范围与当前验证身份分叉。现有宿主检查有每命令 scratch、原生只读沙箱、进程组取消和可信 IPC，可以在同一执行边界增加副本 cwd。独立验证资产仍沿用已发布 pin。

选择显式 frozen_inputs，保留原部署兼容。仅复制声明源码，缺依赖由配置者明确补齐，不通过自动挂载可写目录让测试侥幸成功。将副本放入可写 scratch 后必须另加整树 denyWrite，仅文件 chmod 不足以阻止目录改名、chmod 或硬链接绕过。

## 配置

```yaml
goal:
  inputs: [src, package.json]
  check_sandbox: readonly_workspace
  check_workspace: frozen_inputs
  checks:
    - id: business
      bin: /absolute/system/node
      args: ['{{check_assets}}/verify.cjs']
      assets:
        root: /absolute/trusted/acceptance
        files:
          - {file: verify.cjs, content_hash: '<published-sha256>'}
```

绝对路径和hash需换成已安装解释器、独立资产目录与实际发布的原始字节SHA-256后校验/发布。assets可选；未固定的工作区检查程序不自动成为可信验收。review_changes独立控制宿主变更基线，可以缺省或false。需要动态生成文件的检查只能写私有HOME/TMPDIR，不能写冻结cwd；依赖、配置与普通源码文件必须明确进入inputs，缓存与管理目录仍排除，不自动读取原工作区。

## 人工检查路径

1. 在 Goal 配置同时声明 `check_workspace: frozen_inputs` 与 `check_sandbox: readonly_workspace`，检查 bin 使用工作区外绝对解释器。
2. inputs 明确列出源码与所需普通依赖文件/目录；node_modules、dist、Git、cord 仍排除。独立验收程序继续用 assets 文件 pin。
3. 查看宿主指南的被测 source_hash、冻结模式、命令与事件引用；业务失败应自动修复并再次检查，准备故障停止并留下证据。
4. Goal→只读评审后冷恢复不重复已验证 worker；最终审批仍人工未决。原源码新增/删除/内容/模式漂移必须拒绝旧证据。

实现定位：[共享扫描与副本](../../src/workflow/verification-source.ts)、[实际执行](../../src/workflow/host-verification.ts)、[沙箱政策](../../src/workflow/sandbox-check-helper.ts)、[Goal](../../src/coordinator/goal.ts)、[ready来源](../../src/coordinator/goal-evidence.ts)、[当前输入](../../apps/server/src/services/run-service.ts)、[ADR-0103](../adr/ADR-0103-frozen-check-workspace.md)。

```bash
npx vitest run tests/workflow/frozen-check-workspace.test.ts apps/server/tests/check-assets.test.ts
npm test
npm run typecheck
npm run build:all
git diff --check
```

## 验证记录与限制

25项新增物理/真实OS反例与3项冻结TCP通过：原字节、mode、空目录/必要父目录、范围排除、目录新增/删除、链接/硬链接/超限、复制中漂移；真实检查拒绝副本write/chmod/rename/alias与原cwd读取。原文件在检查执行期间被宿主修改，检查仍读原字节，后验拒绝passed。准备阶段timeout/cancel/IO零检查派发并清理部分副本；执行阶段timeout/cancel回收父子进程和冻结树。无assets也不允许从原可写工作区加载解释器。

两协议实际TCP与隔离预览均首次failed、业务自主修复后passed，未声明文件不可读、原文件读取/副本写被拒绝；review_changes=false仍完成冻结，指南带实测source_hash/模式/命令事件。旧实时hash不能满足冻结ready，Goal→只读评审后cold零重复worker，原run/审批保留，源码漂移使旧审批409/当前协调失效且不重授预算。各审批1/人工决定0/仅deliver退出、当前Goal/协调/doctor=true。首次预览doctor因协调后磁盘投影未刷新失败，按既有ledger读取API刷新后通过，未改事实或检查结果。

最终全量1897项/131文件、typecheck/build:all/diff、本地文档链接、编译入口实际OS执行/清理、pack207文件入口和18张三视口截图通过。临时证据为`/tmp/cord-stage93-tests.json`、`/tmp/cord-stage93-real-result.json`与`/tmp/cord-stage93-browser-result.json`，不入Git。当前只读查看路径：headless `http://127.0.0.1:55733/#/requirements/REQ-FROZEN-DELIVERY/approvals`；ACP `http://127.0.0.1:55747/#/requirements/REQ-FROZEN-DELIVERY/approvals`。文档tab的review.md可查看完整宿主证据。

冻结源码不等于可信工具链或业务覆盖，也不隔离待测代码与同进程验证器；系统安装/同OS用户仍为受信边界，Linux与真实厂商尚未实际验收。每节点worktree自动分配待后续推进。本轮付费模型0、不操作7306上的原真实 Draft、不自动合入或通过关键 gate。
