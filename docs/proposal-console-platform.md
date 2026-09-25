# agent-cord 控制台与平台化方案

状态：历史方案，已由实现替代（2026-09-25）。当前 server、console、SDLC 和数据边界以 [`./current-architecture.md`](./current-architecture.md) 为准；本文件保留原始目标、取舍和验收背景，供 ADR-0021/0022 追溯。

## 1. 目标

为现有 agent-cord 增加一个可操作的前端控制台和后端服务层，使用户可以：

- 创建和跟踪需求 session；
- 查看 PRD、计划、发现、ADR、账本和证据锚点；
- 启动默认 SDLC 或选择组织自定义 SDLC；
- 查看工作流节点、gate、agent 任务和运行日志；
- 处理人工确认、权限请求、冲突和升级事项；
- 发起盲评投票、查看投票证据和少数派意见；
- 在不修改代码的情况下创建、复制、校验和发布 SDLC 定义。

控制台是现有后端能力的操作面。事件协议、账本 reducer、工作流、投票和 agent driver 仍由后端执行，前端不复制状态机逻辑。

## 2. 非目标

第一版不包含：

- 在线 IDE 或代码编辑器；
- 直接让 agent 自动合入代码；
- 把聊天记录作为事实来源；
- 在浏览器执行任意用户脚本；
- 一开始就建设多租户计费、复杂组织权限或云端托管；
- 用数据库替换 `cord/<req-id>/` 文件与 git 作为 SSOT。

## 3. 目标架构

```text
React 控制台
    │ REST 命令 / SSE 事件
    ▼
agent-cord server
    ├── API adapter：鉴权、参数校验、幂等键、错误映射
    ├── Session service：项目/需求/运行对象与文件夹映射
    ├── Workflow service：SDLC 版本、校验、启动、暂停、恢复
    ├── Approval service：人工 gate、ACP permission、冲突处理
    ├── Projection service：ledger、timeline、任务、指标派生视图
    ├── Job runner：agent driver、voting、checker、超时和重试
    └── core：EventStore / Reducer / Workflow / Voting / Driver
         │
         ├── cord/<req-id>/events.jsonl     权威事件流
         ├── cord/<req-id>/ledger.yaml      确定性投影
         └── .agent-cord/index.sqlite       可删除的派生查询索引
```

### 技术选择

- 前端：React + Vite + TypeScript；复用现有 TypeScript 类型和 Zod schema。
- 后端：Node.js + TypeScript；HTTP 层优先采用 Fastify，保持与现有 ESM/NodeNext 一致。
- 实时通道：SSE。服务端向控制台推送事件和投影更新；命令仍使用 REST。
- 数据：文件夹和 git 继续是权威存储；SQLite 只保存需求列表、运行索引、待办审批和全文/筛选索引。
- 任务执行：进程内队列起步；需要跨进程或远程部署时再换成可持久化队列，不能让队列状态取代事件流。

建议采用 npm workspaces：

```text
apps/console/       React 控制台
apps/server/        HTTP/SSE 服务
packages/contracts/ 前后端 API schema 与 DTO
src/                现有 agent-cord 领域内核
```

如果暂时不拆 workspace，也可以先在现有仓库内使用 `src/server` 和 `web`，但共享契约必须独立 barrel 导出，避免前端直接依赖 core 内部实现。

## 4. 产品信息架构

### 4.1 总览 Dashboard

显示：

- 进行中的需求数量；
- 各 SDLC 节点分布；
- 待人工处理事项；
- 最近事件和失败运行；
- doctor/事件流健康状态。

首屏应直接进入需求列表和待办审批，不做营销型 landing page。

### 4.2 需求详情

页面分为以下视图：

- **概览**：当前 SDLC、节点、阻塞原因、负责人、最近活动；
- **文档**：PRD、ADR、Plan、Findings 的 Markdown 预览和 Draft 对比；
- **共识账本**：按 provisional/confirmed/overturned 筛选条目，查看证据锚点、投票记录和冲突；
- **工作流**：节点图、gate 状态、运行时间、重试和恢复点；
- **投票**：决策点、各 ballot、模型/provider、锚点重合度、少数派理由；
- **事件**：按因果序查看事件详情，仅允许追加操作，不提供直接编辑历史事件；
- **审批**：人工 gate、ACP permission、冲突裁决和超时任务。

### 4.3 SDLC 管理

- 默认 SDLC；
- 自定义 SDLC 列表；
- 草稿、校验、发布、归档；
- 版本 diff；
- 当前被哪些需求使用；
- checker、agent、人工角色引用检查。

