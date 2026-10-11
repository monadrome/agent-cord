// ACP替身通过官方MCP Client真实连接stdio工具，plan模式仅消费宿主快照。
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const argv = process.argv.slice(2); const flag = name => argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined;
const record = value => { if (flag("--record")) appendFileSync(flag("--record"), JSON.stringify(value) + "\n"); };
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
let cwd = process.cwd(); let session_id = "acp-mcp-session"; let clients = [];
const options = [{ id: "workflow", name: "Mode", type: "select", currentValue: "plan", options: [{ value: "plan", name: "Plan" }, { value: "code", name: "Code" }] }];
const close = async () => { await Promise.allSettled(clients.map(client => client.close())); clients = []; };
async function message({ id, method, params }) {
  const respond = result => send({ jsonrpc: "2.0", id, result });
  if (method === "initialize") { respond({ protocolVersion: 1, agentCapabilities: { loadSession: true }, agentInfo: { name: "acp-mcp-fixture", version: "1" } }); return; }
  if (method === "session/new" || method === "session/load") {
    cwd = params.cwd; session_id = params.sessionId ?? session_id;
    record({ event: method, session_id, mcp_names: params.mcpServers.map(server => server.name), transports: params.mcpServers.map(server => server.type ?? "stdio") });
    await close();
    for (const server of params.mcpServers) {
      if (server.type !== undefined) throw new Error("离线MCP fixture仅真实连接stdio");
      const client = new Client({ name: "acp-mcp-fixture", version: "1" }); clients.push(client);
      await client.connect(new StdioClientTransport({ command: server.command, args: server.args, env: Object.fromEntries(server.env.map(value => [value.name, value.value])), cwd, stderr: "pipe" }));
    }
    respond({ ...(method === "session/new" ? { sessionId: session_id } : {}), configOptions: options }); return;
  }
  if (method === "session/set_config_option") { options.find(option => option.id === params.configId).currentValue = params.value; respond({ configOptions: options }); return; }
  if (method === "session/cancel") { await close(); return; }
  if (method === "session/prompt") {
    const prompt = params.prompt[0].text; const mode = options[0].currentValue;
    record({ event: "prompt", mode, connections: clients.length, prompt });
    if (mode === "code") {
      if (clients.length !== 1) throw new Error("实现fixture需要一个MCP工具连接");
      const result = await clients[0].callTool({ name: "lookup_value", arguments: {} });
      const value = result.content.find(item => item.type === "text").text;
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: session_id, update: { sessionUpdate: "tool_call", toolCallId: "mcp-value", title: "MCP lookup_value", kind: "other", status: "completed" } } });
      writeFileSync(join(cwd, "value.txt"), value);
    } else if (readFileSync(join(cwd, "value.txt"), "utf8") !== "fixed") throw new Error("只读fixture业务值未修复");
    const report = "# Human review\n\n## 变更\nMCP工具结果用于修复业务值，保持代码Draft。\n\n## 验收\n以宿主实测与当前源码证据为准。\n\n## 风险\n离线fixture不证明真实模型或远端工具。\n";
    const text = prompt.startsWith("# Context Session Agent") ? JSON.stringify({ summary: "最新需求交付等待最终人工review", next_action: { kind: "wait", reason: "最终gate人工未决", evidence: [{ source: "workflow", id: "review" }] }, risks: [] }) : report;
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: session_id, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
    respond({ stopReason: "end_turn" });
  }
}
const lines = createInterface({ input: process.stdin }); let queue = Promise.resolve();
lines.on("line", line => { queue = queue.then(async () => {
  const request = JSON.parse(line); try { await message(request); } catch { if (request.id !== undefined) send({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "MCP fixture失败" } }); }
}); });
lines.on("close", () => { void queue.finally(async () => { await close(); process.exit(0); }); });
process.once("SIGTERM", async () => { await close(); process.exit(0); });
