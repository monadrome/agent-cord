import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HeadlessDriver, createAgentRegistry, parseAgentsYaml, type AgentEvent, type AgentLaunch } from "../../src/index.js";
import { custom_headless_template } from "../../src/driver/custom-template.js";
import { canonicalJson, sha256Hex } from "../../src/core/hash.js";

const cli = fileURLToPath(new URL("./fixtures/fake-cli.mjs", import.meta.url));
const inspect_cli = fileURLToPath(new URL("./fixtures/cli-inspection.mjs", import.meta.url));
let cwd: string;
beforeEach(async () => { cwd = await mkdtemp(join(tmpdir(), "cord-headless-profile-")); });
afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });
async function collect(source: AsyncIterable<AgentEvent>) { const events: AgentEvent[] = []; for await (const event of source) events.push(event); return events; }

describe("Headless完整只读配置", () => {
  it.each([{ readonly: false, resume: false }, { readonly: true, resume: false }, { readonly: false, resume: true }, { readonly: true, resume: true }])("真实Claude子进程选择对应完整role/model配置$readonly/$resume", async mode => {
    const driver = new HeadlessDriver({ cli: "claude", bin: process.execPath, prefixArgs: [cli, "--no-tools"],
      launch: { model: "writer-model", effort: "high", agent: "writer", system_prompt: "writer-role", bare: true, auto: true, max_turns: 8, budget_usd: 3 },
      readonly_launch: { model: "review-model", effort: "low", agent: "reviewer", auto: true } });
    const task = { prompt: "LATEST_PROFILE_INPUT", cwd, readonly: mode.readonly };
    const events = await collect(mode.resume ? driver.resume("fixed-readonly-session", task) : driver.run(task));
    const args = events.map(event => (event.data as { raw?: { argv?: string[] } }).raw?.argv).find(Array.isArray)!;
    expect(args[args.indexOf("--model") + 1]).toBe(mode.readonly ? "review-model" : "writer-model");
    expect(args[args.indexOf("--effort") + 1]).toBe(mode.readonly ? "low" : "high");
    expect(args[args.indexOf("--agent") + 1]).toBe(mode.readonly ? "reviewer" : "writer");
    if (mode.readonly) { expect(args).toContain("plan"); expect(args).not.toContain("auto"); expect(args).not.toContain("--bare");
      expect(args).not.toContain("--max-turns"); expect(args).not.toContain("--max-budget-usd"); expect(args).not.toContain("writer-role"); }
    else { expect(args).toContain("auto"); expect(args).toContain("--bare"); expect(args).toContain("writer-role"); }
    if (mode.resume) expect(args).toContain("fixed-readonly-session"); else expect(args).not.toContain("fixed-readonly-session");
    expect(driver.capabilities.readonly_configuration).toBe("explicit");
  });

  it("空独立配置不继承旧knobs/launch；明确声明改变身份，旧无声明hash不变", () => {
    const legacy = new HeadlessDriver({ cli: "claude", knobs: { model: "old-model", bare: true }, launch: { effort: "high" } });
    const empty = new HeadlessDriver({ cli: "claude", knobs: { model: "old-model", bare: true }, launch: { effort: "high" }, readonly_launch: {} });
    expect(empty.buildArgv({ prompt: "p", cwd, readonly: true })).not.toContain("old-model"); expect(empty.buildArgv({ prompt: "p", cwd, readonly: true })).not.toContain("high");
    expect(empty.configuration_hash).not.toBe(legacy.configuration_hash); expect(legacy.capabilities).not.toHaveProperty("readonly_configuration");
    const sample = { prompt: "cord.configuration.prompt", cwd: "" };
    expect(legacy.configuration_hash).toBe(sha256Hex(canonicalJson({ domain: "cord.agent-config.headless.v1", name: legacy.name,
      argv: legacy.buildArgv(sample), readonly_argv: legacy.buildArgv({ ...sample, readonly: true }), resume_argv: legacy.buildArgv(sample, "cord.configuration.session"),
      readonly_resume_argv: legacy.buildArgv({ ...sample, readonly: true }, "cord.configuration.session") })));
  });

  it.each(["claude", "codex", "kimi"])("%s只读配置未支持选项拒绝别名，不回退内置", name => {
    const registry = createAgentRegistry(parseAgentsYaml(JSON.stringify({ agents: { [name]: { kind: "headless", template: name, readonly_launch: { mode: "plan" } } } })).yaml);
    expect(registry.rejected).toContain(name); expect(() => registry.resolve(name)).toThrow(/配置无效/);
  });

  it.each(["codex", "kimi"] as const)("%s实际原生恢复选择review模型并保持厂商只读参数", async name => {
    const driver = new HeadlessDriver({ cli: name, bin: process.execPath, prefixArgs: [cli, "--mode", name, "--no-tools"],
      launch: { model: "writer-model", ...(name === "codex" ? { effort: "high" } : {}) },
      readonly_launch: { model: "review-model", ...(name === "codex" ? { effort: "low" } : {}) } });
    const events = await collect(driver.resume("fixed-vendor-session", { prompt: "最新只读任务", cwd, readonly: true }));
    const actual = events.map(event => (event.data as { raw?: { argv?: string[] } }).raw?.argv).find(Array.isArray)!;
    expect(actual[actual.indexOf("--model") + 1]).toBe("review-model"); expect(actual).toContain("fixed-vendor-session"); expect(actual).not.toContain("writer-model");
    if (name === "codex") { expect(actual).toContain('model_reasoning_effort="low"'); expect(actual).toContain('sandbox_mode="read-only"'); }
    else expect(actual).toContain("--plan");
  });

  it("只读配置错误类型在注册时拒绝、v3仍绑定context_revision且不改变执行argv", () => {
    expect(() => new HeadlessDriver({ cli: "claude", readonly_launch: { bare: "true" } as unknown as AgentLaunch })).toThrow();
    const first = new HeadlessDriver({ cli: "claude", launch: { model: "writer" }, readonly_launch: { model: "review" }, context_revision: 1 });
    const next = new HeadlessDriver({ cli: "claude", launch: { model: "writer" }, readonly_launch: { model: "review" }, context_revision: 2 });
    expect(first.configuration_hash).not.toBe(next.configuration_hash); expect(first.buildArgv({ prompt: "p", cwd })).toEqual(next.buildArgv({ prompt: "p", cwd }));
  });

  it("custom新任务/恢复使用两套值且auto只读为false，漏只读占位值拒绝", async () => {
    const args = [cli, "--mode", "claude", "--no-tools", "--model", "{{model}}", "--effort", "{{effort}}", "--auto", "{{auto}}", "--readonly", "{{readonly}}", "-p", "{{prompt}}"];
    const template = custom_headless_template("custom", process.execPath, args, [...args, "--session", "{{resume_session_id}}"]);
    const driver = new HeadlessDriver({ cli: "custom", template, launch: { model: "writer", effort: "high", auto: true }, readonly_launch: { model: "reviewer", effort: "low", auto: true } });
    for (const readonly of [false, true]) for (const resume of [false, true]) {
      const task = { prompt: "p", cwd, readonly }; const events = await collect(resume ? driver.resume("fixed", task) : driver.run(task));
      const actual = events.map(event => (event.data as { raw?: { argv?: string[] } }).raw?.argv).find(Array.isArray)!;
      expect(actual).toContain(readonly ? "reviewer" : "writer"); expect(actual).toContain(readonly ? "low" : "high");
      expect(actual[actual.indexOf("--auto") + 1]).toBe(String(!readonly));
      if (resume) expect(actual).toContain("fixed"); else expect(actual).not.toContain("fixed");
    }
    expect(() => new HeadlessDriver({ cli: "custom", template, launch: { model: "writer", effort: "high", auto: true }, readonly_launch: { model: "reviewer" } })).toThrow(/缺少启动值/);
  });

  it("帮助查询只发version/help，configured按所选profile返回且身份不变", async () => {
    const record = join(cwd, "probes.jsonl");
    const driver = new HeadlessDriver({ cli: "claude", bin: process.execPath, prefixArgs: [inspect_cli, "--profile", "claude", "--record", record, "--probe-args"],
      launch: { model: "PRIVATE_WRITER_MODEL", system_prompt: "PRIVATE_ROLE", bare: true }, readonly_launch: { effort: "low" } });
    const hash = driver.configuration_hash; const writable = await driver.inspect(cwd); const readonly = await driver.inspect(cwd, 5000, undefined, true);
    expect(writable!.launch_options.find(option => option.id === "model")!.configured).toBe(true);
    expect(readonly!.launch_options.find(option => option.id === "model")!.configured).toBe(false);
    expect(readonly!.launch_options.find(option => option.id === "effort")!.configured).toBe(true);
    expect((await readFile(record, "utf8")).trim().split("\n").map(line => JSON.parse(line).args)).toEqual([["--version"], ["--help"], ["--version"], ["--help"]]);
    expect(JSON.stringify(readonly)).not.toContain("PRIVATE_"); expect(driver.configuration_hash).toBe(hash);
  });

  it("角色/模型任意分支变化绑定identity，输入对象修改不污染在途driver", () => {
    const readonly_launch: AgentLaunch = { model: "review-a", effort: "low" };
    const spec = { agents: { custom: { kind: "headless", template: "claude", model: "writer-a", readonly_launch } } };
    const original = createAgentRegistry(parseAgentsYaml(JSON.stringify(spec)).yaml).resolve("custom") as HeadlessDriver;
    readonly_launch.model = "review-b";
    const changed = createAgentRegistry(parseAgentsYaml(JSON.stringify(spec)).yaml).resolve("custom") as HeadlessDriver;
    expect(changed.configuration_hash).not.toBe(original.configuration_hash); expect(original.buildArgv({ prompt: "p", cwd, readonly: true })).toContain("review-a");
    spec.agents.custom.model = "writer-b";
    expect((createAgentRegistry(parseAgentsYaml(JSON.stringify(spec)).yaml).resolve("custom") as HeadlessDriver).configuration_hash).not.toBe(changed.configuration_hash);
  });
});
