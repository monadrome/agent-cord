import { execa } from "execa";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AcpDriver, HeadlessDriver, type AgentDriver, type AgentEvent } from "../../src/index.js";
import { custom_headless_template } from "../../src/driver/custom-template.js";

vi.mock("execa", async import_original => {
  const actual = await import_original<typeof import("execa")>();
  return { ...actual, execa: vi.fn(actual.execa) };
});

const cli = fileURLToPath(new URL("./fixtures/fake-cli.mjs", import.meta.url));
const acp = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url));
const inspection = fileURLToPath(new URL("./fixtures/cli-inspection.mjs", import.meta.url));
let cwd: string;
beforeEach(async () => { cwd = await mkdtemp(join(tmpdir(), "cord-task-preflight-")); vi.mocked(execa).mockClear(); });
afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });
async function collect(source: AsyncIterable<AgentEvent>) {
  const events: AgentEvent[] = []; for await (const event of source) events.push(event); return events;
}
function driver(transport: "acp" | "headless"): AgentDriver {
  return transport === "acp"
    ? new AcpDriver({ bin: process.execPath, args: [acp, "--no-tools", "--record", join(cwd, "rpc.jsonl")], kill_grace_ms: 50 })
    : new HeadlessDriver({ cli: "claude", bin: process.execPath, prefixArgs: [cli, "--no-tools"], kill_grace_ms: 50 });
}
const modes = [
  { transport: "acp" as const, resume: false }, { transport: "acp" as const, resume: true },
  { transport: "headless" as const, resume: false }, { transport: "headless" as const, resume: true },
];

