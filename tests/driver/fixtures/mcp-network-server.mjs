// 官方MCP SDK loopback服务；仅记录认证判定，不记录请求header/工具凭据。
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

export async function start_mcp_network_fixture({ type, token = "LOCAL_MCP_TOKEN", value = "fixed", hang_tool = false }) {
  const sessions = new Map(); const metrics = { requests: 0, authenticated: 0, refused: 0, tool_calls: 0, streams: 0, active_requests: 0, terminated: 0 };
  const pending_tools = new Set(); const connections = new Set(); const app = createMcpExpressApp();
  function tool_server() {
    const server = new McpServer({ name: "loopback-value", version: "1" });
    server.registerTool("lookup_value", { description: "返回本地确定业务值", inputSchema: {} }, async () => {
      metrics.tool_calls++;
      if (hang_tool) await new Promise(resolve => pending_tools.add(resolve));
      return { content: [{ type: "text", text: value }] };
    });
    return server;
  }
  app.use((req, res, next) => {
    metrics.requests++;
    metrics.active_requests++; res.once("close", () => metrics.active_requests--);
    if (req.headers.authorization !== token) { metrics.refused++; res.status(403).send("认证失败"); return; }
    metrics.authenticated++; next();
  });
  app.all("/mcp", async (req, res) => {
    if (type !== "http") { res.sendStatus(404); return; }
    try {
      let entry = sessions.get(req.headers["mcp-session-id"]);
      if (!entry && req.method === "POST" && isInitializeRequest(req.body)) {
        const server = tool_server();
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID,
          onsessioninitialized: id => sessions.set(id, { server, transport }) });
        await server.connect(transport);
        const prior_close = transport.onclose;
        transport.onclose = () => { prior_close?.(); sessions.delete(transport.sessionId); metrics.terminated++; };
        entry = { server, transport };
      }
      if (!entry) { res.sendStatus(400); return; }
      if (req.method === "GET") { metrics.streams++; res.once("close", () => metrics.streams--); }
      await entry.transport.handleRequest(req, res, req.body);
    } catch { if (!res.headersSent) res.sendStatus(500); }
  });
  app.get("/sse", async (_req, res) => {
    if (type !== "sse") { res.sendStatus(404); return; }
    const transport = new SSEServerTransport("/messages", res); const server = tool_server();
    sessions.set(transport.sessionId, { server, transport }); metrics.streams++;
    res.once("close", () => { sessions.delete(transport.sessionId); metrics.streams--; });
    try { await server.connect(transport); } catch { if (!res.headersSent) res.sendStatus(500); }
  });
  app.post("/messages", async (req, res) => {
    const entry = sessions.get(req.query.sessionId);
    if (!entry || type !== "sse") { res.sendStatus(404); return; }
    try { await entry.transport.handlePostMessage(req, res, req.body); }
    catch { if (!res.headersSent) res.sendStatus(500); }
  });
  const http = app.listen(0, "127.0.0.1");
  http.on("connection", connection => { connections.add(connection); connection.once("close", () => connections.delete(connection)); });
  await new Promise((resolve, reject) => { http.once("listening", resolve); http.once("error", reject); });
  const port = http.address().port;
  return { url: `http://127.0.0.1:${port}/${type === "http" ? "mcp" : "sse"}`, metrics,
    active_sessions: () => sessions.size,
    async close() {
      for (const release of pending_tools) release(); pending_tools.clear();
      await Promise.allSettled([...sessions.values()].map(entry => entry.server.close())); sessions.clear();
      const closed = new Promise((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
      for (const connection of connections) connection.destroy(); await closed;
    },
  };
}
