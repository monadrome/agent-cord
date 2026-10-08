# 快照事件完整性与故障恢复验收

日期：2026-10-08。范围：隔离临时工作区、真实 JSONL 文件、离线 CLI fixture 子进程和实际 HTTP；未调用付费模型、未批准 gate、未采用真实 Draft。

## 问题与实现

10 个反例先全部复现：快照跳过损坏完整行/活跃残行、接受外部 session 进度，自定义端口的非法返回不被拒绝，坏材料仍派发模型、在途坏事实仍返回旧提议，查询/采用及冷恢复继续接受旧成功。

ADR-0047 引入原生 readOrderedStrict 和核心 readSessionEvents。快照、验证与独立协调共用严格边界；完整性错误要求修复材料，不自动重复 worker 尝试。旧自定义端口仍受返回 envelope/session 检查，原有 readOrdered 保留诊断用途。当前修复后严格读取可恢复，历史诊断不作为原生当前读取的否决依据。

## 实际 HTTP

临时 server 完成一轮真实 headless fixture 后加入损坏行，列表、查询、采用、新建均返回 409，未暴露损坏内容、未派发额外 driver、未登记 run。健康需求仍能协调；修复后旧轮次可重新核验，之前失败的新建使用同幂等键可成功。

关闭 server，在未完成 requested 后加入坏行再启动：health=true，坏需求文件原样保留，没有 paid/fixture 调用重放；健康需求仍正常完成。修复后再启动，旧请求只新增 failed/interrupted completed，没有 started 或模型调用。

另启动 sleep=60000 的真实 fixture 子进程；坏事实流中的明确取消返回 409，但 PID 已回收。修复后读取到真实 cancelled 终态，同键取消重试返回 200；没有伪造 cancel_requested。最终 human.decision=0、节点退出/worker/adopted=0，session doctor=true。JSONL、PID 和验收结果只保留在临时目录。

## 回归与边界

全量 735 测试 / 59 文件、build:all/typecheck/git diff --check 通过，覆盖当前读取修复、冷恢复、旧端口兼容、未知 payload、完整末行无换行和已有原子残行恢复。原真实开发 Draft 经实时 HTTP 核验仍有一个待审 gate、零人工决定、done 未退出。

该验收证明读侧与恢复边界，不认证事件作者、外部 CI 或模型质量；不替代 doctor，不改变纯 hash/reducer，不保护本轮范围之外的普通 workflow 投影。冷打开发现坏行后的写锁仍需修复并重新打开。
