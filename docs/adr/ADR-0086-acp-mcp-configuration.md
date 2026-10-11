# ADR-0086 ｜ ACP MCP配置与传输协商

- 状态：accepted（已实现并验证）
- 日期：2026-10-10
- 关联：ADR-0084（执行/只读配置）、ADR-0079（查询生命周期）、ADR-0031（配置身份）

## 协议依据

ACP官方session-setup规定session/new与session/load接收mcpServers；stdio为必需支持的基线，HTTP/SSE仅在initialize的mcpCapabilities明确支持时使用。已安装SDK 1.5.0支持这些结构；不采用unstable的ACP MCP transport。公开文档与本地SDK共同核验，不从CLI名称猜能力。

## 决策

ACP条目/options增加 `mcp_servers`、`readonly_mcp_servers` 两套完整结构化列表，最多16个server，名称唯一。只读列表缺省为空，不继承可写工具；显式声明只读列表意味着授权对应启动/连接，但不保证工具只读。实际调用在spawn前解析凭据引用，session/new/load在initialize后检查所选HTTP/SSE能力，再传选中列表；不支持或环境变量缺失在session请求前形成不可重试configuration错误，不退回空列表或新session。

配置支持type=stdio/http/sse：stdio使用绝对command路径、argv与env_from映射（目标env名→宿主env名）；HTTP/SSE使用http(s) URL和headers_from（header名→宿主env名）。凭据值不写YAML，也不进入hash/清单/协议观察；按driver env快照与当前process.env解析，缺值/非法值拒绝。URL禁止userinfo/fragment，headers不区分大小写重复名拒绝。构造校验不泄露配置原文。原session/new/load拒绝可能回显凭据，配置MCP时此类失败统一为固定错误，不存raw回执。

HTTP header值在spawn前使用Node标准validateHeaderValue验证完整字符范围，控制字符/不可编码值直接固定configuration失败，不尝试连接或回退；有效tab/Latin-1按标准处理，不用只检查CR/LF替代协议校验。网络连接验收使用官方MCP SDK和本地loopback服务，记录连接/工具/认证是否成功与流关闭，不记录header值；客户端关闭不推断远端工具已撤销或session记录已删除。

非空列表使用 `cord.agent-config.acp.v7`，覆盖两套规范化配置、launch/readonly_launch及各自状态策略；credential变量名参与身份，值不参与，非凭据外部行为变化仍用context_revision。空/未声明列表保持旧身份/能力元信息，序列保持配置顺序，映射键排序归一化。公开能力仅增加有界mcp_configuration的执行/只读数量与传输类型，协调共用此投影，不公开名称/URL/command/argv/env/header。

inspect仍以mcpServers=[]创建临时session，不解析MCP凭据或连接所配置服务；返回新增可选mcp_transports观察stdio=required、HTTP/SSE boolean、connections=not_requested。查询mode仍选择对应launch，身份绑定完整定义；协议支持不等于MCP连接健康或工具权限。工具/权限查询拒绝策略、生命周期共享/取消不变。控制台展示声明与查询分别标注，不自动探测MCP或注入工具到独立协调。

## 验证与边界

覆盖严格结构/重复/超限/非法地址/env引用、真实ACP新session/指定load的两套列表、握手不支持/缺凭据前置拒绝、错误正文脱敏、hash/固定resolver/冷恢复与查询不连接；实际stdio MCP连接用官方MCP SDK驱动确定性server，不调用付费模型。真实TCP Goal消费工具结果、自测、人审、readonly协调与配置变化。MCP进程和远端服务由ACP agent管理，宿主不承诺OS隔离/逐工具拦截/远端无副作用；readonly工具审计与独立协调禁止工具、最终gate保留。

最终1421项/100文件、typecheck/build:all/diff与128个本地文档链接通过，新增14项driver/3项TCP包含官方SDK实际stdio连接和子进程收束。HTTP/SSE范围为标准参数传递/能力拒绝，未实际连接远端。隔离HTTP MCP调用1次、code连接1/报告与最新协调plan连接0、审批1/人工决定0/仅deliver退出/doctor通过。1440/390/320六张完成态截图通过、pageerror为空，无横向溢出，桌面/320/stdio截图已查看。配置与审查见 [Human Review指南](../research/2026-10-10-acp-mcp-configuration.md)。

阶段74补充1437项/102文件、typecheck/build:all/diff通过；两项header控制字符/Unicode失败反例修复，官方SDK本地HTTP/SSE 10项driver/4项TCP验证实际认证、工具、显式load、拒绝/取消/超时与完整Goal/readonly/最新快照/cold等待。取消反例显示请求收束与HTTP远端session保留可同时发生；不将fixture合作terminateSession作为平台保证。两套实际隔离预览都保持人审未决，未连接第三方托管服务。
