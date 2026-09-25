/**
 * server 启动入口（ADR-0021）：`npm run serve` 或 `npm run dev -w @agent-cord/server`。
 * 环境变量：CORD_PORT（默认 7250）、CORD_ROOT（默认 cwd，内含 cord/）。
 */
import { buildApp } from "./app.js";

const port = Number.parseInt(process.env["CORD_PORT"] ?? "7250", 10);
const root = process.env["CORD_ROOT"] ?? process.cwd();

const { app } = await buildApp({ root, logger: true });
await app.listen({ port, host: "127.0.0.1" });
app.log.info(`agent-cord server 就绪：http://127.0.0.1:${port}（工作区 ${root}）`);