UI 提供表单和图形编辑器，但最终产物必须是可审阅、可 git 版本化的 YAML/JSON。

### 4.4 系统设置

- agent driver 配置；
- provider/model 配置；
- checker 注册状态；
- 默认 gate 和超时；
- merge driver/doctor 健康状态；
- 本地 workspace 配置。

密钥只进入运行环境或系统密钥存储，不进入事件流、浏览器 localStorage 或 git。

## 5. 默认 SDLC

默认流程保持简单，适合小型需求：

```text
intake → align → plan → implement → verify → review → done
```

建议定义为 `agent-cord.dev/sdlc/v1alpha1`：

```yaml
apiVersion: agent-cord.dev/sdlc/v1alpha1
kind: SDLC
metadata:
  id: simple-sdlc
  name: 简单 SDLC
spec:
  nodes:
    - id: intake
      label: 需求进入
      artifact: prd.md
    - id: align
      label: 对齐与共识
      depends_on: [intake]
      artifact: adr.md
      gates:
        - id: evidence-required
          when: post
          checks: [{ ref: anchors-present }]
          on_fail: block
    - id: plan
      label: 计划
      depends_on: [align]
      artifact: plan.md
    - id: implement
      label: 实现
      depends_on: [plan]
    - id: verify
      label: 验证
      depends_on: [implement]
      artifact: findings.md
    - id: review
      label: 人工评审
      depends_on: [verify]
      gates:
        - id: human-review
          when: post
          checks: [{ ref: anchors-present }]
          pass:
            human_confirm: true
          on_fail: escalate
    - id: done
      label: 完成
      depends_on: [review]
```

默认 SDLC 必须具备：

- 至少一个证据 gate；
- 至少一个人工确认点；
- 节点依赖无环；
- checker 引用可解析；
- 每个节点的恢复行为可重放；
- 发布前生成完整版本和校验哈希。

## 6. SDLC 定制模型

### 6.1 生命周期

```text
draft → validated → published → archived
```

发布版本不可原地修改。需求运行实例绑定具体 `sdlc_version`，后续修改只影响新需求；迁移中的需求必须显式创建迁移事件。

### 6.2 允许定制的内容

- 节点、依赖和显示名称；
- 产物类型；
- gate 挂载位置、checker、通过条件、超时和升级策略；
- 角色与审批人；
- agent/profile 选择；
- 默认上下文包和触发器。

### 6.3 禁止或需要二次审批的内容

- 任意脚本和任意 shell 命令；
- 关闭所有人工 gate；
- 把 agent 直接设置为合入者；
- 降低事件、锚点和审计字段要求；
- 变更插件权限和凭证范围；
- 生产中的 SDLC 原地修改。

## 7. 后端 API 草案

### 查询

```text
GET  /api/v1/workspaces
GET  /api/v1/projects/:project_id
GET  /api/v1/requirements
GET  /api/v1/requirements/:req_id
GET  /api/v1/requirements/:req_id/timeline
GET  /api/v1/requirements/:req_id/ledger
GET  /api/v1/requirements/:req_id/votes
GET  /api/v1/requirements/:req_id/approvals
GET  /api/v1/sdlcs
GET  /api/v1/sdlcs/:sdlc_id/versions
GET  /api/v1/agents
GET  /api/v1/health
GET  /api/v1/requirements/:req_id/events/stream   SSE
```

### 命令

```text
POST /api/v1/requirements
POST /api/v1/requirements/:req_id/runs
POST /api/v1/requirements/:req_id/votes
POST /api/v1/requirements/:req_id/approvals/:approval_id/decide
POST /api/v1/requirements/:req_id/conflicts/:conflict_id/resolve
POST /api/v1/sdlcs/:sdlc_id/versions/validate
POST /api/v1/sdlcs/:sdlc_id/versions/publish
POST /api/v1/sdlcs/:sdlc_id/versions/:version_id/archive
POST /api/v1/doctor
```

所有写命令都需要：

- `Idempotency-Key`；
- actor、correlation_id 和 source；
- Zod schema 校验；
- 权限检查；
- 先追加事件，再刷新投影；
- 返回 command_id、event_id 和最新投影版本。

## 8. 后端优化重点

### 8.1 领域服务化

把现在由 CLI/测试直接拼接的调用整理为服务：