describe("Agent任务启动前校验", () => {
  it.each(modes)("$transport/$resume取消优先，创建迭代器前后取消均零spawn", async mode => {
    const agent = driver(mode.transport);
    for (const before of [true, false]) {
      const controller = new AbortController();
      if (before) controller.abort();
      const task = { prompt: "不应执行", cwd, signal: controller.signal };
      const source = mode.resume ? agent.resume("fixed-session", task) : agent.run(task);
      if (!before) controller.abort();
      const events = await collect(source);
      expect(events).toHaveLength(1); expect(events[0]).toMatchObject({ type: "error", data: { kind: "agent" } });
      expect(vi.mocked(execa).mock.calls.length).toBe(0);
    }
    expect((await collect(agent.run({ prompt: "恢复正常执行", cwd }))).some(event => event.type === "result")).toBe(true);
    expect(vi.mocked(execa).mock.calls.length).toBe(1);
  });

  it.each(modes)("$transport/$resume非法超时不创建进程，合法预算可继续执行", async mode => {
    const agent = driver(mode.transport);
    for (const timeout_ms of [0, -1, 1.5, NaN, Infinity, 2_147_483_648, "1000", null]) {
      const task = { prompt: "非法预算", cwd, timeout_ms: timeout_ms as number };
      const events = await collect(mode.resume ? agent.resume("fixed-session", task) : agent.run(task));
      expect(events).toHaveLength(1); expect(events[0]).toMatchObject({ type: "error", data: { kind: "configuration" } });
      expect(vi.mocked(execa).mock.calls.length).toBe(0);
    }
    const task = { prompt: "有效预算", cwd, timeout_ms: 2_147_483_647 };
    expect((await collect(mode.resume ? agent.resume("fixed-session", task) : agent.run(task))).some(event => event.type === "result")).toBe(true);
    expect(vi.mocked(execa).mock.calls.length).toBe(1);
  });

  it.each(["claude", "codex", "kimi"])("%s明确session不能成为CLI选项，非法值零spawn且不输出原值", async cli_name => {
    const agent = new HeadlessDriver({ cli: cli_name, bin: process.execPath, prefixArgs: [cli, "--no-tools"] });
    for (const session_id of ["", " \t ", "--last", "-", "--dangerously-bypass-approvals-and-sandbox", "PRIVATE\nSESSION", "PRIVATE\x7fSESSION", null, 1]) {
      const task = { prompt: "明确恢复", cwd };
      expect(() => agent.buildArgv(task, session_id as string)).toThrow(/session/);
      await expect(collect(agent.resume(session_id as string, task))).rejects.toThrow(/session/);
      expect(vi.mocked(execa).mock.calls.length).toBe(0);
    }
    await expect(collect(agent.resume(undefined as unknown as string, { prompt: "p", cwd }))).rejects.toThrow(/session/);
    expect(vi.mocked(execa).mock.calls.length).toBe(0);
    const session_id = "指定 session α $(literal)";
    const events = await collect(agent.resume(session_id, { prompt: "p", cwd }));
    const argv = events.map(event => (event.data as { raw?: { argv?: string[] } }).raw?.argv).find(Array.isArray)!;
    expect(argv).toContain(session_id); expect(events.some(event => event.type === "result")).toBe(true);
    expect(vi.mocked(execa).mock.calls.length).toBe(1);
  });

  it("ACP拒绝无效session但保留不透明ID的前缀/空格，不降级new", async () => {
    const agent = driver("acp");
    for (const session_id of ["", " \t ", "PRIVATE\nSESSION", "PRIVATE\x7fSESSION", null, 1, undefined]) {
      const events = await collect(agent.resume(session_id as string, { prompt: "p", cwd }));
      expect(events).toHaveLength(1); expect(events[0]).toMatchObject({ type: "error", data: { kind: "configuration" } });
      expect(JSON.stringify(events)).not.toContain("PRIVATE"); expect(vi.mocked(execa).mock.calls.length).toBe(0);
    }
    const session_id = "-opaque session α";
    expect((await collect(agent.resume(session_id, { prompt: "恢复", cwd }))).some(event => event.type === "result")).toBe(true);
    const facts = (await readFile(join(cwd, "rpc.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(facts.find(fact => fact.event === "session/load")).toMatchObject({ sessionId: session_id });
    expect(facts.some(fact => fact.event === "session/new")).toBe(false);
  });

  it("已取消任务即使预算/session/MCP无效也仅返回取消，不读取凭据或spawn", async () => {
    const controller = new AbortController(); controller.abort();
    const agent = new AcpDriver({ bin: process.execPath, args: [acp], mcp_servers: [{ name: "test", type: "stdio", command: "/unreachable", env_from: { AUTH: "CORD_PREFLIGHT_MISSING_SECRET" } }] });
    const events = await collect(agent.resume("", { prompt: "p", cwd, timeout_ms: NaN, signal: controller.signal }));
    expect(events).toHaveLength(1); expect(events[0]).toMatchObject({ type: "error", data: { kind: "agent" } }); expect(vi.mocked(execa).mock.calls.length).toBe(0);
  });

  it("帮助查询非法超时不探测，正常查询仍只使用version/help", async () => {
    const agent = new HeadlessDriver({ cli: "claude", bin: process.execPath,
      prefixArgs: [inspection, "--profile", "claude", "--record", join(cwd, "probes.jsonl"), "--probe-args"] });
    for (const timeout_ms of [0, -1, NaN, Infinity, 1.5, 2_147_483_648]) {
      await expect(agent.inspect(cwd, timeout_ms)).rejects.toThrow(/timeout_ms/); expect(vi.mocked(execa).mock.calls.length).toBe(0);
    }
    expect(await agent.inspect(cwd)).toMatchObject({ status: "passed" }); expect(vi.mocked(execa).mock.calls.length).toBe(2);
  });

  it("自定义完整恢复分支也拒绝--last，合法session逐字进入只读恢复argv", async () => {
    const args = [cli, "--no-tools", "--readonly", "{{readonly}}", "-p", "{{prompt}}"];
    const template = custom_headless_template("custom", process.execPath, args, [...args, "--session", "{{resume_session_id}}"]);
    const agent = new HeadlessDriver({ cli: "custom", template });
    await expect(collect(agent.resume("--last", { prompt: "p", cwd, readonly: true }))).rejects.toThrow(/session/);
    expect(vi.mocked(execa).mock.calls.length).toBe(0);
    const session_id = "named session $(literal)";
    const events = await collect(agent.resume(session_id, { prompt: "p", cwd, readonly: true }));
    const argv = events.map(event => (event.data as { raw?: { argv?: string[] } }).raw?.argv).find(Array.isArray)!;
    expect(argv[argv.indexOf("--session") + 1]).toBe(session_id); expect(argv[argv.indexOf("--readonly") + 1]).toBe("true");
    expect(events.some(event => event.type === "result")).toBe(true);
  });

  it("参数编译期间被取消也零spawn，旧配置身份和后续合法执行保留", async () => {
    const controller = new AbortController();
    const agent = new HeadlessDriver({ cli: "custom", template: { name: "custom", bin: process.execPath, args: ({ prompt }) => {
      if (prompt === "cancel-during-argv") controller.abort();
      return [cli, "--no-tools", "-p", prompt];
    } } });
    const hash = agent.configuration_hash;
    const events = await collect(agent.run({ prompt: "cancel-during-argv", cwd, signal: controller.signal }));
    expect(events).toHaveLength(1); expect(events[0]).toMatchObject({ type: "error", data: { kind: "agent" } });
    expect(vi.mocked(execa).mock.calls.length).toBe(0);
    expect((await collect(agent.run({ prompt: "next-valid-task", cwd }))).some(event => event.type === "result")).toBe(true);
    expect(agent.configuration_hash).toBe(hash);
  });

  it("ACP能力查询非法预算也零spawn；已取消查询保持取消优先", async () => {
    const agent = driver("acp") as AcpDriver;
    for (const timeout_ms of [0, NaN, Infinity, 2_147_483_648]) {
      await expect(agent.inspect(cwd, timeout_ms)).rejects.toThrow(/核验失败/);
      expect(vi.mocked(execa).mock.calls.length).toBe(0);
    }
    const controller = new AbortController(); controller.abort();
    await expect(agent.inspect(cwd, NaN, controller.signal)).rejects.toThrow(/取消/);
    expect(vi.mocked(execa).mock.calls.length).toBe(0);
    expect(await agent.inspect(cwd)).toMatchObject({ evidence: "acp_handshake" });
    const facts = (await readFile(join(cwd, "rpc.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(facts.some(fact => fact.event === "prompt")).toBe(false);
  });
});
