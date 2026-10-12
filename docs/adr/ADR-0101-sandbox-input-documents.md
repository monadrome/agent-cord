# ADR-0101 ｜ 沙箱 Worker 的当前全文输入副本

- 状态：accepted（已实现，macOS离线验收）
- 日期：2026-10-12
- 关联：ADR-0100（Worker OS限制）、ADR-0098（节点输入）、ADR-0050（上下文预算）

## 背景与方案

Worker沙箱禁止读取cord，现有上下文包只提供首尾片段，原定位符无法读取全文。仅增加prompt预算不能解决大需求中被省略的材料，也不能开放整个事实目录。选择宿主按已绑定快照复制允许文档，在单次私有输入目录提供只读全文与清单。

## 决策

1. AgentTask可选`input_documents:{session_dir,req_id,files:[{file,content_hash,content_length}]}`和`max_prompt_chars`。严格数据契约只接受有界唯一规范文档路径，禁止事件、账本和管理路径；不接受模型current布尔或任意源目录。缺沙箱时不能静默忽略显式输入副本请求。
2. 新沙箱能力声明`input_documents=verified_copy`，固定策略升级workspace.srt-0.0.79.v2并进入现有driver配置hash。未声明沙箱的旧driver身份不变；旧沙箱完成/协调/审批依据按原新鲜度重检。安装仍unchecked，声明本身不证明本次复制成功。
3. 节点宿主只传本次readNodeSnapshot允许的存在文档，排除本节点自产artifact；选择集合与executionInputHash共用语义。独立协调保持禁止任何工具调用，不获得文档副本或新增读取权限，不把worker全文能力等同协调模型看过全部材料。
4. Driver准备时核验session_dir确实属于当前workspace/cord/req_id，普通目录、非链接；文档以既有安全路径解析和no-follow独立文件描述符读取，最多128项、单文档16MiB、合计64MiB。核验当前完整UTF-8逻辑文本hash/字符数和读取前后元信息，一项缺失、漂移、链接、非法或超限即零agent派发，不回退旧输入或扩大scope。
5. 副本在每调用scratch的input-documents中，保留相对文件名、内容与manifest；文档/清单0400、目录0500，实际OS策略明确denyWrite整个副本树，包含改名、chmod和文件别名。原cord/Git禁令不变，正文不经IPC/事件保存，只通过受限本地副本供该worker读取。
6. 上下文包为固定输入定位指令预留4096字符，定位符指向manifest中的相对副本；driver追加结构化真实input_documents_root/manifest路径，并在argv/stdin/ACP发送前核验最终prompt<=原max_prompt_chars。不替换用户prompt或文档中的占位文本，不截断已绑定正文或偷偷增加预算。随机临时路径不进入语义hash，内容集合与策略进入已有输入/driver身份。
7. 原生new/resume共用本次当前副本，不读取旧缓存中的文档。源码/文档在执行期间变化仍由宿主重检，不能凭私有副本报告当前交付；新副本能力下默认全域节点也重检原executionInputHash，范围声明保持自身语义。取消/超时/缺runtime/提前停止或清理失败保持原fail-closed生命周期，临时副本不保留到持久HOME。

## 被否方案

- 允许直接读取cord：会暴露事实、历史或其他需求，而且模型可观察未绑定文件。
- 仅把更多文本塞进prompt：无法证明省略中段可读，也会破坏已声明预算。
- 只复制片段或使用模型自报已看全文：不满足实际输入与快照hash一致。
- 提升独立协调的工具权限：该职责只消费受限宿主投影，与节点Worker的全文定位是不同边界。

## 验证与限制

覆盖完整中段/Unicode与嵌套路径、scope/自产输出/事件管理文件排除、当前hash与源目录身份、缺失/读故障/超限/取消零派发，真实两协议OS读写/别名/清理、argv/stdin/指定恢复和最终prompt预算。TCP Goal普通失败自动修复→readonly全文评审→当前协调/cold/最终人工gate，输入漂移不能记ready或复用旧报告。全部离线，不操作7306原真实Draft。

副本仅冻结本次所选文本，不证明源码被冻结、业务覆盖充分、trusted验证资产或同OS用户宿主抗篡改。Linux仍待实际OS验收；不能从这项能力推断模型实际读取了每篇全文。协议工具审计保持既有只读命令/已知工具规则。
