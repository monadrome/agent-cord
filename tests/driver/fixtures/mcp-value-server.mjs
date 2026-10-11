// 官方MCP SDK stdio替身，返回确定业务值，不调用LLM或网络。
import { appendFileSync, writeFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const argv = process.argv.slice(2); const flag = name => argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined;
const record = value => { if (flag("--record")) appendFileSync(flag("--record"), JSON.stringify(value) + "\n"); };
if (flag("--pid-file")) writeFileSync(flag("--pid-file"), String(process.pid));
record({ event: "started", ...(flag("--revision") === undefined ? {} : { revision: flag("--revision") }) });
const server = new McpServer({ name: "value-fixture", version: "1" });
server.registerTool("lookup_value", { description: "返回确定业务值", inputSchema: {} }, async () => {
  record({ event: "tool.called", tool: "lookup_value" });
  return { content: [{ type: "text", text: process.env["FIXTURE_VALUE"] ?? "fixed" }] };
});
await server.connect(new StdioServerTransport());
