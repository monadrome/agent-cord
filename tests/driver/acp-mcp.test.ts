import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AcpDriver, AcpMcpServersSchema, createAgentRegistry, parseAgentsYaml, type AcpMcpServersInput, type AgentEvent } from "../../src/index.js";

const fixture = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url));
const worker_fixture = fileURLToPath(new URL("./fixtures/acp-mcp-worker.mjs", import.meta.url));
const mcp_fixture = fileURLToPath(new URL("./fixtures/mcp-value-server.mjs", import.meta.url));
let cwd: string; let record: string;
beforeEach(async () => { cwd = await mkdtemp(join(tmpdir(), "cord-acp-mcp-")); record = join(cwd, "requests.jsonl"); });
afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });
async function collect(events: AsyncIterable<AgentEvent>) { const result: AgentEvent[] = []; for await (const event of events) result.push(event); return result; }
const messages = async () => (await readFile(record, "utf8")).trim().split("\n").map(line => JSON.parse(line));
const servers = (): AcpMcpServersInput => [
  { type: "stdio", name: "stdio-value", command: process.execPath, args: [mcp_fixture, "--literal", "$(not-executed)"], env_from: { FIXTURE_VALUE: "CORD_MCP_VALUE" } },
  { type: "http", name: "http-value", url: "http://127.0.0.1:1/mcp", headers_from: { Authorization: "CORD_MCP_TOKEN" } },
  { type: "sse", name: "sse-value", url: "https://example.invalid/sse", headers_from: { "X-Token": "CORD_MCP_TOKEN" } },
];
function driver(mcp_servers: AcpMcpServersInput = servers(), flags: string[] = [], readonly_mcp_servers?: AcpMcpServersInput) { return new AcpDriver({ bin: process.execPath,
  args: [fixture, "--no-tools", "--record", record, ...flags], mcp_servers, ...(readonly_mcp_servers === undefined ? {} : { readonly_mcp_servers }),
  env: { CORD_MCP_VALUE: "fixed", CORD_MCP_TOKEN: "PRIVATE_MCP_TOKEN" }, kill_grace_ms: 100 }); }

