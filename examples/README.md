# 自定义 Agent 与 SDLC 接入示例

`agents.yaml` 提供 Codex 协调者、Claude Code 命名角色封装、Codex 计划 worker 和 Kimi ACP。按本机已安装并完成认证的 CLI 选择定义，工作区配置位置是 `cord/agents.yaml`。凭据只从本机环境继承，不写入文件或事件。Claude 的 `--agents`/`--agent` 将主会话设为指定角色，工具列表随角色继承；Codex 模板按任务只读参数设置沙箱。

编辑配置后调用 `POST /api/v1/agents/reload`，从 `GET /api/v1/agents` 核验清单、诊断与配置指纹；控制台 Agent 页使用同一接口。清单只证明配置可解析，安装、认证、模型权限由实际调用验证。命名角色的外部定义文件和环境变化不在配置指纹覆盖范围内。

`agent-sdlc.yaml` 是可发布流程：检查人工 PRD → Codex 计划草稿 → 内容/章节门禁 → 人工审核。发布到独立 SDLC 名称后，在需求详情的协调页选择该版本与 `context-coordinator` 发起轮次；有效 advance 提议可显式采用，之后仍需人工批准计划。选择 `claude-architect` 或 `kimi-acp` 可验证不同驱动的协调角色，不改变流程推进规则。

`goal-sdlc.yaml` 是推荐的代码交付流程：需求检查 → Goal 自主实现/宿主验证/修复/review 指南 → 人工终审。控制台“Agent 协作 · Goal”模板提供同一模式。运行在已授权的隔离检出中，按目标项目调整 `run.goal.inputs` 与 `checks` 的 bin/args；示例命令对应本仓库的 npm 脚本，声明路径必须实际存在。Goal 支持 ACP/headless 注册别名，artifact 是带非空“变更 / 验收 / 风险”章节的指南。

宿主直接运行声明命令，不经过 shell。测试失败和缺交付项自动回灌 worker；次数、总时长与无进展达到上限后 run=failed，错误与 goal.attempt.completed 保留具体原因，不生成放行选择。普通失败不需要人点击继续；代码或指南在人审期间变化时旧审批 409，剩余预算内重做 Goal。只有同 run 的最新 ready 与当前宿主验证/源码/指南身份一致才能恢复复用；未退出 Goal 的新 run 重新验证，已经退出的节点仍遵循原执行版本语义。

宿主证据附在指南中，含实际 argv、工作目录、退出状态、耗时、输出 hash 和结果事件 ID。完整原始输出不落盘；失败尾部只在内存中供下一次修复。声明测试脚本与依赖仍处于工作区信任边界，源码 hash 只证明身份，不证明验收质量或恶意 worker 抗篡改。Goal 不改变 ACP 权限策略，也不替代最终 review。详见 [ADR-0056](../docs/adr/ADR-0056-goal-node-execution.md)。

最终指南可在需求详情 → 文档 → review.md 只读查看原文与预览；REST 使用 GET artifacts?path=review.md，未声明文件不会被开放。人工审批仍在“审批”页操作，阅读指南不生成任何 gate 决策。

Goal 可选声明 `supervisor_agent` 与 `supervisor_timeout_ms`。达到 blocked 后，宿主自动创建一次绑定 blocker 的协调轮次，控制台显示“Goal 自动升级”，生成 ask_human/wait Draft。示例使用已注册的 context-coordinator，模板也须按本机配置调整；未声明 supervisor 时不会增加模型调用。已有协调先收束再核验，重启不重放已经请求的 supervisor；答复仅补充澄清，不恢复 run、扩预算或放行 gate。详见 [ADR-0058](../docs/adr/ADR-0058-automatic-goal-blocker-escalation.md)。

`development-sdlc.yaml` 扩展为五节点：需求检查 → 只读计划 → 可写实现 Draft → 只读评审报告 → 人工终审。必须运行在独立检出/隔离工作区；示例本身不会创建 OS 隔离。实现 worker 可修改工作区，禁止提交、推送和合入；评审 worker 使用新会话，只读核验代码和测试，报告由协调层写入 findings.md。默认 Codex 角色别名仍可能使用同模型，这不等价于异构盲评；需要异构时替换评审 driver，并实际核验模型与权限。

