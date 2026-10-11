# ACP MCP配置与能力协商：Human Review指南

## 协议与配置

依据[ACP官方session-setup](https://agentclientprotocol.com/protocol/session-setup#mcp-servers)与本地SDK 1.5.0：session/new/load接收MCP列表，stdio是必需基线，HTTP/SSE须initialize的mcpCapabilities明确支持。官方文档通过Firecrawl核验，本阶段不采用unstable ACP MCP transport。

```yaml
agents:
  worker:
    kind: acp
    bin: your-acp-agent
    mcp_servers:
      - type: stdio
        name: workspace-tools
        command: /absolute/path/to/mcp-server
        args: [--stdio]
        env_from: {API_KEY: WORKSPACE_MCP_API_KEY}
      - type: http
        name: remote-tools
        url: https://your-mcp-service/mcp
        headers_from: {Authorization: WORKSPACE_MCP_AUTHORIZATION}
    readonly_mcp_servers: []
```

示例command/URL须换成实际服务；headers_from的环境值是完整header文字。列表最多16项、名称唯一，stdio command必须绝对路径；HTTP/SSE URL仅http(s)，不接受userinfo/fragment；header不区分大小写的重复名称拒绝。不接受内联env/headers值，凭据放宿主环境，引用只保存变量名。argv/URL不得自行携带凭据。MCP清单内容不是prompt，不经过shell；stdio argv由agent直接传工具进程。

## 执行、恢复与查询

实际任务在spawn前解析凭据引用，缺值/NUL/无效HTTP header值直接返回固定configuration错误；header使用Node标准validateHeaderValue核验控制字符与编码，不用只检查换行替代协议校验。初始化后检查HTTP/SSE传输支持，未支持时不调用session/new/load、不发送prompt，也不退回空MCP。显式session ID恢复传当前任务所选完整列表，仍须loadSession支持。只读默认不继承可写列表；显式readonly_mcp_servers授权启动/连接对应工具，不证明工具只读，独立协调的禁止工具规则继续执行。

非空定义使用ACP配置hash v7，包含执行/只读完整列表、launch和只读launch/顺序策略；凭据变量名参与身份，值不参与。映射键序归一化，driver深拷贝配置；热重载不改变在途resolver，定义变更使旧协调/审批/checkpoint重新核验。凭据旋转或未声明外部工具行为变化不自动检测，后者由context_revision表达。空/未声明MCP保留旧身份/能力。

无prompt inspect传空MCP列表，不解析所配引用，返回stdio=required、HTTP/SSE支持与connections=not_requested。能力声明只公开数量/传输，不公开工具名、地址、command/args或引用。控制台分别展示配置数量与协议传输，“支持”不表示服务已连接、健康或获工具权限。configured session拒绝可能回显凭据，因此非空MCP的session请求错误固定脱敏；不声称能阻止恶意agent在任意输出中泄露自己的环境。

## 审查入口

1. [acp-mcp.ts](../../src/driver/acp-mcp.ts)：严格结构、大小/重复/路径/URL/引用边界、规范化、动态凭据解析和协商检查。
2. [acp.ts](../../src/driver/acp.ts)：选中任务列表、spawn前拒绝、new/load与session错误脱敏、v7身份、inspect不连接；检查默认只读为空。
3. [agents-yaml.ts](../../src/driver/agents-yaml.ts)、[ports.ts](../../src/core/ports.ts)、[schema.ts](../../src/core/schema.ts)：无效别名阻断，公开元信息与协调严格契约不含原文。
4. [驱动测试](../../tests/driver/acp-mcp.test.ts)：14项实际ACP参数/两模式/显式load、引用失败无进程、未协商传输、错误回显脱敏、snapshot/hash兼容、官方MCP SDK stdio工具与子进程清理。
5. [TCP SDLC测试](../../apps/server/tests/acp-mcp.test.ts)：查询没有MCP进程、代码消费实际工具结果、宿主验证/指南、readonly报告/最新PRD协调、冷等待不重复工具与热重载不污染原resolver。
6. [AgentCapabilityDetails.tsx](../../apps/console/src/pages/AgentCapabilityDetails.tsx)：声明数量、传输协商与未请求连接分别呈现；UI无自动MCP探测或权限授予。
7. [网络驱动测试](../../tests/driver/acp-mcp-network.test.ts)、[网络TCP交付测试](../../apps/server/tests/acp-mcp-network.test.ts)：官方SDK本地HTTP/SSE实际认证/工具/指定load、拒绝/取消/超时、inspect无请求、Goal宿主自测/readonly报告/最新PRD/cold等待与凭据修复。

## 实际证据

阶段73最终1421项/100文件、typecheck/build:all/diff与128个本地文档链接通过。隔离HTTP中官方MCP SDK完成一次真实stdio工具调用，工具结果fixed进入代码、宿主检查和review.md证据；后续报告/最新PRD协调为plan且连接数0。MCP子进程已退出，审批1/人工决定0/仅deliver退出/doctor通过，更新PRD后的独立协调current=true提出wait，不放行旧交付。Playwright1440/390/320六张完成态截图通过、无pageerror或横向溢出，桌面/320/stdio截图已查看。

实际预览`/#/agents`搜索mcp-capabilities，声明执行1/只读1（HTTP/SSE），查询只证明HTTP支持、SSE未声明支持、未请求连接；缺少服务凭据仍能做这种无连接查询。搜索mcp-worker展示stdio执行1/只读0，查询不会重新启动工具。临时证据`/tmp/cord-stage73-real-result.json`与`/tmp/cord-stage73-browser-result.json`，最终记录见[progress.md](../../progress.md)。

阶段74补齐本地真实HTTP/SSE连接：10项网络driver和4项TCP回归覆盖认证、工具、指定session load、拒绝/取消/超时及完整Goal闭环，2项header失败反例先复现后修复；最终1437项/102文件、typecheck/build:all/diff通过。两套隔离预览均实际工具1次、code连接1/报告与最新协调plan连接0、审批1/人工决定0/仅deliver退出/doctor通过，证据`/tmp/cord-stage74-real-result.json`。当前没有新增UI行为，不重复既有截图验收。

取消/超时用例证明活动请求和流收束、未写成功代码、工具没有自动重试；HTTP反例同时保留远端session记录。成功fixture显式terminateSession是agent的合作清理行为，不能推断任意agent或服务在宿主取消时删除远端记录。实际连接范围为stdio与本地loopback HTTP/SSE，未连接第三方托管服务。MCP进程/连接生命周期由ACP agent管理，宿主进程树清理不覆盖远端副作用或工具OS隔离。readonly工具审计、ACP文件预授权、源码/产物核验与最终人工gate继续独立执行。离线fixture不调用真实LLM，原真实开发Draft未操作。
