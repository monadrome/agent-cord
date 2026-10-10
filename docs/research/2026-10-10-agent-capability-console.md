# Agent 能力工作台与 Human Review 指南

## 问题与行为

底层能力契约已支持启动参数和 ACP 无 prompt 协商，但 Agent 工作台尚未展示或调用。旧清单在已注册名字旁显示绿色勾选，可能让用户把注册误解成安装/协议验证。查询期间重载也没有明确新鲜度，幂等缓存还会重复历史响应。

本次能力详情和筛选沿用现有运营工作台：列表保留名字、来源、协议/模板和配置身份，右侧展开能力。静态声明说明支持的启动选项与原生 resume、宿主 Goal、受限流程恢复、安装未核验；ACP 协议查询另列当前 session 观察和 mode/选项候选/省略数。模型访问保持未核验，原人工 gate 与真实 Draft 不操作。

server inspect 捕获固定配置并在返回时核对 current；重载、移除保留旧 hash/revision，不把新身份补进旧结果。console 查询后读最新 catalog，再核对 current/revision/非空 hash/alias。清单读取失败保留结果并显示未核验；后续刷新能恢复状态。协议查询失败保留上次结果，不能伪称本次成功。切换 Agent 不转移结果，移除后保留选中历史材料并禁用查询。查询仍是明确动作，不发送模型 prompt。

## 操作路径

1. 导航 Agent，使用搜索/来源/协议/能力筛选。
2. 展开任一 Agent 的能力，检查静态启动选项、原生恢复与安装状态。
3. ACP 详情中的查询图标发起协议查询；等待后查看配置版本/指纹、原生 resume、模式与候选值。
4. 成功重载配置会使旧观察过期，重新查询获得新结果；错误查询可修复配置后重试。刷新失败时结果为“清单未核验”，读回最新清单后再判断。

headless 不提供协议查询按钮；这里没有执行模型任务或配置编辑器。bare/auto/模型/effort/扩展配置的写法仍见 [启动指南](./2026-10-10-agent-launch-capabilities.md)。

## 人审重点

- `AgentService.inspect`：固定 driver/revision，await 返回后核对当前 alias/非空 hash；幂等历史响应仍是原值。
- `agent-capabilities.ts`：仅核对公开身份，不推断业务能力；旧 server 缺少 current 时 fail-closed。
- `Agents.tsx`：共享 in_flight/generation 防止重复或卸载后的迟到更新；结果按名字归属，查询后清单读失败保持未核验。
- `AgentCapabilityDetails.tsx`：声明与观察、上次查询/错误、旧配置与当前配置分别呈现；model access 不标通过。
- `styles.css`：沿用既有颜色/字号与不浮动的详情区域；桌面表格、窄屏纵向候选和长列表局部滚动。

## 证据与边界

离线测试覆盖查询期间 changed/unchanged/removed/invalid_reload、原配置身份、幂等不重查、消费缺 current/hash/alias/revision。实际 fixture ACP 子进程与真实 TCP HTTP 查询沿用阶段 59。

隔离浏览器验证成功、拒绝设置后重试、显式重载、配置过期、清单 503 后刷新恢复、切换时迟到结果不串号、移除后的历史观察与禁用查询。1440、390、320 宽度检查截图和文档无横向溢出；大列表省略数、长名字、最小按钮和 pageerror 单独断言。临时截图与运行定位留在 /tmp，不提交项目。

current 只核验查询配置身份，不证明外部 CLI 版本、凭据/模型/额度、实际代码交付或测试充分性。静态能力也不证明安装。后续刷新之前的未观察外部变化仍可能存在，最终执行会再按 driver/Goal 契约验证。

最终验证：`npm test` 1193 项 / 82 文件、`npm run typecheck`、`npm run build:all`、`git diff --check` 与 105 项相关本地文档链接通过。隔离浏览器 1440/390/320 共 9 截图、8 次显式查询、pageerror=[]，页面无横向溢出；未调用付费模型，原真实 Draft 未操作。
