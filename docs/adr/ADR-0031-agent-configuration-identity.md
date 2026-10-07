# ADR-0031 ｜ Agent 配置身份与控制台工作台

- 状态：accepted（已实现）
- 日期：2026-10-06
- 关联：ADR-0027（配置快照与重载）、ADR-0030（任务/审批新鲜度）、ADR-0021（console/server 契约）
- 来源：自定义 agent 配置变更后的恢复审查与控制台操作闭环

## 背景

任务指纹包含 workflow 的 agent 别名，但不包含该别名的实际 model、角色或启动参数。配置变更后同名 agent 可能复用旧完成任务，审批也不能区别角色变化。已有公开清单与重载 API 还没有 console 入口。

## 备选方案

1. 用进程 revision 标识配置：重启会重新编号，未变参数也可能误失效。
2. 哈希 YAML 全文：忽略旋钮、格式、凭据都会进入比较，且与实际执行参数不一致。
3. 有效启动参数身份 + 公开配置工作台（选定）：driver 构造时派生稳定指纹，任务/审批引用此身份，console 展示 server 元信息并发起显式重载。

## 决策

1. AgentDriver 可提供 configuration_hash。内置 headless 依据协议、名称和模板实际生成的普通/只读/resume 参数派生 SHA-256；ACP 依据协议、名称、bin 和 args 派生。全部 env（含 BYO 凭据）不参与，不把任何启动原文复制进事件。
2. coordinator 将 configuration_hash 纳入 execution_input_hash，并在 agent.task.started/completed 中记录 agent_configuration_hash；同名配置变更后未退出节点必须重新执行。未提供身份的外部 driver 保留原行为，宿主需自行提供可靠身份。
3. 审批上下文包含当前节点有效 agent 身份。run 的 resolver 与身份保持启动时快照，运行中重载不改变在途任务；重启使用当前文件，身份变化让旧审批返回 409、重新生成任务与审批。
4. GET /agents 增 configuration_hash 公共槽位（无身份为 null）。该指纹代表执行定义，不验证 CLI 安装、凭据、动态本地 agent 文件或整个运行环境。
5. console 增 Agent 工作台，显示配置版本、公开清单、来源、协议、模板、配置指纹与诊断。提供搜索、来源/协议筛选、刷新和显式重载；响应失败保留已加载清单。页面不读取 env/args/角色提示，不提供凭据编辑。

## 理由（第一性原理推导）

- 别名是名字，实际执行定义才是任务的输入；同名不能证明同角色或同模型。
- 恢复指纹要跨进程稳定，不能使用进程计数器。
- 控制台应展示宿主投影并执行明确命令，不能再次实现 driver registry 或推断运行状态。

## 被否方案的否决理由（逐一）

- 进程 revision：不稳定且不能解释参数是否改变。
- YAML 全文 hash：包含凭据与无效参数，脱离执行语义。
- console 重建 registry：第二份协议逻辑会与 server 漂移。

## 关键实现注意点

- 内置模板用固定占位 prompt/session_id 生成指纹；真实任务 prompt 不属于配置身份。
- 全部 env 被排除，因此凭据或环境改变不会使配置指纹变化；动态命名 agent 的外部文件内容不在当前指纹范围内。
- 沿用现有 GET/POST Agent API 和幂等键；失败重载不改变配置版本，成功后只影响后续 run。
- 浏览器验收覆盖 desktop/mobile、加载/空列表/失败/筛选、重载成功与失败保留清单。

## 证据来源

1. `driver/headless.ts` 与 `driver/acp.ts` 的固定启动参数。
2. `coordinator/checkpoint.ts` 的 execution_input_hash 与审批输入。
3. `AgentService.catalog/reload` 与现有 console API 客户端。
