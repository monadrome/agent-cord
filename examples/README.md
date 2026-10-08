# 自定义 Agent 与 SDLC 接入示例

`agents.yaml` 提供 Codex 协调者、Claude Code 命名角色封装、Codex 计划 worker 和 Kimi ACP。按本机已安装并完成认证的 CLI 选择定义，工作区配置位置是 `cord/agents.yaml`。凭据只从本机环境继承，不写入文件或事件。Claude 的 `--agents`/`--agent` 将主会话设为指定角色，工具列表随角色继承；Codex 模板按任务只读参数设置沙箱。

编辑配置后调用 `POST /api/v1/agents/reload`，从 `GET /api/v1/agents` 核验清单、诊断与配置指纹；控制台 Agent 页使用同一接口。清单只证明配置可解析，安装、认证、模型权限由实际调用验证。命名角色的外部定义文件和环境变化不在配置指纹覆盖范围内。

`agent-sdlc.yaml` 是可发布流程：检查人工 PRD → Codex 计划草稿 → 内容/章节门禁 → 人工审核。发布到独立 SDLC 名称后，在需求详情的协调页选择该版本与 `context-coordinator` 发起轮次；有效 advance 提议可显式采用，之后仍需人工批准计划。选择 `claude-architect` 或 `kimi-acp` 可验证不同驱动的协调角色，不改变流程推进规则。

`development-sdlc.yaml` 扩展为五节点：需求检查 → 只读计划 → 可写实现 Draft → 只读评审报告 → 人工终审。必须运行在独立检出/隔离工作区；示例本身不会创建 OS 隔离。实现 worker 可修改工作区，禁止提交、推送和合入；评审 worker 使用新会话，只读核验代码和测试，报告由协调层写入 findings.md。默认 Codex 角色别名仍可能使用同模型，这不等价于异构盲评；需要异构时替换评审 driver，并实际核验模型与权限。

评审报告完成后，`host-tests` gate 等待宿主提交 `offline-tests` 事实；最终 `human-review` 再检查同一验证结果，避免机器 gate 通过后代码变化仍可批准。宿主按当前上下文执行命令并提交结果，人工终审保持独立。

`machine-verification-sdlc.yaml` 展示宿主/CI 机器验证门禁：流程在验证 gate 处等待（`on_fail: escalate`），先获取 `GET /api/v1/requirements/:req_id/runs/:run_id/nodes/:node_id/verification-context`，在隔离工作区执行检查，再用 `POST /api/v1/requirements/:req_id/runs/:run_id/verifications` 提交状态与摘要 hash。服务端会重算输入指纹，输入变化返回 409；事实落盘后只唤醒同一 run 重检，`verification-passed` 只消费当前 scope、run、节点和 hash 的 `passed` 事实。

只读计划/评审声明 `run: {readonly: true, output: text}` 和节点 artifact。worker 返回完整 Markdown，coordinator 通过共享文件边界代写 Draft；空内容、只有协议 metadata、产物冲突、失败或取消不能生成成功报告。后置文件 gate 和人工审核依然生效；不声明 output 的旧 readonly 节点仍不写产物。

验证 checker 的 `with.inputs` 声明工作区相对文件/目录，例如 `[src, apps, tests, package.json]`。同节点取输入并集，context 返回 `source_inputs/source_hash`；文件内容、增删、类型和权限变化都会改变 `input_hash`。先取 context，再执行测试，再提交原 hash；不得在测试后取新 hash 冒称测试针对新代码。目录内的 `.git`、`cord`、`.index`、`.sdlc`、`node_modules` 和 `dist` 排除；直接声明这些路径、链接、硬链接、缺失文件或超限范围拒绝。依赖版本应声明 lockfile。未声明 inputs 只验证文档/流程，不证明代码相同。

readonly worker 也绑定同节点声明范围的 source_hash：源码不变的报告可恢复复用，源码变化后重新派发评审；运行期间源码变化时报告不写回，保留失败事实再基于新输入恢复。可写实现 worker 的正常代码产出不应用这个只读规则。未声明范围的只读节点仍只有文档/配置身份。

独立协调轮次使用整个绑定 SDLC 的声明范围并集，包括后续验证节点：REST round 的 source_hash 标识本轮源码。代码改变而 PRD 不变时，旧轮次 current=false、不可采用；新轮次基于新摘要建立会话。摘要只能证明输入身份，不能证明测试通过或模型结论正确。

```bash
curl -X POST http://127.0.0.1:7250/api/v1/sdlcs/agent-example/versions/publish \
  -H 'Idempotency-Key: publish-agent-example-1' -H 'Content-Type: application/json' \
  --data-binary "$(node --input-type=module -e 'import {readFileSync} from "node:fs"; process.stdout.write(JSON.stringify({yaml:readFileSync("examples/agent-sdlc.yaml","utf8")}));')"
```

REST 输入是 JSON，使用结构化序列化保留 YAML 正文；每次新操作使用新幂等键。同键重试必须保持请求内容一致，遇到未确认结果先核验实际状态。只读 CLI 参数与应用的文档路径检查不能替代 worker 的操作系统隔离；生成和协调都只产 Draft，合入和关键 gate 由人完成。

示例的模型/推理档位由使用者选定，未锁定某个模型版本；任务事件保留实际启动配置身份和快照 provenance。当前示例用于本地原型，不能据此声称已具备多用户服务或跨进程 lease。
