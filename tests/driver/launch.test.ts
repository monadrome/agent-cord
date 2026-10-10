import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AcpDriver, HeadlessDriver, createAgentRegistry, parseAgentsYaml, type AgentEvent, type AgentLaunch } from "../../src/index.js";
import { custom_headless_template } from "../../src/driver/custom-template.js";
import { canonicalJson, sha256Hex } from "../../src/core/hash.js";

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
    expect(() => driver({ ...launch, mode: "code", option_ids: { ...launch.option_ids, mode: "llm" } })).toThrow(/相同/);
    for (const profile of [{ mode: "code" }, { config_options: { extended: true } }]) {
      expect((await collect(driver(profile).run({ prompt: "review", cwd, readonly: true }))).some(event => event.type === "error")).toBe(true);
    }
    expect((await messages()).some(fact => fact.event === "prompt")).toBe(false);
  });

  it("配置状态核验策略改变显式 launch 身份，未声明 launch 的默认配置兼容", () => {
    const hash = driver().configuration_hash;
    expect(hash).toBe(driver().configuration_hash);
    const legacy_hash = sha256Hex(canonicalJson({ domain: "cord.agent-config.acp.v4", launch,
      name: `acp:${process.execPath}`, bin: process.execPath, args: [acp, "--config", "--record", record] }));
    expect(hash).not.toBe(legacy_hash);
    const default_hash = new AcpDriver({ bin: "test-agent", args: ["acp"] }).configuration_hash;
    expect(new AcpDriver({ bin: "test-agent", args: ["acp"], launch: {} }).configuration_hash).toBe(default_hash);
    expect(driver({ ...launch, mode: "code", option_ids: { ...launch.option_ids, mode: "workflow" } }).configuration_hash).not.toBe(hash);
  });

  it("相同扩展配置的 YAML 键序不改变实际设置顺序或配置身份", async () => {
    const first = driver({ config_options: { extra: true, extended: true } }, ["--extra-config", "--no-tools"]);
    const second = driver({ config_options: { extended: true, extra: true } }, ["--extra-config", "--no-tools"]);
    expect(first.configuration_hash).toBe(second.configuration_hash);
    for (const worker of [first, second]) expect((await collect(worker.run({ prompt: "work", cwd }))).some(event => event.type === "result")).toBe(true);
    expect((await messages()).filter(fact => fact.event === "session/set_config_option").map(fact => fact.configId)).toEqual(["extended", "extra", "extended", "extra"]);
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

  it.each(["drift-model", "drift-effort", "drift-restored", "remove-option", "change-type", "invalid-default"])("ACP 执行中 %s 不能返回成功结果", async scenario => {
    const events = await collect(driver(launch, ["--mode", scenario, "--no-tools"]).run({ prompt: "work", cwd }));
    expect(events.some(event => event.type === "error" && (event.data as any).kind === "configuration")).toBe(true);
    expect(events.some(event => event.type === "result")).toBe(false);
  });

  it.each(["same-update", "foreign-update", "unselected-update", "mode-reconfig-default"])("ACP %s 保持明确选择，不误阻断", async scenario => {
    const events = await collect(driver({ ...launch, ...(scenario === "mode-reconfig-default" ? { mode: "code" } : {}) }, ["--mode", scenario, "--no-tools"]).run({ prompt: "work", cwd }));
    expect(events.some(event => event.type === "error")).toBe(false); expect(events.some(event => event.type === "result")).toBe(true);
  });

  it.each([false, true])("纯 configOptions mode 以精确 ID 选择，不依赖 category（resume=%s）", async resume => {
    const profile = { ...launch, mode: "code", option_ids: { ...launch.option_ids, mode: "workflow" } };
    const worker = driver(profile, ["--config-only", "--config-mode", "--no-tools"]);
    const events = await collect(resume ? worker.resume("specific-session", { prompt: "work", cwd }) : worker.run({ prompt: "work", cwd }));
    expect(events.some(event => event.type === "error")).toBe(false); expect(events.some(event => event.type === "result")).toBe(true);
    const facts = await messages(); expect(facts.some(fact => fact.event === "session/set_mode")).toBe(false);
    expect(facts.find(fact => fact.event === "session/set_config_option")).toMatchObject({ configId: "workflow", value: "code" });
  });

  it("mode 改变模型候选后使用最新回执，不能用初始 plan 选项误拒绝 code 模型", async () => {
    const events = await collect(driver({ ...launch, mode: "code", option_ids: { ...launch.option_ids, mode: "workflow" } },
      ["--mode", "mode-dependent-model", "--config-mode", "--config-only", "--no-tools"]).run({ prompt: "work", cwd }));
    expect(events.some(event => event.type === "error")).toBe(false); expect(events.some(event => event.type === "result")).toBe(true);
    expect((await messages()).filter(fact => fact.event === "session/set_config_option").map(fact => fact.configId)).toEqual(["workflow", "llm", "thinking"]);
  });

  it.each(["drift-mode", "drift-config-mode"])("ACP %s 阻断明确模式漂移", async scenario => {
    const profile = { ...launch, mode: "code", ...(scenario === "drift-config-mode" ? { option_ids: { ...launch.option_ids, mode: "workflow" } } : {}) };
    const events = await collect(driver(profile, ["--mode", scenario, "--config-mode", "--no-tools"]).run({ prompt: "work", cwd }));
    expect(events.some(event => event.type === "error" && (event.data as any).kind === "configuration")).toBe(true);
    expect(events.some(event => event.type === "result")).toBe(false);
  });

  it("同一 driver 每次 session 独立，失败后新调用正常；readonly mode 映射仍拒绝 code", async () => {
    const worker = driver({ mode: "code", option_ids: { mode: "workflow" } }, ["--config-mode", "--config-only", "--no-tools"]);
    const rejected = await collect(worker.run({ prompt: "review", cwd, readonly: true }));
    expect(rejected.some(event => event.type === "error")).toBe(true); expect((await messages()).some(fact => fact.event === "prompt")).toBe(false);
    const recovered = await collect(worker.run({ prompt: "work", cwd }));
    expect(recovered.some(event => event.type === "error")).toBe(false); expect(recovered.some(event => event.type === "result")).toBe(true);
  });

  it("配置漂移后权限请求不会调用预授权裁决器，子进程取消并收束", async () => {
    let asked = false; const pid_file = join(cwd, "pid");
    const worker = new AcpDriver({ bin: process.execPath, args: [acp, "--config", "--record", record, "--mode", "drift-permission", "--pid-file", pid_file], launch,
      decidePermission: () => { asked = true; return { optionId: "allow-once" }; } });
    expect((await collect(worker.run({ prompt: "work", cwd }))).some(event => event.type === "error")).toBe(true);
    expect(asked).toBe(false);
    const pid = Number(await readFile(pid_file, "utf8")); expect(() => process.kill(pid, 0)).toThrow();
    expect((await messages()).some(fact => fact.event === "session/cancel")).toBe(true);
  });

  it("已在途权限裁决遇到配置漂移，迟到允许返回取消而不授予工具", async () => {
    let asked = false;
    let release!: () => void; const decision = new Promise<void>(resolve => { release = resolve; });
    const worker = new AcpDriver({ bin: process.execPath, args: [acp, "--config", "--record", record, "--mode", "pending-permission-drift"], launch,
      decidePermission: async () => { asked = true; await decision; return { optionId: "allow-once" }; } });
    const events: AgentEvent[] = [];
    for await (const event of worker.run({ prompt: "work", cwd })) { events.push(event); if (event.type === "error") release(); }
    expect(asked).toBe(true); expect(events.some(event => event.type === "error")).toBe(true); expect(events.some(event => event.type === "result")).toBe(false);
    expect((await messages()).find(fact => fact.event === "permission_response").outcome).toEqual({ outcome: "cancelled" });
  });

  it.each(["wrong-mode", "mode-reconfig", "duplicate-option", "duplicate-value"])("ACP %s 在 prompt 前 fail-closed", async scenario => {
    const events = await collect(driver({ ...launch, mode: "code" }, ["--mode", scenario, "--no-tools"]).run({ prompt: "work", cwd }));
    expect(events.some(event => event.type === "error")).toBe(true);
    expect((await messages()).some(fact => fact.event === "prompt")).toBe(false);
  });

  it("设置回执后的异步漂移一经观察就取消，不以迟到更新继续返回成功", async () => {
    const events = await collect(driver(launch, ["--mode", "post-set-drift", "--no-tools"]).run({ prompt: "work", cwd }));
    expect(events.some(event => event.type === "error" && (event.data as any).kind === "configuration")).toBe(true);
    expect(events.some(event => event.type === "result")).toBe(false);
    expect((await messages()).some(fact => fact.event === "session/cancel")).toBe(true);
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

  it("ACP查询预取消不启动进程，取消session/new挂起会收束且允许后续查询", async () => {
    const cancelled = new AbortController(); cancelled.abort(); const pid_file = join(cwd, "pid");
    const worker = driver({}, ["--mode", "hang-new", "--pid-file", pid_file]);
    await expect(worker.inspect(cwd, 10000, cancelled.signal)).rejects.toThrow(/取消/);
    await expect(readFile(pid_file, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    const controller = new AbortController(); const pending = worker.inspect(cwd, 10000, controller.signal);
    const rejection = expect(pending).rejects.toThrow(/协商|取消/);
    const deadline = Date.now() + 3000;
    while (!await messages().then(values => values.some(value => value.event === "session/new")).catch(() => false)) {
      if (Date.now() > deadline) throw new Error("ACP查询未进入session/new");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    controller.abort(); await rejection;
    const pid = Number(await readFile(pid_file, "utf8")); expect(() => process.kill(pid, 0)).toThrow();
    expect((await driver({}).inspect(cwd)).evidence).toBe("acp_handshake");
    expect((await messages()).some(value => value.event === "prompt")).toBe(false);
  });

  it("ACP能力查询不调用worker会话回执hook，后续run仍报告实际session", async () => {
    const receipts: string[] = [];
    const worker = new AcpDriver({ bin: process.execPath, args: [acp, "--record", record, "--no-tools"], onSession: id => receipts.push(id) });
    expect((await worker.inspect(cwd)).evidence).toBe("acp_handshake"); expect(receipts).toEqual([]);
    expect((await collect(worker.run({ prompt: "work", cwd }))).some(event => event.type === "result")).toBe(true);
    expect(receipts).toEqual(["acp-session-1"]);
  });
});
