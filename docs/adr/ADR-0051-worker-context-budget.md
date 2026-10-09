# ADR-0051 ｜ worker 最新首尾上下文与完整字符预算

- 状态：accepted（实现选型）
- 日期：2026-10-08
- 关联：ADR-0023（两层上下文）、ADR-0030（checkpoint）、ADR-0046（独立协调首尾采集）
- 来源：阶段 37 的 worker 长文档尾部丢失与软预算

## 背景

节点执行重建最新文档 hash，但 worker 快照仍默认只采集前 20000 字符。长 PRD 尾部变更会触发重跑，模型却仍看不到新的尾部要求。buildContextPack 只用预算裁掉整块上游产物，PRD/账本/任务说明不计硬限制；后追加的源码身份与重试错误也可能超限。

## 决策

原生 NodeRunner 每次准备和 checkpoint 校验都使用 head_tail 采集。默认 readSnapshot 的通用前缀语义保留，不能从只有前缀的库快照假造尾部。worker 内容只选 PRD 与依赖闭包中已退出节点的产物，去重并排除占位；复用既有首尾、均衡预算与 UTF-16 范围算法，完整文件定位符仍按原样提供。

maxPackChars 作为最终 prompt 的字符上限。完整任务说明、需求元信息、账本、定位符、纪律、输出要求、源码身份与重试附记先占必需预算，再把剩余额度分配给文档片段。非法预算或必需元信息/片段索引放不下时 fail-closed，不派发模型，不静默截断控制信息。预算错误不在节点内重试；修复配置或材料后可重新 start。

ContextPackOptions 增 additional_context，宿主把源码身份与上次失败附记作为必需内容传入，不再在返回字符串后追加。worker 上下文策略为 worker-balanced-head-tail.v1，execution_input_hash 统一升级 v4 并绑定该策略。旧未退出节点的 checkpoint 必须重新执行以取得新策略下的产物；已退出节点和已有人工决定不自动回滚。

## 边界

字符预算不是 token 预算，首尾不能保证覆盖中间全部要求。明确提供原文范围、省略数与定位符；省略内容不能被声称已核验，不新增付费摘要、检索引擎或自动人工 gate。状态变化仍只经 events.append，hash/reducer 保持纯函数。
