# 只读命令参数审计：Human Review指南

## 依据与行为

本机`rg --help`明确说明`--pre=COMMAND`对每个文件执行程序，`--hostname-bin=COMMAND`也执行所指定程序；Git diff/log的`--output`写文件，find的`-fprint/-fprintf`写输出。旧basename/少量危险flag策略无法拒绝这些选项，structured argv的join还会丢失参数边界。

新策略`worker-command-options.v2`使用Node标准parseArgs严格解析每种命令的已知读选项；find使用明确读表达式及参数元数。未知长/短选项、执行/写出选项、缺值或未知命令直接拒绝。裸命令与精确/bin、/usr/bin入口可识别，其他路径不借basename冒认。输入只能有一个command/cmd/shell_command/argv字段，不能用安全字段掩盖另一个危险字段。

简单命令文字保留原有限ASCII字符，不接受引号、替换、管道或glob等shell语法；需要复杂pattern/文件名时由适配器报告真实structured argv，最多64项/512字符、无控制字符。数组参数逐字保留，`--`后选项样式文字按位置数据处理；不执行或重新展开`$(literal)`。只允许命令的受限语义，不推断工具实际采用shell还是exec。

| 输入 | 审计结果 |
|---|---|
| `git --no-pager log --oneline -n5` | 允许已知读参数 |
| `{"argv":["rg","--fixed-strings","pattern with space","src"]}` | 允许，pattern是一个参数 |
| `{"argv":["git","diff","--","--output=literal-file"]}` | 允许，`--`后为路径数据 |
| `rg --pre=program pattern src` | 拒绝执行程序的选项 |
| `git diff --output=report.txt` | 拒绝写文件的选项 |
| `find src -fprint report.txt` | 拒绝写文件的表达式 |
| `/tmp/git diff`、矛盾输入或未知flag | 无法核验，拒绝 |

当前子集覆盖git diff/log/show/status/rev-parse/cat-file/ls-files、rg/grep、find、ls/cat/head/tail/wc/stat/file/pwd/true。未知扩展和厂商特有选项需提供证据后明确适配；不悄悄继续，也不靠重复调用越权操作重试。拒绝原因只保存命令工具类别，嵌入Bash工具名的命令正文也不入事实。

## 证明迁移

readonly任务的execution输入域为v6，审批域为v3，均绑定新策略；含readonly节点的流程协调输入另绑定worker_readonly_tool_policy。旧未退出完成、旧审批和提议按现有新鲜度规则重新核验，新完成可继续复用。可写节点、无readonly流程和Agent配置hash保持原语义；Agent的参数映射声明与宿主工具审计是两个维度，不回滚已退出节点。

## 审查入口

1. [readonly-tool-policy.ts](../../src/coordinator/readonly-tool-policy.ts)：单字段输入、真实数组边界、具体选项allowlist、精准路径、find元数、脱敏错误。
2. [checkpoint.ts](../../src/coordinator/checkpoint.ts)、[session-agent.ts](../../src/coordinator/session-agent.ts)：readonly执行/审批/协调策略身份、可写兼容和独立禁工具。
3. [命令测试](../../tests/coordinator/readonly-command-options.test.ts)：52项危险长短参数/路径/输入、合法读选项、structured pattern、`--`数据、原型键与Bash拒绝原因。
4. [策略迁移测试](../../tests/coordinator/readonly-policy-identity.test.ts)：5项无readonly兼容、旧完整checkpoint拒绝/新完成复用、原稿/不可重试、真实ACP归一化工具拒绝/修复。
5. [真实TCP测试](../../apps/server/tests/readonly-command-options.test.ts)：3项rg/git/find危险参数不自动重试；修复只读配置只重做评审，保留Goal宿主自测/指南，cold人审不重复，协调读取最新PRD并保留人工gate。
6. [ADR-0091](../adr/ADR-0091-readonly-command-option-audit.md)、[核心Feature](../core-features.md)：产品边界与证明身份。

```bash
npx vitest run tests/coordinator/readonly-command-options.test.ts tests/coordinator/readonly-policy-identity.test.ts apps/server/tests/readonly-command-options.test.ts
npm test
npm run typecheck
npm run build:all
git diff --check
```

完整验收见[progress.md](../../progress.md)。测试fixture只向宿主报告工具输入，不执行危险程序/写出命令，不调用付费模型或操作7306上的真实Draft。

阶段79最终1573项/113文件、typecheck/build:all/diff通过，60项新增全绿。隔离实际HTTP PID69913/http://127.0.0.1:50832：writer-model/high成功并自测一次，review-model/low危险命令失败且retryable=false；修复structured读参数仅再评审，上游Goal/指南未变，cold不重复且审批ID保留。PRD更新B后同review配置无工具独立协调current/wait；审批1/人工决定0/采用0/仅deliver退出/doctor=true。`/tmp/cord-stage79-tests.json`与`/tmp/cord-stage79-real-result.json`保留证据，无新增UI行为；B下当前提议不能证明旧ready重新验收。

## 限制

工具通知可能晚于执行，拒绝报告不等于阻止了既有副作用。PATH、Git配置/pager/filter、缓存/index刷新、外部环境和工具实现仍可能影响行为，本层不提供OS隔离、工作区读范围或命令绝对无写入证明；生产部署应使用独立检出/沙箱和可用的执行前hook。structured数组也只在适配器如实报告时成立。独立Context Session Agent继续拒绝全部工具，可写Goal不采用此allowlist。最新需求下的current wait不批准旧交付或解除最终人工gate。
