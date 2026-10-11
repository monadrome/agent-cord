import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AcpDriver, type AgentEvent } from "../../src/index.js";
import { start_mcp_network_fixture } from "./fixtures/mcp-network-server.mjs";

const worker = fileURLToPath(new URL("./fixtures/acp-mcp-worker.mjs", import.meta.url));
let cwd: string; let services: Array<Awaited<ReturnType<typeof start_mcp_network_fixture>>>;
beforeEach(async () => { cwd = await mkdtemp(join(tmpdir(), "cord-mcp-network-")); services = []; });
afterEach(async () => { await Promise.all(services.map(service => service.close())); await rm(cwd, { recursive: true, force: true }); });
async function service(type: "http" | "sse", hang_tool = false) { const running = await start_mcp_network_fixture({ type, hang_tool }); services.push(running); return running; }
async function collect(events: AsyncIterable<AgentEvent>) { const result: AgentEvent[] = []; for await (const event of events) result.push(event); return result; }
async function wait(check: () => boolean, details: () => unknown = () => null) { const deadline = Date.now() + 5000; while (!check()) { if (Date.now() >= deadline) throw new Error("网络MCP连接未收束：" + JSON.stringify(details())); await new Promise(resolve => setTimeout(resolve, 20)); } }
function driver(type: "http" | "sse", url: string, token = "LOCAL_MCP_TOKEN", flags: string[] = []) {
  return new AcpDriver({ bin: process.execPath, args: [worker, "--network-transports", ...flags], launch: { mode: "code", option_ids: { mode: "workflow" } },
    readonly_launch: { mode: "plan", option_ids: { mode: "workflow" } }, mcp_servers: [{ type, name: "loopback", url, headers_from: { Authorization: "CORD_MCP_NETWORK_TOKEN" } }],
    env: { CORD_MCP_NETWORK_TOKEN: token }, kill_grace_ms: 100 });
}

describe("真实loopback HTTP/SSE MCP", () => {
  it.each(["http", "sse"] as const)("%s新session和指定load实际认证/工具生效并关闭连接", async type => {
    const remote = await service(type); const agent = driver(type, remote.url);
    for (const resume of [false, true]) {
      const events = await collect(resume ? agent.resume("fixed-network-session", { prompt: "使用真实本地工具", cwd }) : agent.run({ prompt: "使用真实本地工具", cwd }));
      expect(events.filter(event => event.type === "error")).toEqual([]); expect(events.some(event => event.type === "result")).toBe(true);
      expect(await readFile(join(cwd, "value.txt"), "utf8")).toBe("fixed"); expect(JSON.stringify(events)).not.toContain("LOCAL_MCP_TOKEN");
      await wait(() => remote.metrics.streams === 0 && remote.active_sessions() === 0);
    }
    expect(remote.metrics.tool_calls).toBe(2); expect(remote.metrics.authenticated).toBe(remote.metrics.requests); expect(remote.metrics.refused).toBe(0);
    if (type === "http") expect(remote.metrics.terminated).toBe(2);
  });

  it.each(["http", "sse"] as const)("%s服务拒绝header时固定失败，不调用工具/写代码", async type => {
    const remote = await service(type); const events = await collect(driver(type, remote.url, "PRIVATE_WRONG_TOKEN").run({ prompt: "p", cwd, timeout_ms: 5000 }));
    expect(events.find(event => event.type === "error")?.data).toMatchObject({ kind: "configuration", message: "ACP无法建立声明MCP工具配置的session" });
    expect(events.some(event => event.type === "result")).toBe(false); expect(JSON.stringify(events)).not.toContain("PRIVATE_WRONG_TOKEN");
    expect(remote.metrics.refused).toBeGreaterThan(0); expect(remote.metrics.tool_calls).toBe(0); expect(remote.active_sessions()).toBe(0);
    await expect(readFile(join(cwd, "value.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["http", "sse"] as const)("%s取消挂起工具收束请求，不返回成功；HTTP远端记录仍保留", async type => {
    const remote = await service(type, true); const controller = new AbortController(); const task = collect(driver(type, remote.url, "LOCAL_MCP_TOKEN", ["--retain-http-session"]).run({ prompt: "挂起工具", cwd, timeout_ms: 10000, signal: controller.signal }));
    await wait(() => remote.metrics.tool_calls === 1); controller.abort(); const events = await task;
    expect(events.some(event => event.type === "result")).toBe(false); await wait(() => remote.metrics.streams === 0 && remote.metrics.active_requests === 0,
      () => ({ ...remote.metrics, active_sessions: remote.active_sessions() }));
    if (type === "http") { expect(remote.active_sessions()).toBe(1); expect(remote.metrics.terminated).toBe(0); }
    else expect(remote.active_sessions()).toBe(0);
    expect(remote.metrics.tool_calls).toBe(1); await expect(readFile(join(cwd, "value.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["http", "sse"] as const)("%s inspect与默认readonly没有网络请求，后续执行才连接", async type => {
    const remote = await service(type); const agent = driver(type, remote.url);
    const observation = await agent.inspect(cwd); expect(observation.mcp_transports).toMatchObject({ http: true, sse: true, connections: "not_requested" });
    expect(remote.metrics.requests).toBe(0);
    expect((await collect(agent.run({ prompt: "初始化业务值", cwd }))).some(event => event.type === "result")).toBe(true);
    const count = remote.metrics.requests;
    const events = await collect(agent.run({ prompt: "只读报告", cwd, readonly: true })); expect(events.filter(event => event.type === "error")).toEqual([]);
    expect(remote.metrics.requests).toBe(count); expect(remote.metrics.tool_calls).toBe(1);
  });

  it.each(["http", "sse"] as const)("%s超时不提交工具结果，连接收束而不重试调用", async type => {
    const remote = await service(type, true); const running = collect(driver(type, remote.url, "LOCAL_MCP_TOKEN", ["--retain-http-session"]).run({ prompt: "超时工具", cwd, timeout_ms: 2000 }));
    await wait(() => remote.metrics.tool_calls === 1); const events = await running;
    expect(events.some(event => event.type === "error" && (event.data as { kind?: string }).kind === "timeout")).toBe(true);
    expect(events.some(event => event.type === "result")).toBe(false); await wait(() => remote.metrics.active_requests === 0 && remote.metrics.streams === 0);
    expect(remote.metrics.tool_calls).toBe(1); await expect(readFile(join(cwd, "value.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
