# ADR-0091 ｜ 只读命令参数审计与证明身份

- 状态：accepted（已实现并验证）
- 日期：2026-10-10
- 关联：ADR-0068（工具审计）、ADR-0030（checkpoint）、ADR-0050（独立协调禁工具）

## 问题与依据

原只读策略只按可执行文件basename与少量危险参数拒绝，`rg --pre`/`--hostname-bin`、`git diff/log --output`、`git diff --ext-diff`、`find -fprint`等仍被允许。这些合法工具选项可执行外部程序或写文件，不能因工具名看起来是读取就放行。结构化argv还被join成文字，参数中的空格会变成新参数，存在语义丢失；自定义/tmp/git也会被当作系统git。

## 决策

采用明确读取命令/子命令与参数allowlist，未知选项fail-closed。Node标准parseArgs处理常见POSIX参数、短选项组合、值和`--`；find只支持明确读取表达式与参数元数，不解析shell。原简单命令字符串继续只接受无引号/控制/替换语法的有限字符，结构化argv保留数组边界/字面量；重复或矛盾的command/cmd/shell_command/argv不任选其一。仅接受已知裸命令或精确/bin、/usr/bin路径，拒绝其他路径的basename冒认。

读取flags以git diff/log/show/status/rev-parse/cat-file/ls-files、rg/grep、find和文件查看命令的受限子集为准；明确执行/写输出/未知选项、未知命令和不完整值均拒绝。`--`后的相似文字在实际支持位置参数的命令中保留为数据，不按子串判危险。错误只携带稳定工具类别，不记录命令、路径或pattern正文。

使用worker-command-options.v2策略身份：readonly任务execution输入域v6和审批域v3包含该策略；流程存在readonly节点时协调输入也绑定该策略，旧完成/审批/提议按现有新鲜度重检。可写节点与无readonly流程保持旧身份；不修改Agent配置hash或公开schema，不回滚已退出节点。新checkpoint合法时继续复用，违规为不可重试driver failure，不靠自动重复越权达成happy path。

## 边界与验证

这是通知后的参数语义审计，不是执行前hook或OS隔离，不能证明PATH、Git配置/pager/filter、环境或工具实现可信，也不能撤销副作用。明确结构化Read等工具的语义仍取决于适配器；独立Context Session Agent继续禁用全部工具，可写Goal不使用此allowlist。

先复现危险选项/路径冒认/argv丢失/旧身份反例，再覆盖常见读参数、structured字面量、`--`数据、short组合/值、无效输入、宿主拒绝/原稿与不可重试。真实TCP只读评审与最新快照协调、cold迁移/复用与人工gate需验收；完整test/typecheck/build/diff及Human Review指南在提交前补齐。

最终新增60项（52命令/5身份与ACP/3TCP）与完整1573项/113文件、typecheck/build:all/diff通过。隔离实际HTTP确认违规不可重试，修复只读配置仅重做评审，上游Goal/自测/指南保留，cold不重复；最新PRD协调current/wait、审批1/人工决定0/仅deliver退出/doctor通过。fixture只报告危险工具输入而不执行，不证明执行前拦截。审查入口与验收限制见[Human Review指南](../research/2026-10-10-readonly-command-options.md)。