describe("ACP MCP标准配置", () => {
  it.each([false, true])("实际新建/load传入所选连接与环境值，resume=%s", async resume => {
    const worker = driver(servers(), ["--mcp-http", "--mcp-sse"], [{ type: "stdio", name: "readonly-value", command: process.execPath }]);
    expect(worker.capabilities.mcp_configuration).toEqual({ writable_count: 3, readonly_count: 1, transports: ["http", "sse", "stdio"] });
    for (const readonly of [false, true]) {
      const task = { prompt: "latest", cwd, readonly };
      const events = await collect(resume ? worker.resume("fixed-mcp-session", task) : worker.run(task));
      expect(events.filter(event => event.type === "error")).toEqual([]);
      const request = (await messages()).filter(message => message.event === (resume ? "session/load" : "session/new")).at(-1);
      expect(request.mcpServers).toEqual(readonly ? [{ name: "readonly-value", command: process.execPath, args: [], env: [] }] : [
        { name: "stdio-value", command: process.execPath, args: [mcp_fixture, "--literal", "$(not-executed)"], env: [{ name: "FIXTURE_VALUE", value: "fixed" }] },
        { type: "http", name: "http-value", url: "http://127.0.0.1:1/mcp", headers: [{ name: "Authorization", value: "PRIVATE_MCP_TOKEN" }] },
        { type: "sse", name: "sse-value", url: "https://example.invalid/sse", headers: [{ name: "X-Token", value: "PRIVATE_MCP_TOKEN" }] },
      ]);
      if (resume) expect(request.sessionId).toBe("fixed-mcp-session");
      expect(JSON.stringify(events)).not.toContain("PRIVATE_MCP_TOKEN");
    }
  });

  it.each(["http", "sse"] as const)("未协商%s在session/new/load前失败且不回退空工具", async type => {
    const worker = driver([{ type, name: "endpoint", url: "https://example.invalid/mcp" }]);
    for (const resume of [false, true]) {
      const events = await collect(resume ? worker.resume("fixed", { prompt: "p", cwd }) : worker.run({ prompt: "p", cwd }));
      expect(events.some(event => event.type === "error" && (event.data as { kind?: string }).kind === "configuration")).toBe(true);
      expect(events.some(event => event.type === "result")).toBe(false);
    }
    expect((await messages()).some(row => ["session/new", "session/load", "prompt"].includes(row.event))).toBe(false);
  });

  it.each(["missing", "nul", "newline"])("引用%s值在session之前拒绝且错误不含原文", async mode => {
    const input = mode === "nul" ? [{ type: "stdio" as const, name: "tool", command: process.execPath, env_from: { TOKEN: "CORD_MCP_INVALID" } }]
      : [{ type: "http" as const, name: "tool", url: "https://example.invalid/mcp", headers_from: { Authorization: "CORD_MCP_INVALID" } }];
    const worker = new AcpDriver({ bin: process.execPath, args: [fixture, "--record", record, "--mcp-http"], mcp_servers: input,
      env: mode === "missing" ? {} : { CORD_MCP_INVALID: mode === "nul" ? "PRIVATE\0TOKEN" : "PRIVATE\r\nTOKEN" } });
    const events = await collect(worker.run({ prompt: "p", cwd }));
    expect(events.some(event => event.type === "error" && (event.data as { kind?: string }).kind === "configuration")).toBe(true);
    await expect(readFile(record)).rejects.toMatchObject({ code: "ENOENT" }); expect(JSON.stringify(events)).not.toContain("PRIVATE");
  });

  it("只读默认不继承执行工具；inspect返回传输声明但不连接/解析所配凭据", async () => {
    const worker = driver([{ type: "http", name: "private", url: "https://example.invalid/mcp", headers_from: { Authorization: "CORD_MCP_MISSING" } }]);
    const observation = await worker.inspect(cwd); const readonly = await worker.inspect(cwd, 5000, undefined, true);
    expect(observation.mcp_transports).toEqual({ stdio: "required", http: false, sse: false, connections: "not_requested" });
    expect(readonly.mcp_transports).toEqual(observation.mcp_transports);
    expect((await collect(worker.run({ prompt: "p", cwd, readonly: true }))).some(event => event.type === "result")).toBe(true);
    expect((await messages()).filter(row => row.event === "session/new").map(row => row.mcpServers)).toEqual([[], [], []]);
    expect((await messages()).filter(row => row.event === "prompt")).toHaveLength(1);
  });

  it.each([false, true])("session拒绝回显MCP凭据时归一固定错误，resume=%s", async resume => {
    const worker = driver([servers()[1]!], ["--mcp-http", "--reject-mcp"]);
    const events = await collect(resume ? worker.resume("fixed", { prompt: "p", cwd }) : worker.run({ prompt: "p", cwd }));
    expect(events.find(event => event.type === "error")?.data).toMatchObject({ kind: "configuration", message: "ACP无法建立声明MCP工具配置的session" });
    expect(JSON.stringify(events)).not.toContain("PRIVATE_MCP_TOKEN"); expect(JSON.stringify(events)).not.toContain("example");
    expect((await messages()).some(row => row.event === "prompt")).toBe(false);
  });

  it("严格列表拒绝非法配置而不回退同名内置；环境值不影响身份，映射/连接定义改变身份", () => {
    const valid = { type: "stdio", name: "value", command: process.execPath };
    const invalid = [[{ ...valid, command: "relative" }], [valid, valid], [{ ...valid, env_from: { TOKEN: "raw secret" } }],
      [{ type: "http", name: "x", url: "https://user:secret@example.invalid" }], [{ type: "http", name: "x", url: "file:///mcp" }], [{ type: "http", name: "x", url: "http:example.invalid" }],
      [{ type: "sse", name: "x", url: "https://example.invalid/#fragment" }], [{ type: "http", name: "x", url: "https://example.invalid", headers_from: { Authorization: "TOKEN", authorization: "OTHER" } }],
      [{ ...valid, env: { TOKEN: "PRIVATE" } }], [{ type: "acp", name: "x" }], Array.from({ length: 17 }, (_, n) => ({ ...valid, name: "x" + n }))];
    for (const value of invalid) {
      expect(AcpMcpServersSchema.safeParse(value).success).toBe(false);
      const registry = createAgentRegistry(parseAgentsYaml(JSON.stringify({ agents: { claude: { kind: "acp", bin: "wrapper", mcp_servers: value } } })).yaml);
      expect(registry.rejected).toContain("claude"); expect(() => registry.resolve("claude")).toThrow(/配置无效/);
      expect(registry.warnings.join("\n")).not.toContain("PRIVATE");
    }
    const original = driver(); const rotated = new AcpDriver({ bin: process.execPath, args: original.args, mcp_servers: servers(), env: { CORD_MCP_TOKEN: "ROTATED" } });
    expect(rotated.configuration_hash).toBe(original.configuration_hash);
    const changed = servers(); (changed[1] as { headers_from: Record<string, string> }).headers_from.Authorization = "OTHER";
    expect(driver(changed).configuration_hash).not.toBe(original.configuration_hash);
    expect(driver(servers(), [], [valid as AcpMcpServersInput[number]]).configuration_hash).not.toBe(original.configuration_hash);
    expect(new AcpDriver({ bin: "wrapper", mcp_servers: [], readonly_mcp_servers: [] }).configuration_hash).toBe(new AcpDriver({ bin: "wrapper" }).configuration_hash);
  });

  it("映射键序归一化、构造时深拷贝，调用方变更不能污染MCP启动快照", async () => {
    const input: AcpMcpServersInput = [{ type: "stdio", name: "snapshot", command: process.execPath, args: [mcp_fixture],
      env_from: { SECOND: "CORD_MCP_TOKEN", FIRST: "CORD_MCP_VALUE" } }];
    const original = driver(input); const reordered = driver([{ ...input[0]!, env_from: { FIRST: "CORD_MCP_VALUE", SECOND: "CORD_MCP_TOKEN" } } as AcpMcpServersInput[number]]);
    expect(reordered.configuration_hash).toBe(original.configuration_hash);
    const entry = input[0] as { args: string[]; env_from: Record<string, string> }; entry.args.push("--changed"); entry.env_from.FIRST = "MISSING";
    expect((await collect(original.run({ prompt: "p", cwd }))).some(event => event.type === "result")).toBe(true);
    const actual = (await messages()).find(row => row.event === "session/new").mcpServers[0];
    expect(actual.args).toEqual([mcp_fixture]); expect(actual.env).toEqual([{ name: "FIRST", value: "fixed" }, { name: "SECOND", value: "PRIVATE_MCP_TOKEN" }]);
    expect(driver(input).configuration_hash).not.toBe(original.configuration_hash);
  });

  it("显式只读MCP工具列表可启动，仍按只读任务清理且不继承执行列表", async () => {
    const log = join(cwd, "readonly-mcp.jsonl"); const pidfile = join(cwd, "readonly-mcp.pid");
    const worker = new AcpDriver({ bin: process.execPath, args: [worker_fixture], mcp_servers: [{ type: "http", name: "write-only", url: "https://example.invalid/mcp" }],
      readonly_mcp_servers: [{ type: "stdio", name: "explicit-readonly", command: process.execPath, args: [mcp_fixture, "--record", log, "--pid-file", pidfile] }] });
    await writeFile(join(cwd, "value.txt"), "fixed");
    const events = await collect(worker.run({ prompt: "只读任务", cwd, readonly: true })); expect(events.filter(event => event.type === "error")).toEqual([]);
    expect((await readFile(log, "utf8")).trim().split("\n").map(JSON.parse)).toEqual([{ event: "started" }]);
    const pid = Number(await readFile(pidfile, "utf8")); expect(() => process.kill(pid, 0)).toThrow();
  });

  it("官方MCP SDK真实stdio连接/tool结果生效，driver收束MCP子进程", async () => {
    const log = join(cwd, "mcp.jsonl"); const pidfile = join(cwd, "mcp.pid");
    const worker = new AcpDriver({ bin: process.execPath, args: [worker_fixture], launch: { mode: "code", option_ids: { mode: "workflow" } },
      mcp_servers: [{ type: "stdio", name: "value", command: process.execPath, args: [mcp_fixture, "--record", log, "--pid-file", pidfile], env_from: { FIXTURE_VALUE: "CORD_MCP_VALUE" } }], env: { CORD_MCP_VALUE: "fixed" } });
    const events = await collect(worker.run({ prompt: "利用MCP返回值修复业务值", cwd }));
    expect(events.filter(event => event.type === "error")).toEqual([]); expect(await readFile(join(cwd, "value.txt"), "utf8")).toBe("fixed");
    expect((await readFile(log, "utf8")).trim().split("\n").map(JSON.parse)).toEqual([{ event: "started" }, { event: "tool.called", tool: "lookup_value" }]);
    const pid = Number(await readFile(pidfile, "utf8")); expect(() => process.kill(pid, 0)).toThrow();
  });
});
