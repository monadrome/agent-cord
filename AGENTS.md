# Repository Guidelines

## Project Structure

- `src/core/`: EventEnvelope、事件存储、确定性 reducer、session 和 doctor；`schema.ts` 与 `ports.ts` 是跨模块契约。
- `src/workflow/`、`src/voting/`、`src/driver/`: 工作流门禁、盲评投票和 ACP/headless agent 驱动。
- `apps/server/`: Fastify REST/SSE 服务、run runner、人工 gate 和 SDLC 版本服务。
- `apps/console/`: React + Vite 控制台；只展示 server 投影，不复制状态机。
- `tests/` 与 `apps/*/tests/`: 与源码对应的 Vitest 测试；`docs/` 保存方案和 ADR。
- 运行时数据位于 `cord/<req-id>/`：`events.jsonl` 是事实来源，`ledger.yaml` 是投影，`.index/` 是可重建索引。

## Build, Test, and Run

```bash
npm install
npm run typecheck       # 所有 workspace 的 TypeScript 检查
npm test                # 全部离线测试
npm run build:all       # 构建内核和控制台
npm run serve           # 启动 server，默认 http://127.0.0.1:7250
npm run dev:console     # 启动 Vite 前端，/api 代理到 7250
npm run cord -- demo    # 运行离线核心闭环
```

要求 Node.js `>=22.5.0`。项目未配置 ESLint/Prettier，提交前使用 `git diff --check`。

## Coding Style

- TypeScript strict 模式、ESM/NodeNext；相对导入必须带 `.js` 扩展名。
- 注释、文档和 CLI 输出使用中文；标识符使用英文 `snake_case`。
- `core/hash.ts` 与 `core/reducer.ts` 必须保持纯函数，不读时钟或随机数。
- 状态变更只能通过 `session.events.append`；checker 无法判定时必须 fail-closed。
- 修改 `src/core/schema.ts` 或 `src/core/ports.ts` 前，先新增或更新 ADR。

## Testing Guidelines

测试文件使用 `*.test.ts`，路径与模块镜像。测试默认离线：投票使用 `MockProvider`，子进程使用 `tests/driver/fixtures/`。新增行为应覆盖成功、失败和恢复路径；提交前运行完整 `npm test`。

## Commits and Pull Requests

提交信息使用简短的 Conventional Commits 风格，例如 `feat: add console server`、`fix: preserve event hash chain`。完成一个 feature、修复或优化并通过验证后，默认检查 `git diff`，自动提交并推送当前分支；推送失败时保留本地提交并报告具体原因。PR 应说明动机、行为变化、测试命令和已知限制；涉及控制台 UI 时附截图或操作路径，涉及协议时链接对应 ADR。

## Security and Configuration

agent 只产 Draft，合入和关键 gate 永远人工完成。不要把凭证写入事件流、账本或测试 fixture。REST 写命令必须使用 `Idempotency-Key`；不要提交 `dist/`、`node_modules/`、`cord/.index/` 或临时文件。
