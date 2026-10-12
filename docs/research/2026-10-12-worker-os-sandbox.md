# Worker OS 沙箱调研与实现边界

关联：[ADR-0100](../adr/ADR-0100-worker-os-sandbox.md)、[宿主检查沙箱](./2026-10-12-sandboxed-host-checks.md)。

## 实现前证据

- 当前 ACP/headless spawn 都继承 process.env；readonly 仅靠 CLI 映射和事后通知审计。worktree wrapper 会检查物理 root/Git 身份，却没有限制 OS 文件访问，且目前直接把隔离能力覆盖为 worktree。
- 已安装可选 Sandbox Runtime 0.0.79；已有宿主 helper 验证原生只读、默认网络拒绝、可信 IPC 和整组收束。Runtime 的 SandboxManager 为进程级状态，因此 worker 也必须使用独立 helper，不能在 server 内共享。
- 本地固定版本 schema 支持 allowedDomains 的精确域名/可选端口、strictAllowlist 和显式 IP 白名单；默认拒绝未知域名。启动封装使用 wrapWithSandboxArgv，直接 spawn argv，用户命令不交给宿主 shell 拼接。
- ACP SDK 由宿主处理 initialize/new/load/prompt、权限与配置回执，不能把宿主文件操作和网络凭据解析也误称为 child OS 沙箱覆盖。真实 agent 与其直接子进程受 OS 约束；宿主协议权限检查继续独立生效。
- Headless 要读完整流并核验退出；helper stdout 只转发正文，控制回执只通过未传给 agent 的 IPC。ACP 正常 end_turn 后原宿主会终止一次性 agent，不能直接套用“helper退出0”替代协议生命周期。

## 范围

可写实现允许本工作区，readonly 评审不允许改源码，二者禁止 cord/Git 访问。已有文本产物通道由宿主保存指南与报告，不扩大事实权限。额外 CLI 资产或认证文件必须明确只读授权；认证环境须明确列名，默认一次性 HOME，可显式启用按工作区/配置分区的持久状态以支持底层原生恢复。

初期使用默认无网络的离线 fixture 验证核心路径，再以本地真实代理/HTTP 白名单验证受限连接；不会仅凭静态能力或库 mock 宣称 OS 隔离已生效。Linux 环境及真实付费厂商兼容性仍需单独验收。

## 配置

```yaml
agents:
  implementer:
    kind: headless
    template: codex
    sandbox:
      kind: workspace
      allowed_domains: [api.openai.com:443]
      env_allowlist: [OPENAI_API_KEY]
      read_paths: [/absolute/trusted/cli-assets]
      state_dir: /absolute/private/worker-state
```

这只是配置形态，实际CLI安装资产、API域名及认证方式须按环境验证，不宣称该片段已调用厂商。ACP用相同sandbox配置，两种任务使用相同边界策略，readonly任务自动禁止源码写入。配置者只能明确增加只读路径，不能覆盖cord/Git禁令；目录改变或链接异常会失败。禁止继承HOME/TMP、加载器、proxy等覆盖；明确env缺值零派发，凭据值不进入公开能力/身份。allowed_domains为精确域名/可选端口，未声明不联网，未知域名不询问人而直接拒绝。

可信安装与可写源码不得重叠；从本项目源码目录启动server时，受限worker需绑定另一个工作树。持久状态根要求当前用户拥有、非group/other可写，自动创建HOME0700并按工作区/agent配置分区。无state_dir每调用临时HOME，原生resume若需要旧缓存会明确失败，不降级最近会话或新session。持久目录不会自动删除；OS限制不允许直接写cord产物，应在workflow使用`output:text`由宿主保存指南/报告。

## Human Review 路径

