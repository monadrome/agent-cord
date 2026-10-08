# 真实开发 Draft 与只读报告验收

日期：2026-10-07。范围：独立本地 clone、Codex CLI 0.160.0、现有模型配置、effort=low。真实产物未合入当前分支，人工 gate 未放行；这不是异构盲评或统计质量实验。

## 需求与实现

为现有 REST 请求身份 helper `requestInputHash` 新增确定性 JSON 属性回归 Draft，只允许新增 `apps/server/tests/request-input-properties.test.ts` 和节点报告，不修改生产源码、已有测试或依赖，不提交/推送/合入。

真实 worker 生成 48 组嵌套基准输入、57 个测试，涵盖对象插入序不变性、数组/内容变化、absent/null、Unicode/转义/控制字符、JSON 自有 __proto__/constructor。断言使用输入变换关系，未复制排序或 hash 实现。主机独立目标测试 57/57，通过完整 clone 测试 615/615（50 文件）及 typecheck/diff。已跟踪文件无差异，clone HEAD 与初始 remote baseline 一致。

## 流程证据

协调读取最新 PRD 产严格 Draft 提议，宿主显式启动绑定 SDLC，没有自动采用模型提议。执行 intake → 只读 plan → implement → 只读 verify，最终在 verify/human-review 挂起，done 保持 pending，没有 human.decision.recorded。

| 节点尝试 | 实际结果 | 产物通道 |
|---|---|---|
| plan | ok，约 97 秒 | readonly/text，coordinator 代写 plan.md |
| implement 首次 | timeout，240 秒 | 保留测试与部分报告，不伪造完成 |
| implement 恢复 | ok，约 157 秒 | agent 更新 implementation.md |
| verify | ok，约 89 秒 | readonly/text，coordinator 代写 findings.md |

四次任务会话 ID 不同；同版本恢复仅重跑未退出 implement，plan 没有重复派发。恢复先核验超时终态和宿主代码/测试，再在 PRD 加上恢复附记、环境限制和独立证据，通过既有 runner 重跑；没有手工追加 ok/exited 或批准 gate。

## 限制与发现

初次 worker 的共享 node_modules 导致 Vite bundled config 缓存无法写入，使用 configLoader=runner 可执行目标测试；sandbox 内全库 HTTP 测试又因 listen 权限失败。宿主普通工作区执行原目标与完整库均通过，两类结果分别记录，没有把环境限制当功能失败。

只读 reviewer 静态检查未发现阻断问题，但原目标与 runner 替代命令都因缓存/SSR 临时目录写权限失败，未完成其自身测试运行。报告明确说明不能把宿主结果冒称为本轮独立测试通过。verify 的任务 ok 仅表示完整报告已生成；报告存在/章节 gate 不证明结论正确，最终判断留给人。

真实 file_change 的 started/completed 通知曾被 parser 当正文，已在 ADR-0039 中补结构化 tool_use 映射，不提取 JSON 子串或隐藏混合结果。readonly report 保存通过 ADR-0038 的显式 output=text 由宿主完成，不扩大模型文件权限。

## 验收与后续

主工作树 572 个离线测试（51 文件）、build/typecheck/diff 通过。Playwright 在 1440/390/320 宽度核验人工 gate 待决、报告可读、环境限制可见、plan 未重复、done 未推进，无横向溢出与页面错误。实际事件、报告、源码 Draft 与截图仅保留在隔离临时检出，不提交运行数据或凭据。

本次证明真实 worker、报告写回、失败恢复和人工等待能形成可审查流程；尚未完成人工批准、合入或异构模型验证。后续应接入可审计的机器验证结果渠道，让只读 reviewer 消费可靠的测试事实，并继续核验 Claude Code/ACP 的实际调用。