评审报告完成后，`host-tests` gate 等待宿主提交 `offline-tests` 事实；最终 `human-review` 再检查同一验证结果，避免机器 gate 通过后代码变化仍可批准。宿主按当前上下文执行命令并提交结果，人工终审保持独立。

`machine-verification-sdlc.yaml` 展示宿主/CI 机器验证门禁：流程在验证 gate 处等待（`on_fail: escalate`），先获取 `GET /api/v1/requirements/:req_id/runs/:run_id/nodes/:node_id/verification-context`，在隔离工作区执行检查，再用 `POST /api/v1/requirements/:req_id/runs/:run_id/verifications` 提交状态与摘要 hash。服务端会重算输入指纹，输入变化返回 409；事实落盘后只唤醒同一 run 重检，`verification-passed` 只消费当前 scope、run、节点和 hash 的 `passed` 事实。

只读计划/评审声明 `run: {readonly: true, output: text}` 和节点 artifact。worker 返回完整 Markdown，coordinator 通过共享文件边界代写 Draft；空内容、只有协议 metadata、产物冲突、失败或取消不能生成成功报告。后置文件 gate 和人工审核依然生效；不声明 output 的旧 readonly 节点仍不写产物。

验证 checker 的 `with.inputs` 声明工作区相对文件/目录，例如 `[src, apps, tests, package.json]`。同节点取输入并集，context 返回 `source_inputs/source_hash`；文件内容、增删、类型和权限变化都会改变 `input_hash`。先取 context，再执行测试，再提交原 hash；不得在测试后取新 hash 冒称测试针对新代码。目录内的 `.git`、`cord`、`.index`、`.sdlc`、`node_modules` 和 `dist` 排除；直接声明这些路径、链接、硬链接、缺失文件或超限范围拒绝。依赖版本应声明 lockfile。未声明 inputs 只验证文档/流程，不证明代码相同。

readonly worker 也绑定同节点声明范围的 source_hash：源码不变的报告可恢复复用，源码变化后重新派发评审；运行期间源码变化时报告不写回，保留失败事实再基于新输入恢复。可写实现 worker 的正常代码产出不应用这个只读规则。未声明范围的只读节点仍只有文档/配置身份。

独立协调轮次使用整个绑定 SDLC 的声明范围并集，包括后续验证节点：REST round 的 source_hash 标识本轮源码。代码改变而 PRD 不变时，旧轮次 current=false、不可采用；新轮次基于新摘要建立会话。摘要只能证明输入身份，不能证明测试通过或模型结论正确。

协调 prompt 同时包含当前 run 各声明验证的结构化观察，区分未验证、当前失败、当前通过和过期结果；summary/测试日志不注入。提议可以通过 `{source: verification, id: <当前结果 event_id>}` 引用事实，结果变化后旧提议失效。控制台“来源”链接直接展开该事件；人工 gate 继续等待人。

```bash
curl -X POST http://127.0.0.1:7250/api/v1/sdlcs/agent-example/versions/publish \
  -H 'Idempotency-Key: publish-agent-example-1' -H 'Content-Type: application/json' \
  --data-binary "$(node --input-type=module -e 'import {readFileSync} from "node:fs"; process.stdout.write(JSON.stringify({yaml:readFileSync("examples/agent-sdlc.yaml","utf8")}));')"
```

REST 输入是 JSON，使用结构化序列化保留 YAML 正文；每次新操作使用新幂等键。同键重试必须保持请求内容一致，遇到未确认结果先核验实际状态。只读 CLI 参数与应用的文档路径检查不能替代 worker 的操作系统隔离；生成和协调都只产 Draft，合入和关键 gate 由人完成。

示例的模型/推理档位由使用者选定，未锁定某个模型版本；任务事件保留实际启动配置身份和快照 provenance。当前示例用于本地原型，不能据此声称已具备多用户服务或跨进程 lease。
