# 固定验证资产调研与实现前边界

关联：[ADR-0102](../adr/ADR-0102-pinned-verification-assets.md)、[宿主检查沙箱](./2026-10-12-sandboxed-host-checks.md)。

当前host-verification只把命令定义纳入command_hash，Goal.inputs记录被测源码但不区分实现者能改的测试。readonly_workspace保护验证过程中源码不可写，却仍读取Worker之前可改的脚本。ready/human/coordination已共用输入与完整来源，适合增加可显式声明的资产pin核验，不新增状态机或自动授权。

选独立绝对资产根与文件内容pin，命令明确定位到本次只读副本，复用原Sandbox Runtime、可信退出IPC、输出hash与Guide。带pin检查必须严格模式；原工程检查保持旧语义，不能因注册或模型回复而宣称验证器可信。资产当前状态核验接入RunService.readNodeInput，使冷恢复、人审和协调读取同一pin。

## 配置与行为

```yaml
goal:
  inputs: [src, package.json]
  check_sandbox: readonly_workspace
  checks:
    - id: contract-test
      bin: /absolute/system/node
      args: ['{{check_assets}}/verify.cjs']
      assets:
        root: /absolute/trusted/acceptance
        files:
          - {file: verify.cjs, content_hash: '<published-sha256>'}
          - {file: cases.json, content_hash: '<published-sha256>'}
```

片段中的绝对路径和hash必须由配置者替换为实际值，再校验/发布。文件hash用完整原始字节SHA-256，资产root需要在工作区/Git之外；当前内容变化不会被自动认证为新pin。解释器也需绝对路径并在可写工作区/Git/原资产目录之外，不从工作区PATH加载。运行时/系统工具仍是可信部署责任。

`{{check_assets}}`必须是独立参数，或者整个参数为`{{check_assets}}/<清单内文件>`，不允许嵌入shell正文/flag或未声明路径；支持脚本自己的相对导入，依赖文件也须声明pin。宿主检查保持原cwd以读取被测源码。每检查复制发布字节，文件0400/目录0500并由OS denyWrite，原资产目录denyRead，不依赖chmod单独提供隔离。真实控制回执和进程退出仍与stdout分开。

单文件16MiB、总64MiB、最多128项，链接/硬链接/特殊文件、工作区重叠、读取前后元信息变化或pin失配均拒绝；封存前整组重读当前文件。副本字节不入事件/IPC，GUIDE列出发布文件pin/资产摘要和实际验证事件ID。验证器尝试修改副本、源码或访问事实/网络均被原严格检查沙箱限制。调用收束后宿主解除自己设置的目录模式并清理。

新command_hash v3绑定资产pin与固定政策，旧无assets hash域保持。Goal输入、完成复用/ready、人审、冷恢复和当前协调重新核验同一资产；带pin的未知/漂移不冒称当前ready。验证资产错失不能作为普通业务失败要求worker改测试，自测真实业务失败仍在原预算内修复。未处理自身Goal审批的资产不可用会保留等待，原pin还原后可重检；跨节点goal-ready可能机器阻断，不因文件还原自动回滚/授预算。

## Human Review

1. 查看[check-assets](../../src/workflow/check-assets.ts)和[ADR-0102](../adr/ADR-0102-pinned-verification-assets.md)：发布hash、外部路径归属、独立普通文件、有界字节、整组重读与只读副本。
2. 查看[host-verification](../../src/workflow/host-verification.ts)、[helper](../../src/workflow/sandbox-check-helper.ts)：带pin严格模式，解释器位于可信边界，定位参数只映射本次副本，denyRead原资产/denyWrite副本，真实退出/IPC/清理不因输出假成功放行。
3. 查看[Goal](../../src/coordinator/goal.ts)和[RunService](../../apps/server/src/services/run-service.ts)：每次尝试及库复用核验当前pin，原发布预算/状态机保持，指南和当前人审/恢复/协调共用来源。外部资产hash不代替实际测试成功。
4. 以隔离workspace运行：首次代码不满足验收，同时把本地test改为exit0；可信检查仍应真实failed，修复业务后passed。持续只改测试应预算止步，零最终人工审批。
5. 验证review.md包含固定文件/hash、资产摘要和实际命令事件；改外部资产后旧审批409，当前协调/Goal不可冒称ready；冷恢复不能重授预算或重建pin。未经人决定不合入、不发布、不通过关键gate。

```bash
npx vitest run tests/workflow/check-assets.test.ts apps/server/tests/check-assets.test.ts
npm test
npm run build
npm run typecheck
npm run build:all
git diff --check
```

## 证据与限制

macOS真实OS反例验证：固定外部检查忽略已被改成exit0的本地测试，broken退出3、代码fixed后退出0；副本写/chmod/改名/硬链接写均拒绝，原资产不可读，字面参数保持，临时目录清理。两协议TCP真实worker尝试修改外部pin文件被OS拒绝；Guide/ready/current协调/cold/最终人工一致，持续只改测试不ready，启动前pin漂移零worker/检查派发。

macOS真实OS反例还覆盖命令开始后外部资产替换：结果被标为failed而不是沿用旧副本通过；固定检查timeout/cancel清理父子进程与副本。两协议实际TCP覆盖本地tests改exit0仍failed、业务修复后passed、外部资产写入blocked、资产等待/cold漂移拒绝旧审批、当前协调与最终人工gate；最终全量1869项/130文件、308链接、编译入口和18截图通过。证据位于`/tmp/cord-stage92-real-result.json`与`/tmp/cord-stage92-browser-result.json`，不入Git。

这是显式字节pin和执行边界，不是所有项目测试自动可信。配置者仍需审查验收是否充分，脚本可以有意导入可写源码/依赖，被测代码在执行时可以影响同进程验证器；高风险场景还需隔离待测代码执行、冻结源码、可信依赖/工具链与更强宿主隔离。Linux真实验收和实际厂商兼容仍未完成，当前原生结果不能跨平台外推。
