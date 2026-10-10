import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AcpDriver, HeadlessDriver, createAgentRegistry, parseAgentsYaml, type AgentEvent, type AgentLaunch } from "../../src/index.js";
import { custom_headless_template } from "../../src/driver/custom-template.js";

const cli = fileURLToPath(new URL("./fixtures/fake-cli.mjs", import.meta.url));
const acp = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url));
let cwd: string; let record: string;
beforeEach(async () => { cwd = await mkdtemp(join(tmpdir(), "cord-launch-")); record = join(cwd, "messages.jsonl"); });
afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });
async function collect(source: AsyncIterable<AgentEvent>) { const events: AgentEvent[] = []; for await (const event of source) events.push(event); return events; }
async function messages() { return (await readFile(record, "utf8")).trim().split("\n").map(line => JSON.parse(line)); }
const launch: AgentLaunch = { model: "large", effort: "high", option_ids: { model: "llm", effort: "thinking" } };
function driver(profile: AgentLaunch = launch, flags: string[] = []) { return new AcpDriver({ bin: process.execPath, args: [acp, "--config", "--record", record, ...flags], launch: profile, kill_grace_ms: 100 }); }

describe("严格 agent 启动与能力识别", () => {
  it("Claude bare/auto/model/effort 进入实际 argv，readonly 强制 plan", async () => {
    const worker = new HeadlessDriver({ cli: "claude", bin: process.execPath, prefixArgs: [cli], launch: { bare: true, auto: true, model: "test-model", effort: "high" } });
    expect(worker.capabilities).toMatchObject({ transport: "headless", installation: "unchecked", native_resume: "supported", goal: "host" });
    const events = await collect(worker.run({ prompt: "work", cwd }));
    const argv = events.map(event => (event.data as any).raw?.argv).find(value => Array.isArray(value)) as string[];
    expect(argv).toContain("--bare"); expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("auto");
    expect(argv[argv.indexOf("--model") + 1]).toBe("test-model");
    const readonly = worker.buildArgv({ prompt: "review", cwd, readonly: true }, "known-session");
    expect(readonly).toContain("--fork-session"); expect(readonly).toContain("plan"); expect(readonly).not.toContain("auto");
    expect(readonly[readonly.indexOf("--resume") + 1]).toBe("known-session");
    const extended = new HeadlessDriver({ cli: "claude", launch: { max_turns: 4, budget_usd: 2, agent: "architect", agents_json: "{}", system_prompt: "role" } }).buildArgv({ prompt: "p", cwd });
    expect(extended).toContain("--max-turns"); expect(extended).toContain("--max-budget-usd"); expect(extended).toContain("--agent");
  });

  it("不支持的显式 launch 拒绝注册，不能退回同名内置配置", () => {
    for (const [name, spec] of [["codex", "kind: headless, template: codex, launch: { bare: true }"], ["kimi", "kind: headless, template: kimi, launch: { effort: high }"], ["claude", "kind: acp, bin: wrapper, launch: { auto: true }"]]) {
      const registry = createAgentRegistry(parseAgentsYaml(`agents: { ${name}: { ${spec} } }`).yaml);
      expect(registry.rejected).toContain(name); expect(() => registry.resolve(name!)).toThrow(/配置无效/);
    }
    expect(() => new HeadlessDriver({ cli: "claude", knobs: { model: "old" }, launch: { model: "new" } })).toThrow(/重复/);
  });

  it("自定义 wrapper 显式模型/effort/session 映射，用户文本不二次展开", async () => {
    const template = custom_headless_template("custom", process.execPath,
      [cli, "--model", "{{model}}", "--effort", "{{effort}}", "-p", "{{prompt}}"],
      [cli, "--session", "{{resume_session_id}}", "--model", "{{model}}", "--effort", "{{effort}}", "-p", "{{prompt}}"]);
    const worker = new HeadlessDriver({ cli: "custom", template, launch: { model: "{{prompt}}", effort: "high" } });
    const events = await collect(worker.resume("session-fixed", { prompt: "{{model}} $(literal)", cwd }));
    const argv = events.map(event => (event.data as any).raw?.argv).find(value => Array.isArray(value));
    expect(argv).toContain("session-fixed"); expect(argv).toContain("{{prompt}}"); expect(argv).toContain("{{model}} $(literal)");
  });

  it("未知占位、缺失启动值、非完整 resume 映射均阻断", async () => {
    expect(() => custom_headless_template("x", "x", ["{{unknown}}"])).toThrow(/未知/);
    expect(() => custom_headless_template("x", "x", ["{{resume_session_id}}"])).toThrow(/resume_args/);
    expect(() => custom_headless_template("x", "x", ["{{model}}"], ["{{resume_session_id}}"])).toThrow(/映射/);
    expect(() => new HeadlessDriver({ cli: "x", template: custom_headless_template("x", "x", ["{{model}}"])})).toThrow(/缺少启动值/);
    const worker = new HeadlessDriver({ cli: "x", template: custom_headless_template("x", "x", ["{{prompt}}"]) });
    expect(worker.capabilities.native_resume).toBe("unsupported");
    await expect(collect(worker.resume("id", { prompt: "p", cwd }))).rejects.toThrow(/不支持/);
  });

  it("模型/effort/上下文/权限改变启动身份，环境凭据不进入身份", () => {
    const original = new HeadlessDriver({ cli: "claude" }).configuration_hash;
    for (const profile of [{ model: "m" }, { effort: "high" }, { bare: true }, { auto: true }]) expect(new HeadlessDriver({ cli: "claude", launch: profile }).configuration_hash).not.toBe(original);
    expect(new HeadlessDriver({ cli: "claude", env: { SECRET: "a" } }).configuration_hash).toBe(new HeadlessDriver({ cli: "claude", env: { SECRET: "b" } }).configuration_hash);
    expect(driver(launch).configuration_hash).not.toBe(driver({ ...launch, effort: "low" }).configuration_hash);
  });

  it("ACP 精确 ID 选择 grouped model、effort、mode 和 boolean，再发送 prompt", async () => {
    const events = await collect(driver({ ...launch, mode: "code", config_options: { extended: true } }).run({ prompt: "work", cwd }));
    expect(events.some(event => event.type === "error")).toBe(false);
    const facts = await messages(); const settings = facts.filter(fact => fact.event === "session/set_config_option");
    expect(settings.map(fact => [fact.configId, fact.value])).toEqual([["extended", true], ["llm", "large"], ["thinking", "high"]]);
    expect(settings[0].type).toBe("boolean");
    expect(facts[0].clientCapabilities).toMatchObject({ session: { configOptions: { boolean: {} } } });
    expect(facts.findIndex(fact => fact.event === "session/set_mode")).toBeLessThan(facts.findIndex(fact => fact.event === "prompt"));
    expect(facts.at(-1).event).toBe("prompt");
  });

  it.each(["unsupported_value", "unknown_id", "wrong_type", "missing_config", "ignore-config", "reset-config", "reject-config", "unknown_mode"])("ACP %s 在 prompt 前失败", async scenario => {
    const profile: AgentLaunch = scenario === "unsupported_value" ? { ...launch, model: "missing" }
      : scenario === "unknown_id" ? { ...launch, option_ids: { ...launch.option_ids, model: "unknown" } }
      : scenario === "wrong_type" ? { config_options: { extended: "true" } }
      : scenario === "unknown_mode" ? { mode: "unknown" } : launch;
    const worker = scenario === "missing_config" ? new AcpDriver({ bin: process.execPath, args: [acp, "--record", record], launch: profile }) : driver(profile, ["--mode", scenario]);
    const events = await collect(worker.run({ prompt: "work", cwd }));
    expect(events.some(event => event.type === "error")).toBe(true);
    expect((await messages()).some(fact => fact.event === "prompt")).toBe(false);
  });

  it("ACP 不猜配置 ID，不接受重复 ID，readonly 拒绝扩展与非 plan mode", async () => {
    expect(() => driver({ model: "large" })).toThrow(/option_ids/);
    expect(() => driver({ ...launch, option_ids: { model: "llm", effort: "llm" } })).toThrow(/相同/);
    expect(() => driver({ ...launch, config_options: { llm: "small" } })).toThrow(/重复/);
    for (const profile of [{ mode: "code" }, { config_options: { extended: true } }]) {
      expect((await collect(driver(profile).run({ prompt: "review", cwd, readonly: true }))).some(event => event.type === "error")).toBe(true);
    }
    expect((await messages()).some(fact => fact.event === "prompt")).toBe(false);
  });

  it("ACP session resume 必须协商 loadSession，恢复后重新应用所需模型", async () => {
    const rejected = await collect(driver(launch, ["--no-resume"]).resume("known-session", { prompt: "work", cwd }));
    expect(rejected.some(event => event.type === "error")).toBe(true);
    expect((await messages()).some(fact => ["session/load", "prompt"].includes(fact.event))).toBe(false);
    const events = await collect(driver().resume("known-session", { prompt: "work", cwd }));
    expect(events.some(event => event.type === "result")).toBe(true);
    expect((await messages()).find(fact => fact.event === "session/load").sessionId).toBe("known-session");
  });

  it("ACP 原子能力查询只协商，不调用模型 prompt", async () => {
    const observation = await driver().inspect(cwd);
    expect(observation).toMatchObject({ evidence: "acp_handshake", protocol_version: 1, native_resume: true, modes: ["plan", "code"] });
    expect(observation.config_options.map(option => option.id)).toEqual(["llm", "thinking", "extended"]);
    expect(observation.config_options[0]).toMatchObject({ category: "model", values: ["small", "large"], omitted_values: 0 });
    expect((await messages()).some(fact => fact.event === "prompt")).toBe(false);
  });

  it("ACP 大能力列表限制输出并明确省略数，不把样本当全集", async () => {
    const observation = await driver({}, ["--large-capabilities"]).inspect(cwd);
    expect(observation.modes).toHaveLength(128); expect(observation.omitted_modes).toBe(14);
    expect(observation.config_options).toHaveLength(128); expect(observation.omitted_options).toBe(15);
    expect(observation.config_options[0]!.values).toHaveLength(128); expect(observation.config_options[0]!.omitted_values).toBe(12);
    expect((await messages()).some(fact => fact.event === "prompt")).toBe(false);
  });

  it("ACP 协商超时收束子进程，后续查询可恢复", async () => {
    const pid_file = join(cwd, "pid");
    await expect(driver({}, ["--mode", "hang-init", "--pid-file", pid_file]).inspect(cwd, 1000)).rejects.toThrow(/协商/);
    const pid = Number(await readFile(pid_file, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
    expect((await driver({}).inspect(cwd)).evidence).toBe("acp_handshake");
    expect((await messages()).some(fact => fact.event === "prompt")).toBe(false);
  });

  it.each(["--permission-on-new", "--tool-on-new"])("能力查询遇到 %s 不使用 worker 预授权，拒绝并收束", async flag => {
    let asked = false;
    const worker = new AcpDriver({ bin: process.execPath, args: [acp, "--record", record, flag],
      decidePermission: () => { asked = true; return { optionId: "allow-once" }; } });
    await expect(worker.inspect(cwd)).rejects.toThrow(/能力/);
    expect(asked).toBe(false); expect((await messages()).some(fact => fact.event === "prompt")).toBe(false);
  });
});
