# 沙箱Worker全文输入与Human Review指南

关联：[ADR-0101](../adr/ADR-0101-sandbox-input-documents.md)、[Worker沙箱](./2026-10-12-worker-os-sandbox.md)、[节点输入范围](./2026-10-12-dependency-scoped-inputs.md)。

## 实现前判断

上下文包一直提供首尾片段和cord定位符，snapshot保存全文hash但不把全文放进prompt。Worker OS限制阻断了原定位符；仅知道完整hash不表示模型可以检查省略中段。需要给实际节点worker提供与同一hash绑定的完整读取路径，保留事件/账本/其他需求与自产输出边界。

独立Context Session Agent禁止所有工具通知，职责只消费有界宿主投影；本阶段不增加其工具或全文权限。文档副本让worker可读全文，不能据此声称模型已经逐篇读过。

## 当前行为

内置ACP/headless沙箱策略升级`workspace.srt-0.0.79.v2`，能力显示`input_documents=verified_copy`。NodeRunner根据本次readNodeSnapshot，排除自产artifact，构造严格AgentInputDocuments描述并传给driver。无scope绑定所有现有语义输入，声明dependencies时只选择PRD/上游/明确资料；copy能力不引入下游输入。策略进入原configuration_hash，旧沙箱checkpoint/Goal/审批需重检，未配置沙箱旧身份保持。

Driver先核验源session确属于当前workspace/cord/req_id，使用共享安全路径解析、no-follow独立描述符和有界读取，要求当前完整UTF-8文本hash与字符数一致，读取前后元信息一致。封存前再核验整组源文件，较早文档在较晚复制时变化也不能派发旧副本。最多128个文件、单文档16MiB、总64MiB；非法UTF-8、缺失、链接、硬链接、特殊文件、过期或超限均拒绝，不裸执行或回退旧prompt。

本次私有scratch/input-documents包含manifest.json及documents/<file>；副本/清单0400，目录0500，原生沙箱额外denyWrite整棵副本树，改名、chmod和硬链接写绕过实际被拒绝。原cord/Git仍不可读写。副本正文不进入IPC/事件，描述与manifest仅保存文件名/hash/字符数；临时副本在调用结束、取消/timeout/准备失败时清理，不写持久HOME。

NodeRunner为实际根路径指令预留4096字符，driver追加结构化`input_documents_root`和manifest路径，最后复核原max_prompt_chars。argv、stdin、ACP prompt和指定resume使用同一实际文本，不二次替换用户prompt里的token或截断绑定正文。`CORD_INPUT_DIR`同时提供实际根，用户env不能覆盖它。readonly命令/工具审计保持原规则，实际文件工具应使用明确绝对副本路径。

执行后按原executionInputHash重检源输入，包含缺省全域节点。私有副本只是本次输入冻结，需求或文档已变化时不能以其报告当前交付；原Goal ready、自测和最终人审仍按当前来源核验。

## 人工审查

1. 查看[input-documents](../../src/driver/input-documents.ts)：源session归属、完整hash/UTF-8、字节上限、读取前后与整组重检、manifest和宿主解锁清理。
2. 查看[上下文包](../../src/coordinator/context-pack.ts)与[NodeRunner](../../src/coordinator/coordinator.ts)：输入集合与自身产物排除、稳定配置身份、原预算预留、缺省全域执行后漂移拒绝。
3. 查看两个driver的实际args/stdin/ACP发送和[helper](../../src/driver/worker-sandbox-helper.ts)：实际根追加不是任意字符串替换，OS副本denyWrite与原cord/Git禁令同时生效，copy失败零agent派发。
4. 在Agent页查看“当前快照只读副本”，安装仍未核验。流程使用现有`sandbox.kind=workspace`和`output:text`，无需开放cord或扩大网络/env配置。
5. 用长PRD与补充文档把验收条件放在首尾片段之外，确认真实worker从副本读中段、按其实现、宿主检查失败后修复、readonly评审读取上游完整指南，最后人工gate保持未决。
6. 修改中段后旧审批应409，原run阻断；只读评审可产出差异报告，但不能使过期Goal放行或获得新自动修复预算。cold不重复仍有效worker，指定session恢复复制本次新输入，旧私有路径不能复用。

```bash
npx vitest run tests/driver/input-documents.test.ts tests/driver/worker-sandbox.test.ts tests/coordinator/context-pack.test.ts apps/server/tests/input-documents.test.ts
npm test
npm run build
npm run typecheck
npm run build:all
git diff --check
```

## 边界

最终全量1834项/128文件、root build/typecheck/build:all/diff与304本地链接通过；24项副本来源/UTF8/资源/整组漂移、真实两协议/argv/new/resume/取消清理与3项TCP全文交付回归通过。编译后Headless driver实际读取中段/副本写入拒绝，pack --dry-run包含input-documents模块和helper。

隔离两棵Git工作树实际TCP：headless `http://127.0.0.1:61385`、ACP `http://127.0.0.1:61400`，需求`REQ-FULL-INPUT`。PRD和manual关键中段未出现在实际prompt，worker从本次全文副本读到值7并实现document-value.txt；宿主checks failed→passed、readonly完整评审、cold原审批零重跑、当前协调/Goal/doctor=true。另需求中段改为8后旧审批409、readonly输出明确差异、同run gate blocked且没有新Goal预算。正常预览审批各1/人工决定0、仅deliver退出，主树值仍0，付费模型0。Playwright1440/390/320共18张Agent/协调/审批截图和指南读取通过，pageerror=0/无横向溢出；桌面与320 Agent图已实际查看，原7306真实Draft未操作。临时证据`/tmp/cord-stage91-real-result.json`与`/tmp/cord-stage91-browser-result.json`不入Git。

本阶段冻结所选需求文本，不冻结源码或提供可信验证脚本；同OS用户宿主与跨进程目录替换仍不是强事务。持久原生session可能记住旧prompt，但本次实际输入根和内容重新绑定，能否正确引用新材料仍需实际任务验证。Linux/真实付费厂商兼容尚待验收；独立协调仍只分析已有有界包，未显示材料应wait/ask_human，不能声称全文完成审查。
