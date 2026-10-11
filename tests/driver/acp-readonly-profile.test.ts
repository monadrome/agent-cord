import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AcpDriver, createAgentRegistry, parseAgentsYaml, type AgentEvent, type AgentLaunch } from "../../src/index.js";
import { canonicalJson, sha256Hex } from "../../src/core/hash.js";

const fixture = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url));
const ids = { provider: "provider", model: "llm", effort: "thinking", mode: "workflow" };
const launch: AgentLaunch = { provider: "anthropic", model: "large", effort: "high", mode: "code", option_ids: ids, config_options: { extended: true } };
const readonly_launch: AgentLaunch = { provider: "openai", model: "small", effort: "low", mode: "plan", option_ids: ids };
let cwd: string; let record: string;
beforeEach(async () => { cwd = await mkdtemp(join(tmpdir(), "cord-acp-profile-")); record = join(cwd, "messages.jsonl"); });
afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });
const args = () => [fixture, "--config", "--config-mode", "--config-only", "--provider-option", "--no-tools", "--record", record];
function worker(profile: AgentLaunch = readonly_launch, flags: string[] = []) { return new AcpDriver({ bin: process.execPath, args: [...args(), ...flags], launch, readonly_launch: profile, kill_grace_ms: 100 }); }
async function collect(source: AsyncIterable<AgentEvent>) { const events: AgentEvent[] = []; for await (const event of source) events.push(event); return events; }
const messages = async () => (await readFile(record, "utf8")).trim().split("\n").map(line => JSON.parse(line));

describe("ACP完整只读启动配置", () => {
  it.each([false, true])("可写/只读选择独立配置并保留指定session，resume=%s", async resume => {
    const driver = worker(); expect(driver.capabilities.readonly_configuration).toBe("explicit");
    for (const readonly of [false, true]) {
      const count = await messages().then(value => value.length).catch(() => 0);
      const task = { prompt: "LATEST_PROFILE_INPUT", cwd, readonly };
      const events = await collect(resume ? driver.resume("fixed-profile-session", task) : driver.run(task));
      expect(events.filter(event => event.type === "error")).toEqual([]); expect(events.some(event => event.type === "result")).toBe(true);
      const facts = (await messages()).slice(count);
      expect(facts.filter(fact => fact.event === "session/set_config_option").map(fact => [fact.configId, fact.value])).toEqual(readonly
        ? [["workflow", "plan"], ["provider", "openai"], ["llm", "small"], ["thinking", "low"]]
        : [["workflow", "code"], ["provider", "anthropic"], ["extended", true], ["llm", "large"], ["thinking", "high"]]);
      expect(facts.at(-1)).toMatchObject({ event: "prompt", text: "LATEST_PROFILE_INPUT" });
      if (resume) { expect(facts.find(fact => fact.event === "session/load").sessionId).toBe("fixed-profile-session"); expect(facts.some(fact => fact.event === "session/new")).toBe(false); }
    }
  });

  it("只读配置是完整替换，省略model/provider不继承可写选择或扩展", async () => {
    const events = await collect(worker({ mode: "plan", option_ids: { mode: "workflow" } }).run({ prompt: "p", cwd, readonly: true }));
    expect(events.some(event => event.type === "error")).toBe(false);
    expect((await messages()).filter(fact => fact.event === "session/set_config_option").map(fact => [fact.configId, fact.value])).toEqual([["workflow", "plan"]]);
  });

  it.each(["mode", "extension", "missing_id", "duplicate_id", "overlap", "unsupported"])("readonly_launch的%s错误在注册时拒绝且无进程", async mode => {
    const profile: AgentLaunch = mode === "mode" ? { mode: "code" } : mode === "extension" ? { config_options: { extended: true } }
      : mode === "missing_id" ? { model: "small" } : mode === "duplicate_id" ? { ...readonly_launch, option_ids: { ...ids, effort: "llm" } }
      : mode === "overlap" ? { ...readonly_launch, config_options: { llm: "small" } } : { auto: true };
    const pid = join(cwd, "pid"); expect(() => worker(profile, ["--pid-file", pid])).toThrow();
    await expect(readFile(pid)).rejects.toMatchObject({ code: "ENOENT" });
    const registry = createAgentRegistry(parseAgentsYaml(JSON.stringify({ agents: { claude: { kind: "acp", bin: "wrapper", readonly_launch: profile } } })).yaml);
    expect(registry.rejected).toContain("claude"); expect(() => registry.resolve("claude")).toThrow(/配置无效/);
  });

  it("独立只读选项不存在或执行漂移仍取消，不返回成功结果", async () => {
    const unsupported = await collect(worker({ ...readonly_launch, model: "missing" }).run({ prompt: "p", cwd, readonly: true }));
    expect(unsupported.some(event => event.type === "error")).toBe(true); expect((await messages()).some(fact => fact.event === "prompt")).toBe(false);
    const events = await collect(worker({ ...readonly_launch, provider: "anthropic" }, ["--mode", "drift-provider"]).run({ prompt: "p", cwd, readonly: true }));
    expect(events.some(event => event.type === "error" && (event.data as { kind?: string }).kind === "configuration")).toBe(true);
    expect(events.some(event => event.type === "result")).toBe(false);
  });

  it("两种inspect核验各自profile，不发prompt/worker回调；未声明时旧readonly拒绝兼容", async () => {
    let sessions = 0; const driver = new AcpDriver({ bin: process.execPath, args: [...args(), "--mode", "mode-dependent-model"], launch, readonly_launch, onSession: () => sessions++ });
    const writable = await driver.inspect(cwd); const readonly = await driver.inspect(cwd, 5000, undefined, true);
    expect(writable.config_options.find(option => option.id === "llm")?.values).toEqual(["small", "large"]);
    expect(readonly.config_options.find(option => option.id === "llm")?.values).toEqual(["small"]);
    expect((await messages()).some(fact => fact.event === "prompt")).toBe(false); expect(sessions).toBe(0);
    const old = new AcpDriver({ bin: process.execPath, args: args(), launch });
    expect(old.capabilities).not.toHaveProperty("readonly_configuration");
    await expect(old.inspect(cwd, 5000, undefined, true)).rejects.toThrow(/核验失败/);
    expect((await collect(old.run({ prompt: "p", cwd, readonly: true }))).some(event => event.type === "error")).toBe(true);
  });

  it("任意分支变化改变身份，输入对象修改不污染原driver；无profile旧hash兼容", async () => {
    const supplied = structuredClone(readonly_launch); const original = worker(supplied); supplied.effort = "high";
    const changed = worker(supplied); expect(changed.configuration_hash).not.toBe(original.configuration_hash);
    const writable_changed = new AcpDriver({ bin: process.execPath, args: args(), launch: { ...launch, model: "small" }, readonly_launch });
    expect(writable_changed.configuration_hash).not.toBe(original.configuration_hash);
    expect((await collect(original.run({ prompt: "p", cwd, readonly: true }))).some(event => event.type === "result")).toBe(true);
    expect((await messages()).find(fact => fact.configId === "thinking").value).toBe("low");
    const legacy = new AcpDriver({ bin: process.execPath, args: args(), launch });
    expect(legacy.configuration_hash).toBe(sha256Hex(canonicalJson({ domain: "cord.agent-config.acp.v5", launch_state_policy: "explicit-session-selections.provider-first.v1",
      launch, name: `acp:${process.execPath}`, bin: process.execPath, args: args() })));
    const headless = createAgentRegistry(parseAgentsYaml('agents: { x: { kind: headless, template: claude, readonly_launch: { mode: plan } } }').yaml);
    expect(headless.rejected).toContain("x");
  });
});
