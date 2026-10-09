# worker 最新上下文覆盖与预算调研

日期：2026-10-08。阶段 37。

## 现状与设计审查

agent-optimizer 的上下文与外部验证原则要求核对实际 prompt，而不只检查文件 hash。当前 worker 的最新快照只采集文档前缀，长需求末尾不可见；大 PRD、账本与任务说明可超过 maxPackChars，源码/重试附记在预算后追加。上游整块放不下就停止遍历，也会丢掉后续小报告。

## 可复用证据

阶段 32 已通过 Firecrawl 核验 [Anthropic 上下文工程资料](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)，并实现确定性首尾采集、短文档额度回流、UTF-16 字符范围和真实调用验收。见 [独立协调上下文覆盖](./2026-10-08-coordination-context-coverage.md)。本轮复用已核验资料和算法，不重复抓取或添加模型摘要。

## 本轮取舍

worker 只把 PRD 和已退出的上游依赖产物纳入均衡文档内容，不把无关文档挤进高信号层。固定协议、账本与输出要求保持完整，放不下则停止派发；每次重试和源码绑定都共享最终预算。策略身份升级，旧软预算/前缀任务不能被冒认为新策略任务。

## 验证计划

先复现长 PRD 尾部、受限预算跨上游覆盖、固定信息超限、源码/重试附记超限与旧 checkpoint。再验证硬长度、索引还原、无关文档隔离、失败/修复恢复和真实子进程/模型 prompt。临时验收不批准或采用真实开发 Draft。

## 验收结果

10 项新增反例全部先失败；6000 字符预算下旧 prompt 达到 10726/20835 字符，非法预算仍派发。实现后原生源码绑定/重试、必需信息拒绝、修复恢复与旧完整 checkpoint 重跑/新策略恢复通过。最终全量 818 测试 / 63 文件、build:all/typecheck/git diff --check 通过。

隔离 git 工作区真实 HTTP：70000 字符任务说明使 worker failed/snapshot、retryable=false，未调用模型，也未进行节点内重试。修复任务并更新三份 80000+ 字符文档到 B 版本后，真实 Claude reviewer 只读角色仅调用一次，prompt=59970 字符、工具数 0，PRD/计划/ADR 三份文档索引范围逐项对照原文。报告准确引用三条仅来自正文尾部的 B 标记，并明确中间内容未核验。

server 重启保持同一审批 ID，不重放 worker；输入与报告字节不变，人工决定 0、review 未退出、doctor=true。Playwright/Chrome 1440/390/320 验证报告三标记可见、保存按钮无编辑时禁用、待审 gate 可见，无溢出/pageerror；桌面/手机截图已查看无重叠。预览 `http://127.0.0.1:7314/#/requirements/REQ-WORKER-COVERAGE/docs`，选择 findings.md。临时正文、运行数据和截图不入库。

本验收证明本机 worker 能使用已提供尾部和兑现字符预算，不证明统计模型质量、token 上限或中间所有需求已被读取。
