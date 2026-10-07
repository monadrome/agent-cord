# 自定义 Agent 与 SDLC 接入示例

`agents.yaml` 提供 Codex 协调者、Claude Code 命名角色封装、Codex 计划 worker 和 Kimi ACP。按本机已安装并完成认证的 CLI 选择定义，工作区配置位置是 `cord/agents.yaml`。凭据只从本机环境继承，不写入文件或事件。Claude 的 `--agents`/`--agent` 将主会话设为指定角色，工具列表随角色继承；Codex 模板按任务只读参数设置沙箱。

编辑配置后调用 `POST /api/v1/agents/reload`，从 `GET /api/v1/agents` 核验清单、诊断与配置指纹；控制台 Agent 页使用同一接口。清单只证明配置可解析，安装、认证、模型权限由实际调用验证。命名角色的外部定义文件和环境变化不在配置指纹覆盖范围内。

`agent-sdlc.yaml` 是可发布流程：检查人工 PRD → Codex 计划草稿 → 内容/章节门禁 → 人工审核。发布到独立 SDLC 名称后，在需求详情的协调页选择该版本与 `context-coordinator` 发起轮次；有效 advance 提议可显式采用，之后仍需人工批准计划。选择 `claude-architect` 或 `kimi-acp` 可验证不同驱动的协调角色，不改变流程推进规则。

```bash
curl -X POST http://127.0.0.1:7250/api/v1/sdlcs/agent-example/versions/publish \
  -H 'Idempotency-Key: publish-agent-example-1' -H 'Content-Type: application/json' \
  --data-binary "$(node --input-type=module -e 'import {readFileSync} from "node:fs"; process.stdout.write(JSON.stringify({yaml:readFileSync("examples/agent-sdlc.yaml","utf8")}));')"
```

REST 输入是 JSON，使用结构化序列化保留 YAML 正文；每次新操作使用新幂等键。同键重试必须保持请求内容一致，遇到未确认结果先核验实际状态。只读 CLI 参数与应用的文档路径检查不能替代 worker 的操作系统隔离；生成和协调都只产 Draft，合入和关键 gate 由人完成。

示例的模型/推理档位由使用者选定，未锁定某个模型版本；任务事件保留实际启动配置身份和快照 provenance。当前示例用于本地原型，不能据此声称已具备多用户服务或跨进程 lease。
