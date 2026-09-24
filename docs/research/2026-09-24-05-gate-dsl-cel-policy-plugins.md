---
title: 工作流/门禁 DSL 与策略引擎
date: 2026-09-24
type: research-archive
status: 调研结论均为 2026-09-24 当日实测，时效性敏感（star 数、版本、license 可能变化）
---

后台任务的输出已回读，与报告中引用的数据完全一致（act ★72,098 MIT；Temporal ★23,274 MIT；vscode-jsonrpc 9.0.2；jco 1.35.0；quickjs-emscripten 0.32.0；xstate 5.33.2；@dagrejs/graphlib 4.0.5；nx 23.2.1 / 124 依赖）。报告无需修正，以下为完整交付内容。

---

# 调研报告：工作流/门禁 DSL、表达式引擎、策略引擎与插件 IPC

调研日期：2026-09-24。数据来自 GitHub API（`gh api`）、npm registry API 与官网/仓库文档的实时抓取，未依赖记忆。

## 0. 三条核心结论（先看这个）

1. **CEL 没有官方 JS 实现，这是本项目最大的单点依赖风险。** CEL 官方组织已从 `google/cel-*` 迁到 [`cel-expr`](https://github.com/cel-expr/cel-spec)（cel-spec ★3986，Apache-2.0，2026-09-16 活跃），旗下只有 cel-go / cel-java / cel-cpp / cel-python / cel-c 五个实现，**没有 cel-js**。JS/TS 侧全部是第三方实现，必须做适配层隔离。
2. **ADR-0014「apiVersion + 三级校验器」不是我方独创，而是 k8s / Kyverno / Cerbos 已经验证过的同构设计**，可以照着抄分层，但要自研的是"注册表 + 编排"这层薄胶水——而这层没有现成包。
3. **CNCF 有一个几乎可直接采用的 YAML 工作流 DSL 标准（Open Workflow Specification）+ 官方 TypeScript SDK**，这是本次最大发现。它已内置 DAG、并发/fork、生命周期事件、可复用子图、JSON Schema 与 TS SDK 的"生成有向图/Mermaid"能力；代价是它的运行时表达式默认选 **jq** 而非 CEL，且 TS SDK 仍是 alpha。

---

## 1. CEL 的 JS/TS 实现

| 项目 | 仓库 / 包 | License | 活跃度信号 | 评分 |
|---|---|---|---|---|
| marcbachmann/cel-js | [github](https://github.com/marcbachmann/cel-js) · `@marcbachmann/cel-js` | MIT | ★193，仓库 push 2026-09-05；npm 8.0.0（2026-07-07），**87 个版本 / 14 个月**，32 个下游依赖，0 运行时依赖 | **直接复用（首选）** |
| bufbuild/cel-es | [github](https://github.com/bufbuild/cel-es) · `@bufbuild/cel` | Apache-2.0 | ★38，push 2026-09-01；npm 0.6.1（2026-08/09），8 个版本；Buf 公司背书，被 `@bufbuild/protovalidate` 1.3.0 依赖 | **直接复用（备选/双选）** |
| ChromeGG/cel-js（旧 `cel-js`） | [github](https://github.com/ChromeGG/cel-js) · `cel-js` | MIT | ★125，**仓库已 archived**，最后 push 2026-04-26；README 公开征求接管人 | **不匹配（淘汰）** |
| cel-vm | [github](https://github.com/marvec/cel-vm) · `cel-vm` | MIT | ★1，2026-04-08 建，最后 push 2026-04-21；**npm 上 404，根本没发布**；作者自述"由 AI 生成的研究实验" | **不匹配（不可用）** |
| cel-typescript（cel-rust 绑定） | [github](https://github.com/kevinmichaelchen/cel-typescript) | **无 license** | ★1，**已 archived**，最后 push 2025-05 | **不匹配（淘汰）** |
| GRESB cel-javascript | [github](https://github.com/GRESB/cel-javascript) · `@gresb/cel-javascript` | Unlicense | ★17，最后 push 2025-07-07（**14 个月停滞**） | 只能借鉴 |
| libcel-ts | [github](https://github.com/libdbm/libcel-ts) · `@libdbm/libcel-ts` | BSD-3-Clause | 2026-07 首发，npm 2.0.0（2026-09-07），4 个版本，无社区信号 | 观察 |

### 首选实现的能力对比（决定性的几点）

`@marcbachmann/cel-js` 提供的是**可用于"编辑期校验"的完整环境 API**，这恰好命中三级校验器的第 2 级：
- `new Environment().registerVariable/registerType/registerFunction/registerOperator` + `env.check(expr)` —— 可以在不执行的情况下做类型检查，提前报 `Operator '+' not defined for types 'int' and 'string'`，还有 `getDefinitions()` 可以反查出可用变量/函数清单（可直接喂给 AI 生成表达式）。
- 解析期结构限制：`limits: { maxAstNodes, maxDepth, maxListElements, ... }` —— 防表达式炸弹。
- 整数用 BigInt（`42n`），符合 CEL int64 语义；`expr.ast` 可取 AST。
- 异步自定义函数（`registerFunction(signature, async fn)`）—— 可用于第 3 级"外部插件"的同步包装（但需谨慎，官方也提示 CEL 应保持确定性）。

`@bufbuild/cel` 的差异点：
- 依赖 `@bufbuild/re2` —— **regex 用 RE2，不用 JS RegExp**，对"第三方 workflow pack 里的表达式"更安全；marcbachmann 版用原生 `RegExp`（有 ReDoS 面）。
- 依赖 `@bufbuild/cel-spec`，与 Buf 的 protobuf 生态打通（`ReflectMessage`、`CelType` 类型映射完整）。
- 官方标注 **Status: Beta**，且仅 8 个 npm 版本、★38。

### 建议

- 定义一个窄端口 `interface ExpressionEvaluator { check(expr, decls): CheckResult; eval(expr, vars): unknown }`，把求值器藏在后面，**同时用 `@bufbuild/cel-spec`（Apache-2.0，含 CEL 官方测试数据）做一致性回归测试**——这是本次调研里最实用的一条：无论最终选谁，都能用同一套 conformance 数据验证。
- 默认选 `@marcbachmann/cel-js`（spec 覆盖最好、零依赖、有 `env.check()`、活跃）；若团队更看重"公司背书 + Apache-2.0 同源 + RE2 安全正则"，选 `@bufbuild/cel`。
- **不要考虑** cel-go 编译 WASM 的路线（CEL Playground、Quarkus Chicory 都这么干，路径可行），但 Node 侧没有打包好的 npm 产物，起步阶段自研成本不划算。
- 注意两个集成坑：① `int` 是 BigInt，而 JSON 无 int64 → 需要约定"字符串化 int64"（k8s 就是这么做）；② marcbachmann 版默认 `unlistedVariablesAreDyn: false` + `homogeneousAggregateLiterals: true`，直接用未声明的 JSON 对象会报错，需要显式配置或注册 schema。

---

## 2. YAML 定义有向图工作流的开源先例

| 项目 | 仓库 | License | 活跃度 | 提供什么 | 匹配度 |
|---|---|---|---|---|---|
| **Open Workflow Specification**（原 CNCF Serverless Workflow） | [specification](https://github.com/open-workflow-specification/specification) · [sdk-typescript](https://github.com/open-workflow-specification/sdk-typescript) | Apache-2.0 | ★932 / push 2026-09-16；TS SDK ★89 / push 2026-09-11 | YAML/JSON 工作流 DSL + JSON Schema（`schema/workflow.yaml`，79KB）+ Gherkin 一致性测试套件（CTK）+ 多语言 SDK | **适配后复用**（强烈推荐评估） |
| Argo Workflows | [argoproj/argo-workflows](https://github.com/argoproj/argo-workflows) | Apache-2.0 | ★17,003，push 2026-09-24 | k8s 原生，`apiVersion: argoproj.io/v1alpha1`、`spec.templates[].dag.tasks[].dependencies`、suspend 模板（人工门禁）、`WorkflowTemplate` 可复用图 | 只能借鉴思路（Go，无法嵌入） |
| Windmill | [windmill-labs/windmill](https://github.com/windmill-labs/windmill) | **AGPLv3（backend/frontend）；客户端 + OpenFlow spec 是 Apache-2.0** | ★18,028，push 2026-09-24 | JSON 定义的 DAG flow（modules + failure_module），分支/循环/`skip_if`/**审批 suspend 步骤**/重试/错误处理；步骤内嵌 TS 脚本 | 只能借鉴（AGPL 核心不可抄代码） |
| Kestra | [kestra-io/kestra](https://github.com/kestra-io/kestra) | Apache-2.0 | ★28,332，push 2026-09-24 | YAML flow（`id`/`namespace`/`tasks`）+ 巨型插件生态（JVM 类加载，**不是 IPC**） | 只能借鉴 |
| Dagger | [dagger/dagger](https://github.com/dagger/dagger) | Apache-2.0 | ★16,298，push 2026-09-24 | 代码即流水线（非 YAML）；跨语言 SDK 通过 **unix socket 上的 GraphQL session** 与 engine 通信 | 只能借鉴（其 IPC 范式见 §5） |
| GitHub Actions | SchemaStore schema、[rhysd/actionlint](https://github.com/rhysd/actionlint)、[nektos/act](https://github.com/nektos/act) | MIT | actionlint ★4,261（push 2026-07-16）；act ★72,098（push 2026-08-09） | 无 apiVersion；`on/jobs/needs/steps`；`${{ }}` 自研表达式方言；environments + required reviewers = 人工门禁；actionlint 对表达式做**静态类型检查** | 只能借鉴 |
| Dagu | [dagucloud/dagu](https://github.com/dagucloud/dagu) | **GPL-3.0** | ★4,074，push 2026-09-24 | 单二进制 + YAML DAG + git 存储 + 无数据库，定位与 agent-cord 最像 | **不匹配**（GPL-3.0 无法并入 Apache-2.0） |

### 为什么 Open Workflow Specification 值得认真评估

抓取到的 [dsl-reference.md](https://github.com/open-workflow-specification/specification/blob/main/dsl-reference.md) 显示它已覆盖本项目需要的大部分编排语义：

- **版本化字段**：`document.dsl: '1.0.3'`、`document.namespace/name/version/title/tags/metadata`——与 ADR-0014 的"apiVersion 化"同构（只是字段名叫 `dsl`）。
- **任务类型**：`call`（HTTP / OpenAPI / gRPC / AsyncAPI / **A2A** / **MCP**）、`do`、`emit`、`for`、`fork`、`listen`、`raise`、`run`（container / shell / script / workflow）、`set`、`switch`、`try`、`wait`。
- **`use` 可复用组件**：`functions`（复用的任务）、`retries`、`errors`、`authentications`、`catalogs`、`extensions`、`secrets`——正是"预定义工作流图 + 节点挂 gate"的现成容器。
- **生命周期事件**：Workflow Started/Suspended/Resumed/Cancelled/Faulted/Completed + Task Created/Started/Suspended/Resumed/Retried/Cancelled/Faulted/Completed——**可以直接对齐 agent-cord 的 events.jsonl 事件命名**，省掉自造事件词表。
- **`evaluate` 扩展点**：可配置运行时表达式语言，"Defaults to **jq**"，支持 strict/loose 模式——也就是说 **spec 本身留了表达式语言插槽**，把 CEL 作为新增语言接进去是有据可依的扩展，不是打补丁。
- **CTK（Gherkin 一致性测试）**：可以拿来做 agent-cord 执行器的行为测试基线。

需要注意的落差：OWS 是"云/服务编排"导向，**没有"角色 × 时机 × 校验 × 放行"的门禁概念**，也没有投票/共识语义；采纳它意味着门禁要用 `switch` + `run/shell` + `listen` 自行拼装。TS SDK 的 npm 包 `@openworkflowspec/sdk` 目前 `latest` 仍是 **0.0.1**，v1.0 线只有 `1.0.3-alpha8`（2026-08-20），**alpha，不能当稳定依赖**。它的 `validate()` + "generate a directed graph" + Mermaid 导出这几个功能最值得复用（依赖仅 ajv / js-yaml / semver / ajv-formats）。

---

## 3. 策略引擎

| 项目 | 仓库 / 包 | License | 活跃度 | 提供什么 | 匹配度 |
|---|---|---|---|---|---|
| **Cerbos** | [cerbos/cerbos](https://github.com/cerbos/cerbos) · `@cerbos/core` 0.33.1 / `@cerbos/grpc` 0.29.1 / `@cerbos/embedded` 0.15.4 | Apache-2.0 | ★4,592，push 2026-09-24；Node SDK 2026-09/07 更新 | **YAML 政策 + `apiVersion: api.cerbos.dev/v1` + `condition.match.expr` 直接写 CEL**；PDP 可本地进程 / 容器 / WASM embedded | **适配后复用（范式最同构）** |
| OPA / Rego | [open-policy-agent/opa](https://github.com/open-policy-agent/opa) · `@open-policy-agent/opa-wasm` 1.10.0 · `@styra/opa` 1.7.10 | Apache-2.0 | OPA ★12,268，push 2026-09-24；但 **npm opa-wasm 最后发布 2024-11-08**（仓库 2026-07-10 有 commit） | 通用策略引擎；WASM 可嵌入 Node；需 `opa` CLI 编译 bundle | 只能借鉴 |
| Cedar | [cedar-policy/cedar](https://github.com/cedar-policy/cedar) · `@cedar-policy/cedar-wasm` 4.13.0 | Apache-2.0 | ★1,746，push 2026-09-24；npm 活跃（2026-09-15） | 授权专用语言（permit/forbid、principal/action/resource、默认拒绝、顺序无关）；WASM 可在 Node 内跑 | 不匹配（语义是授权，不是通用条件求值） |
| Kyverno | [kyverno/kyverno](https://github.com/kyverno/kyverno) | Apache-2.0 | ★8,177，push 2026-09-24 | **同一个 YAML 里多级校验：pattern/match + JMESPath + CEL（1.11+ 的 `validate.cel` 子规则）**；1.14 起推 "CEL-first" ValidatingPolicy | **只能借鉴思路，但架构最值得抄** |
| conftest | [open-policy-agent/conftest](https://github.com/open-policy-agent/conftest) | 仓库 license 显示 NOASSERTION（需再确认） | ★3,270，push 2026-09-21 | 用 Rego 对 YAML/JSON 等结构化配置做测试 | 只能借鉴 |
| Gatekeeper | [open-policy-agent/gatekeeper](https://github.com/open-policy-agent/gatekeeper) | Apache-2.0 | ★4,280，push 2026-09-21 | k8s 策略控制器；**external data provider 通过 gRPC 外部取数**——外部化决策的先例 | 只能借鉴 |
| node-casbin | [apache/casbin-node-casbin](https://github.com/apache/casbin-node-casbin) | Apache-2.0 | ★2,917，push 2026-09-09 | 进程内 Node ACL/RBAC/ABAC，`model.conf` + `policy.csv` | 适配后复用（若门禁只需 RBAC） |
| OpenFGA | [openfga/openfga](https://github.com/openfga/openfga) | Apache-2.0 | ★5,851，push 2026-09-24 | Zanzibar 式 ReBAC，需独立服务 | 不匹配 |
| Permit.io / OPAL | [permitio/opal](https://github.com/permitio/opal) | Apache-2.0 | ★5,513（Python） | OPA 的策略/数据分发层；Permit.io 本体是 SaaS | 不匹配 |

**关键判断**：agent-cord 的 gate 语义（2/2 一致 + 证据锚点可机验 + Jaccard 同源升级）**没有任何现成引擎能表达**，所以策略引擎只能解决"节点挂的条件表达式求值"这一小块。对此 **Cerbos 是最有价值的参照物**：它证明了"YAML + apiVersion + 条件里塞 CEL + GitOps 管理"这套组合在生产可用，而且它的 Node SDK / WASM embedded PDP 给出了"策略引擎以库形式嵌入 Node"的可行形态。但**不建议直接嵌入 Cerbos 作为 gate 引擎**——引入它的 principal/resource/action 授权模型会污染 agent-cord 的领域模型，且它的 embedded PDP 依赖 Cerbos Hub 产物（有商用分层）。抄它的**政策 YAML 结构与 CEL 条件写法**，比引入它更划算。

Rego 与 Cedar 都可排除：Rego 的 npm 嵌入路径已 22 个月没发版，学习曲线与 agent-cord 的"轻量表达式"定位不符；Cedar 的授权语义与通用条件求值不同构。

---

## 4. apiVersion 资源定义模式

| 先例 | 事实 | 对本项目的意义 |
|---|---|---|
| k8s 结构：`apiVersion: <group>/<version>` + `kind` + `metadata` + `spec`/`status` | 未知字段裁剪/严格解码；CRD 用 structural schema | 直接照抄命名法；agent-cord 的 `apiVersion` 应是 `agent-cord.dev/v1alpha1` 之类的 group/version |
| **k8s CRD 的 `x-kubernetes-validations`（CEL，1.25 GA）** | [ValidatingAdmissionPolicy 用 CEL，1.30 GA](https://kubernetes.io/docs/reference/access-authn-authz/validating-admission-policy/) | **这就是"结构 schema + CEL 二层校验"的官方先例**，与三级校验器同构 |
| JSON Schema 生态 | `ajv` 8.20.0（MIT，2026-04-24）；[yannh/kubernetes-json-schema](https://github.com/yannh/kubernetes-json-schema) ★544（2026-09-23 仍在更新）；[kubeconform](https://github.com/yannh/kubeconform) ★3,200 Apache-2.0（Go） | 第 1 级（内置枚举）用 ajv + 自研 JSON Schema；kubeconform 是 Go，不可嵌入 |
| `@kubernetes-models/validate` 5.0.2（MIT，依赖 ajv） | 只做 JSON Schema 校验，**未发现支持 `x-kubernetes-validations`** | ⇒ **"JSON Schema + CEL 在同一校验链里"在 JS 生态没有现成包**，这层胶水需自研（但也只需几十行） |
| Backstage `catalog-model` | [backstage/backstage](https://github.com/backstage/backstage) ★34,488 Apache-2.0，用 `apiVersion` + `kind` 做实体类型注册表 | TS 生态里"kind → schema 注册表"的形态先例，可参考其注册与版本演进方式 |
| 其他版本的声明字段 | OWS 用 `document.dsl`；CWL 用 `cwlVersion` + `class` | 说明"apiVersion"不是唯一写法，但 group/version 语义（可演进、可多版本共存）才是关键，别退化成裸字符串 |
| CUE | [cue-lang/cue](https://github.com/cue-lang/cue) ★6,259 Apache-2.0（Go），timoni 等用它做 k8s 包管理 | "一门语言同时表达 schema + 校验 + 数据"的替代路线；**无成熟 Node 绑定**，不匹配直接复用 |

---

## 5. DAG 执行与调度库（TS）

| 候选 | 包 / 仓库 | License | 活跃度 | 提供什么 | 匹配度 |
|---|---|---|---|---|---|
| graphlib | `@dagrejs/graphlib` 4.0.5 / [dagrejs/graphlib](https://github.com/dagrejs/graphlib) | MIT | ★1,747，push 2026-09-10，0 依赖 | 有向多重图、`topsort`、`isAcyclic`、子图/算法 | **直接复用**（图结构与算法层） |
| dagre | [dagrejs/dagre](https://github.com/dagrejs/dagre) | MIT | ★5,802，push 2026-08-08 | **仅布局（可视化坐标）**，不是执行器 | 直接复用（仅当需要自动排版画布） |
| p-graph | `p-graph` 2.0.0 | MIT | 2026-09-10，0 依赖 | 并发受控的 promise DAG 执行 | **直接复用**（执行层，或自写 200 行） |
| graphology | `graphology` 0.26.0 + `graphology-dag` 0.4.1 | MIT | 主库 2025-01-26；dag 扩展 **2023-12-09（近 3 年停滞）** | 图算法集合 | 适配后复用 |
| async | `async` 3.2.6 | MIT | 2026-06-29，0 依赖 | `async.auto` 支持依赖式并发执行 | 适配后复用（API 老派） |
| Nx task runner | [nrwl/nx](https://github.com/nrwl/nx) `nx` 23.2.1 | MIT | ★29,372，push 2026-09-24；**124 个依赖** | 任务图 + 缓存 + affected + 分布式执行 | 只能借鉴（为 monorepo 设计，不适合嵌入） |
| Turborepo | [vercel/turborepo](https://github.com/vercel/turborepo) | MIT | ★31,132 | 同上，Rust 实现 | 只能借鉴（同上） |

**持久化执行引擎（Temporal / Trigger.dev / Hatchet / Inngest / Restate）——建议整体排除：**

| 引擎 | License | 活跃度 | 排除理由 |
|---|---|---|---|
| Temporal | MIT（[temporalio/temporal](https://github.com/temporalio/temporal) ★23,274，push 2026-09-24）；`temporalio/sdk-typescript` ★922 | 活跃 | 必须部署 Server |
| Trigger.dev | Apache-2.0，★16,392 | 活跃 | 是平台（需其 infra） |
| Hatchet | MIT，★7,997 | 活跃 | 需 Postgres |
| Inngest | NOASSERTION，★5,881 | 活跃 | 需服务端 |
| **Restate** | **BUSL-1.1（非 OSI 开源）** | ★4,468 | **license 直接排除** |

理由一致：agent-cord 的 SSOT 是"纯文件 + git"，执行是本地一次性流程。引入这些引擎会带来数据库/服务端依赖，与"不绑定云端、本地优先、库化分发"的定位冲突。**可以借鉴的是语义层面的东西**（幂等键、重试退避、取消、从检查点恢复），在 `events.jsonl` 上做恢复扫点即可，不需要持久化调度器。

**结论：DAG 执行这一层是被高估的难点。** 拓扑排序 + 并发闸门 + 事件落盘合计不会超过几百行，用 `@dagrejs/graphlib` 做图算法、自己写执行循环（或 `p-graph`）即可；不要为此引入 Nx / Turbo / Temporal。

---

## 6. 插件 IPC 先例（"外部校验器插件"）

| 先例 | 仓库 | License | 机制 | 匹配度 |
|---|---|---|---|---|
| **KRM Functions** | [kptdev/krm-functions-sdk](https://github.com/kptdev/krm-functions-sdk) / [kpt](https://github.com/kptdev/kpt) ★1,897 | Apache-2.0 | 插件是"读 STDIN 的 `kind: ResourceList`、写 STDOUT 的 ResourceList"的任意程序；编排器可进程内或容器内运行 | **只能借鉴，但契约最该抄** |
| **MCP** | `@modelcontextprotocol/sdk` 1.30.1 | MIT | stdio / HTTP 上的 JSON-RPC，带能力协商与结构化工具入参/出参；2026-09-23 更新，17 依赖 | **直接复用（协议首选）** |
| vscode-jsonrpc | `vscode-jsonrpc` 9.0.2 | MIT | LSP 系 JSON-RPC over stdio，0 依赖，2026-08-28 | 直接复用（更轻的底层） |
| json-rpc-2.0 | `json-rpc-2.0` 1.8.1 | MIT | 0 依赖，2026-09-20 | 直接复用 |
| hashicorp/go-plugin | [hashicorp/go-plugin](https://github.com/hashicorp/go-plugin) | MPL-2.0 | ★6,093，push 2026-09-07；子进程 + 握手 + net/rpc 或 gRPC；崩溃隔离、版本容忍；Terraform/Vault/Nomad/Packer 都用它 | 只能借鉴（Go only，Node 无对应物） |
| Terraform provider protocol | [hashicorp/terraform-plugin-go](https://github.com/hashicorp/terraform-plugin-go) | MPL-2.0 | gRPC over stdio + schema 协商 + protocol version | 只能借鉴（协议设计的黄金参照） |
| Extism | [extism/extism](https://github.com/extism/extism) ★5,775 BSD-3-Clause（主仓库 push 2026-09-02）但 [js-sdk](https://github.com/extism/js-sdk) ★137 最后 push **2025-05-14**，npm `@extism/extism` 仍是 **2.0.0-rc13** | BSD-3-Clause | 跨语言 WASM 插件框架（任何语言写插件） | 不匹配（JS SDK 16 个月未动且仍是 rc） |
| jco / Component Model | `@bytecodealliance/jco` 1.35.0 | Apache-2.0 WITH LLVM-exception | 2026-09-24 更新，活跃 | 适配后复用（未来沙箱化插件的更稳路线） |
| Dagger session protocol | [dagger/dagger](https://github.com/dagger/dagger) | Apache-2.0 | unix socket 上 GraphQL，跨语言 SDK 强类型生成 | 只能借鉴 |
| 进程内沙箱 | `quickjs-emscripten` 0.32.0 | MIT | 2026-02-16 | 适配后复用（若要跑不可信 JS） |

**建议**：外部校验器插件**不要自造协议**。两条现成路：
- 极简：**stdio + JSON-RPC（`vscode-jsonrpc`）**，一次 `initialize` 握手交换 `protocolVersion` + `capabilities`（抄 LSP/MCP/go-plugin 的握手模式），校验请求就是 `{apiVersion, kind, spec, ...}` → `{verdict, messages[]}`。
- 带生态：**直接用 MCP**（`@modelcontextprotocol/sdk`），代价是语义要映射到 `tools/call`，好处是任何现成 MCP server 都能当校验器，且 OWS spec 已把 MCP 列为原生 call 类型。若走 MCP 路线，需自行约束"校验器必须是纯函数语义"。

KRM functions 的"ResourceList in / ResourceList out"是最贴合"校验器"这个单一职责的契约形态，值得直接照抄形状（把 ResourceList 换成 agent-cord 的 gate 上下文包）。

---

## 7. 主题未列出、但重要度足够的发现

1. **Open Workflow Specification + 官方 TypeScript SDK**（CNCF）——§2 已详述，是本次唯一"可能整体免去自研工作流 DSL"的候选。
2. **Cerbos** —— YAML + `api.cerbos.dev/v1` + CEL 条件 + Node SDK，是 ADR-0014 的同构生产实例。
3. **Kyverno 1.11+ 的 `validate.cel`** —— 同一个 YAML 内同时承载 match/pattern、JMESPath、CEL，是"一个资源多级校验器"的现成设计。
4. **k8s `x-kubernetes-validations` / ValidatingAdmissionPolicy** —— CEL 作为结构 schema 之上校验层的官方实现。
5. **KRM Functions** —— 外部校验器插件的 stdio 契约先例。
6. **MCP** —— 现成的跨进程插件协议，同时 OWS 已把 MCP/A2A 作为 workflow 原生调用类型。
7. **Windmill OpenFlow spec 是 Apache-2.0**（与其 AGPL 核心分离）—— 若要参考 JSON flow 结构，只有 spec 层可看。
8. **Dagu 是 GPL-3.0** —— 定位最像 agent-cord 的同类项目，但 license 使其完全不可借鉴代码，可作竞品/对照。
9. **`@bufbuild/cel-spec`**（Apache-2.0，含 CEL 官方定义与测试数据）—— 与求值器选择无关的通用测试资产。
10. **cel-vm** —— 唯一提供"CEL 编译为可序列化 bytecode"的 JS 实现，思路（预编译 + Base64 缓存）对"同一 gate 表达式高频求值"有参考价值，但它**未发布 npm 且只有 1 star**，只能读代码不能依赖。
11. **Nx / Turborepo 的任务图** —— 作为"DAG 调度成熟形态"的参考，但依赖体量与设计目标都不匹配。

---

## 8. 复用优先级清单

### P0 — 直接复用（今天就能定）

| 能力 | 采用 | 版本 | License | 备注 |
|---|---|---|---|---|
| YAML 解析/输出 | `yaml`（eemeli） | 2.9.1 | ISC | 2026-09-11，0 依赖；js-yaml 亦可 |
| 第 1 级校验（枚举/结构） | `ajv` + `ajv-formats` | 8.20.0 | MIT | 用 JSON Schema 定义 `apiVersion/kind` 对应的每类资源 |
| 第 2 级校验（CEL） | `@marcbachmann/cel-js` | 8.0.0 | MIT | 备选 `@bufbuild/cel` 0.6.1（Apache-2.0，RE2 正则，但 beta）。**必须**藏在 `ExpressionEvaluator` 端口后 |
| CEL 一致性测试数据 | `@bufbuild/cel-spec` | 0.6.1 | Apache-2.0 | 无论选哪个求值器都用它做 conformance 回归 |
| DAG 图算法 | `@dagrejs/graphlib` | 4.0.5 | MIT | topsort / isAcyclic / 图操作 |
| DAG 并发执行 | `p-graph` 或自写执行循环 | 2.0.0 | MIT | 也可自研，成本很低 |
| 插件 IPC 传输 | `vscode-jsonrpc`（轻）或 `@modelcontextprotocol/sdk`（带生态） | 9.0.2 / 1.30.1 | MIT | 别自造协议 |
| 资源类型注册表校验 | `zod` | 4.6.5 | MIT | 与 ajv 分工：zod 管 TS 内部模型，ajv 管 YAML/JSON 权威校验 |

### P1 — 适配后复用（需要改造或部分采纳）

| 能力 | 采纳对象 | 改造点 |
|---|---|---|
| 工作流 DSL 的编排语义、生命周期事件词表、JSON Schema 骨架 | Open Workflow Specification（spec + `schema/workflow.yaml` + CTK） | 把运行时表达式语言从 jq 换成 CEL（用 spec 的 `evaluate` 扩展点）；补 gate/圆桌语义；TS SDK 目前 alpha，先只借 schema 与图生成能力 |
| 政策 YAML 结构（apiVersion + rules + CEL condition） | Cerbos 设计 | 只抄结构，不引入其 principal/resource/action 模型与 PDP |
| 多级校验器分层方式 | Kyverno / k8s（structural schema → CEL） | 加上第 3 级外部 IPC 插件（k8s 是 admission webhook，agent-cord 是 stdio 子进程） |
| 外部插件契约形状 | KRM Functions 的 ResourceList in/out | 换成 agent-cord 的 gate 上下文包；加 protocolVersion 握手 |
| ledger 条目与 gate 状态机 | `xstate` 5.33.2（MIT，0 依赖） | 仅在"状态机需要显式可视化/可测试"时引入；YAML 驱动状态机的序列化需自行验证 |

### P2 — 只能借鉴思路

Argo Workflows、Windmill（含其 Apache-2.0 的 OpenFlow spec）、Kestra、Dagger、GitHub Actions + actionlint + act、Dagu、OPA/Rego、Cedar、conftest、Gatekeeper（external data provider）、OpenFGA、Nx、Turborepo、Extism、go-plugin、Terraform provider protocol、CUE。

### P3 — 明确排除

| 对象 | 理由 |
|---|---|
| `cel-js`（ChromeGG）/ `cel-typescript` | 仓库已 archived |
| `cel-vm` | 未发布 npm，★1，自述 AI 实验 |
| `@gresb/cel-javascript` / `@libdbm/libcel-ts` | 停滞 / 无社区信号 |
| Windmill 核心代码 | AGPLv3 |
| Dagu | GPL-3.0 |
| Restate | BUSL-1.1（非开源） |
| Extism JS SDK | 16 个月未更新且仍是 rc |
| Temporal / Trigger.dev / Hatchet / Inngest | 需部署服务端或 DB，与"纯文件 + git SSOT、本地优先"冲突 |

### 必须自研（本主题范围内、无现成实现）

| 组件 | 为什么没有现成实现 |
|---|---|
| 三级校验器的**编排与注册表**（`apiVersion`+`kind` → 校验链 → 分级报告 → 稳定错误码） | k8s/Kyverno 都是它们自己领域内的实现；JS 生态没有"JSON Schema + CEL"合并校验器 |
| gate 的"角色 × 时机 × 校验 × 放行条件"模型与 CEL 绑定的变量声明（`env.registerVariable` 的**声明自动生成**） | 需要把 YAML 的 field 定义自动转成 CEL 类型声明，无先例 |
| 工作流 YAML 的**版本迁移与 apiVersion 多版本共存**（含校验器按版本分派） | 有 k8s CRD 转换 webhook 的思路，但无库 |
| 共识账本、盲评投票执行器、证据锚点机验、Jaccard 同源升级 | 领域独创，**完全无先例**（本主题外，但确认无复用可能） |

---

## 9. 需要 ADR 层面拍板的三个问题

1. **是否整体采纳 Open Workflow Specification 作为工作流编排层的基底？** 收益：省掉自研 DSL 语法、并发/超时/重试/子流程/生命周期事件的设计与测试，且拿 CNCF 的 CTK 做行为基线。代价：它是服务编排导向，gate/圆桌/门禁语义需自行扩展；TS SDK 仍是 alpha（v1.0 线只有 `1.0.3-alpha8`）；其运行时表达式默认 jq，接入 CEL 需要按扩展点实现。若不采纳，则建议只借鉴它的**事件命名与 `use` 复用容器结构**。
2. **CEL 求值器双选还是单选？** 若定单选，需接受"要么单维护者项目 + 原生 RegExp，要么公司背书但 beta + 低采用度"的取舍。
3. **外部校验器插件的协议：MCP 还是自定义 JSON-RPC？** 选 MCP 能白拿生态与现成 SDK，但要把"校验器"映射到 `tools/call` 的纯函数语义；选轻量 JSON-RPC 更贴合职责单一，但要自己维护握手与版本协商。

---

**核验说明**：所有 star 数、`pushed_at`、license、npm 版本号与发布时间均通过 GitHub API 与 npm registry API 实时查询；CEL 实现能力、Open Workflow DSL 任务类型与 `evaluate` 配置、KRM/Extism/Cerbos 机制均来自对应仓库 README 或官方文档的直接抓取，非记忆推断。个别无法逐字核实的点已在文中标注（conftest 的 license 元数据、Backstage 的 Zod 实现细节、`@kubernetes-models/validate` 是否支持 `x-kubernetes-validations` 的否定结论）。