- `SessionService`：创建需求、读取快照、绑定 SDLC；
- `RunService`：启动、暂停、恢复、取消运行；
- `WorkflowService`：校验定义、执行节点、恢复节点；
- `ApprovalService`：人工选择题和权限决定；
- `ProjectionService`：timeline、ledger、待办、指标；
- `AgentService`：driver 探测、任务执行、超时和取消；
- `SdlcService`：版本、发布和迁移。

### 8.2 可靠性

- 事件 append 是唯一提交点；任务状态不能先写数据库再补事件。
- 长任务必须有 `run_id`、lease、heartbeat、cancel 和 resume 语义。
- 同一需求同一节点使用幂等键，重启不能重复产生副作用。
- SSE 断线通过 `Last-Event-ID` 从事件序号恢复。
- 数据库丢失后可从 `cord/` 和事件流重建索引。

### 8.3 查询性能

SQLite 只存派生表：requirements、runs、nodes、approvals、ledger_entries、events_index。

事件写入后由 projector 更新索引；projector 落后不影响事实正确性，API 必须返回 projection lag，控制台显示“正在同步”，不伪装成最新状态。

### 8.4 安全

- 本地模式默认单用户；远程模式增加 workspace/member/role；
- agent、checker、插件分别声明权限；
- 插件只收到上下文包，不直接得到 session 文件路径；
- secret 不进入事件 payload；
- SDLC 发布和权限扩大需要人工确认；
- 所有人工操作都写 `human.decision.recorded`。

## 9. 分阶段实现

### Phase 1：后端服务骨架

- npm workspace 或 `apps/server`；
- Fastify HTTP server；
- workspace/requirement/session 查询；
- REST 命令和统一错误格式；
- SSE 事件流；
- 从现有 `cord/` 重建派生索引；
- 本地单用户模式；
- 健康检查和 doctor API。

验收：不用前端，通过 curl 可以创建需求、读取 ledger、订阅事件、执行 doctor。

### Phase 2：控制台 MVP

- Dashboard；
- 需求列表和详情；
- 文档预览；
- workflow timeline；
- ledger/evidence；
- approvals；
- event stream；
- 默认 SDLC 运行。

验收：用户可以在浏览器完成 `创建需求 → 编辑 PRD → 启动默认 SDLC → 处理 gate → 查看 confirmed 账本`。

### Phase 3：SDLC 定制

- YAML/表单双向编辑；
- 图形化 DAG；
- 引用、环、权限和 checker 校验；
- draft/validated/published/archived 版本生命周期；
- SDLC diff 和运行实例绑定版本；
- 迁移与回滚策略。

验收：新建一个只增加 gate 的 SDLC 不改代码即可发布并用于新需求。

### Phase 4：生产能力

- MCP 外部 checker；
- CEL evaluator；
- 真实 ACP permission 人工桥接；
- workspace/member/role 鉴权；
- durable job queue；
- IM adapter；
- 指标、审计、备份和恢复演练。

## 10. 需要新增或修订的 ADR

- ADR-0021：控制台与 server 的分层、SSE 和派生索引边界；
- ADR-0022：SDLC schema、版本生命周期和运行实例绑定；
- ADR-0023：本地单用户到远程多用户的鉴权模型；
- ADR-0024：任务 lease、projector 和 API 幂等语义；
- 修订 ADR-0014/0018：将控制台 SDLC 编辑能力与 workflow schema 对齐；
- 修订 ADR-0019：MCP checker 在 server 中的生命周期和安全边界。

## 11. 风险与人为参与

必须保留人的环节：

- 发布或修改组织 SDLC；
- 关闭、降低或绕过 gate；
- agent 权限请求；
- 投票分歧、锚点重合和 ledger conflict；
- 需求范围和业务事实确认；
- 最终代码合入。

主要风险：

- 把派生数据库误当成 SSOT；
- 前端直接实现状态机导致与 reducer 漂移；
- 自定义 SDLC 变成任意脚本执行入口；
- SSE 或队列重试产生重复事件；
- 多用户权限引入后，已有本地文件模型的边界不清。

## 12. 推荐决策

推荐先做“本地单用户控制台 + 默认 SDLC + REST/SSE + 文件 SSOT + SQLite 派生索引”。

这样可以最大化复用现有 M2 能力，并在真实使用中验证三件事：

1. 用户是否真的需要图形化 SDLC 定制；
2. 人工 gate 和审批是否是主要交互成本；
3. 事件流投影和任务恢复是否足以支撑连续运行。

在这三点得到真实数据前，不建议先建设完整多租户、插件市场或复杂低代码编辑器。
