# ACP 文件范围预授权验收

日期：2026-10-09。协议见 [ADR-0060](../adr/ADR-0060-acp-workspace-permission-policy.md)，产品方向见 [核心 feature](../core-features.md)。

## 行为

agents.yaml 的 ACP 配置可声明 permission_policy.read/edit 工作区相对范围。可写 worker 的 read/edit 权限请求须提供全部绝对 locations，宿主核验工作区与普通文件边界后仅选择 allow_once。未知操作、缺位置、越界、链接/硬链接/管理文件和 IO 无法判断时取消；权限错误不可自动重试。readonly 仍按原拒绝策略，独立协调无工具策略保持原语义。

策略归一化去重排序并进入 ACP 配置 v3 指纹；argv 不变，不声明仍保留原 v1/v2。Agent 清单/页面只返回 read_count/edit_count，不返回授权路径、env 或提示原文。旧 resolver 固定策略，新配置使旧任务与审批重新核验。

## 离线验证

- 27 项 driver 权限测试：read/edit/创建、真实 ACP 两次一次授权、readonly、各类未知操作、多位置、缺位置/原始 input 不能猜测、路径前缀兄弟/遍历/越界、链接/硬链接/目录/管理路径、IO 错误、永久/重复选项、配置归一化/指纹/隐私/固定 resolver。
- 5 项真实 server/ACP Goal 用例：正常自主交付到最终人审、越界一次失败与策略修正恢复、人审时策略身份变化拒绝旧审批、readonly 文件不变和公开数量、普通 run.retry 不重复未授权操作。
- coordinator 新增反例：权限拒绝之后收到普通 agent 错误也不能恢复自动重试权限。
- 全量离线 963 测试 / 73 文件通过，typecheck、build:all 和 git diff --check 通过。

## 隔离 HTTP 与浏览器

使用合作 ACP fixture 真子进程，向 server 发布 Goal 并实际发起 read/edit permission request。宿主检查文件是否 fixed，不调用付费模型。

1. read=src、edit=src/private 时，read 一次授权、edit 取消，worker 只调用一次，文件保持 initial。
2. 显式重载 edit=src 后，configuration_hash 改变，原 resolver 指纹不变，公开清单只含数量。
3. 新 run 中 read/edit 都选择 allow_once，worker 写 fixed，宿主检查通过，Goal ready 后等待人工 gate。
4. 总 worker 调用两次、人工决定/节点退出 0；事件流与响应没有私有环境、请求标题或 payload 标记。
5. 冷恢复同一审批 ID，没有重复 worker；重建投影后 session doctor=true。

首次 HTTP 验收脚本对无正文 reload 设置 Content-Type=application/json 被 Fastify 拒绝；修正为仅有正文时声明内容类型，子进程已清理，随后新隔离工作区完整验收通过。

Playwright/Chrome 在 1440、390、320 宽度检查 Agent 搜索、ACP 协议、预授权读/写数量与最终审批。无横向溢出、pageerror=0、私有标记不可见；桌面与 320 截图已查看无重叠。临时结果 `/tmp/cord-stage46-real-result.json` 与 `/tmp/cord-stage46-browser-result.json` 保存证据定位，运行数据/截图不提交，人工 gate 未放行。

## 限制

该授权依赖合作 agent 提供的 kind/locations，不能抵抗谎报位置或绕过协议的恶意 agent，也不是 OS 沙箱/跨进程文件事务；检查后存在路径竞争风险，隔离仍由部署者提供。execute/delete/move/fetch、无 locations 的通用工具和 headless 权限政策未统一，不支持从 rawInput 文本推断授权。本轮不声称所有 ACP CLI 都提供足够位置元信息；缺材料保持取消。持续目标 active。