1. 查看[配置/准备与回执](../../src/driver/worker-sandbox.ts)、[可信helper](../../src/driver/worker-sandbox-helper.ts)和[ADR-0100](../adr/ADR-0100-worker-os-sandbox.md)：核验明确授权、可信安装、状态归属、IPC不传给agent、原预算与清理路径。
2. 查看ACP/headless调用准备与真实spawn、inspect和resume：helper未启动时不能发送ACP请求或接受结果，正文伪造成功不能覆盖Headless真实退出。无沙箱旧配置身份保持，开启后当前worker/协调/cold输入随策略改变。
3. 运行下列离线命令；macOS真实worker尝试源码、cord、Git、外部用户fixture和文件别名写入，网络用本地HTTP服务验证允许路径与未知拒绝，不依赖模型自报只读。
4. 在Agent页查看OS sandbox、策略、显式网络/env白名单与临时/持久状态；installation仍未核验。查询只协商协议/CLI帮助，不能证明模型权限/额度。
5. 隔离工作树运行Goal→readonly→最终review，第一次真实检查失败后自动修复，核验当前指南/报告与Goal证明。重启应保留原审批且不重跑worker；修改沙箱策略后旧审批409、原run阻断，不获得新Goal预算。

```bash
npx vitest run tests/driver/worker-sandbox.test.ts apps/server/tests/worker-sandbox.test.ts
npm test
npm run build
npm run typecheck
npm run build:all
git diff --check
```

## 实测与限制

macOS两协议可写源码/实际readonly、cord/Git/私有用户fixture/改名/硬链接/符号链接保护、环境名单/持久session、原生readonly恢复、取消/超时收束忽略SIGTERM的父子进程、缺runtime零裸执行、真实网络白名单与字面argv通过。runtime代理生成localhost但child禁止DNS，实测ENOTFOUND后用受限可信bootstrap规范IPv4地址，保留代理认证并继续由宿主proxy校验目标。CLI帮助仅为advertised证据，ACP握手不发送prompt。

最终全量1799项/126文件、root build/typecheck/build:all/diff、287本地链接与Agent示例解析通过；23项driver真实反例与5项TCP回归包含首次自测failed→passed的自主修复。编译后的driver也实际运行受限CLI帮助，npm pack --dry-run包含helper和配置模块。

实际隔离两棵Git工作树：headless `http://127.0.0.1:55968`、ACP `http://127.0.0.1:55984`，需求`REQ-OS-SANDBOX`。实现/修复2次、readonly评审与宿主指南保存成功；cold保持原run/审批零重复worker，最新报告改变旧协调且重新评审仅重做readonly，当前Goal/协调/doctor=true。审批各1、人工决定0，仅deliver退出，主树value.txt仍initial；付费模型0。Playwright1440/390/320共18张Agent/协调/审批截图与指南读取通过，无pageerror/横向溢出；桌面/320 Agent图实际查看，未操作原7306真实Draft。临时证据`/tmp/cord-stage90-real-result.json`、`/tmp/cord-stage90-browser-result.json`不入Git。

系统运行时允许读取/System、/Library、/usr、/bin、/sbin、/dev、/etc、/opt（Linux另含/lib、/proc、/sys）；这不是最小文件级可信资产集合。可写源码内的工具/测试脚本仍可被worker修改，持久HOME允许agent维护自身缓存；同OS用户宿主篡改、原子目录替换和冻结源码/可信验证资产未完成。子进程新建独立进程组或后台daemon仍需更强进程隔离，当前验证覆盖正常同组后代；Linux尚未实际验收。

沙箱禁止直接读取cord。后续[ADR-0101](../adr/ADR-0101-sandbox-input-documents.md)已增加按当前hash绑定的节点Worker全文只读副本，策略升级v2；原定位符由manifest映射到副本，不开放事实目录，独立协调仍只读已有有界包。可读取全文不证明模型实际看完。MCP配置的宿主凭据编译与远端服务副作用不属于child文件限制，原协议审批/工具审计继续独立生效。实际厂商CLI对私有HOME、代理及安装资源的兼容仍需有预算的独立验收。
