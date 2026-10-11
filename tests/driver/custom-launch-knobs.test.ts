import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HeadlessDriver, createAgentRegistry, parseAgentsYaml, type AgentEvent, type AgentLaunch } from "../../src/index.js";
import { custom_headless_template } from "../../src/driver/custom-template.js";
import { canonicalJson, sha256Hex } from "../../src/core/hash.js";

const fixture = fileURLToPath(new URL("./fixtures/fake-cli.mjs", import.meta.url));
const launch = { bare: true, auto: true, max_turns: 7, budget_usd: 2.5, agent: "architect", agents_json: '{"architect":{"prompt":"{{auto}} $(literal)"}}',
  system_prompt: "{{bare}} `literal` role text", provider: "provider-id", model: "model-id", effort: "high" } satisfies AgentLaunch;
const keys = ["provider", "model", "effort", "max_turns", "budget_usd", "system_prompt", "agent", "agents_json", "bare", "auto"] as const;
const base = [fixture, "--mode", "claude", "--no-tools"];
const mapped = [...keys.flatMap(key => [`--${key}`, `{{${key}}}`]), "--readonly", "{{readonly}}", "-p", "{{prompt}}"];
const args = [...base, "--write", ...mapped];
const resume_args = [...base, "--write-resume", "{{resume_session_id}}", ...mapped];
const readonly_args = [...base, "--read-only", ...mapped];
const readonly_resume_args = [...base, "--read-only-resume", "{{resume_session_id}}", ...mapped];
let cwd: string;
beforeEach(async () => { cwd = await mkdtemp(join(tmpdir(), "cord-custom-knobs-")); });
afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });
async function collect(events: AsyncIterable<AgentEvent>) { const result: AgentEvent[] = []; for await (const event of events) result.push(event); return result; }
function worker() { return new HeadlessDriver({ cli: "custom", template: custom_headless_template("custom", process.execPath, args, resume_args, { readonly_args, readonly_resume_args }), launch }); }

describe("自定义Wrapper完整旋钮", () => {
  it.each([{ readonly: false, resume: false, flag: "--write" }, { readonly: true, resume: false, flag: "--read-only" },
    { readonly: false, resume: true, flag: "--write-resume" }, { readonly: true, resume: true, flag: "--read-only-resume" }])("$flag实际argv保留typed值，只读auto关闭且不递归展开文本", async mode => {
    const driver = worker(); const task = { prompt: "{{agent}} $(literal) LATEST_WRAPPER_INPUT", cwd, readonly: mode.readonly };
    const events = await collect(mode.resume ? driver.resume("fixed-knob-session", task) : driver.run(task));
    const actual = events.map(event => (event.data as { raw?: { argv?: string[] } }).raw?.argv).find(Array.isArray)!;
    const value = (key: string) => actual[actual.indexOf("--" + key) + 1];
    expect(value("bare")).toBe("true"); expect(value("auto")).toBe(String(!mode.readonly));
    expect(value("max_turns")).toBe("7"); expect(value("budget_usd")).toBe("2.5");
    expect(value("system_prompt")).toBe(launch.system_prompt); expect(value("agent")).toBe("architect"); expect(value("agents_json")).toBe(launch.agents_json);
    expect(actual).toContain(task.prompt); expect(actual).toContain(mode.flag); expect(driver.capabilities.launch_options).toEqual(keys);
    if (mode.resume) expect(actual).toContain("fixed-knob-session"); else expect(actual).not.toContain("fixed-knob-session");
  });

  it.each(["bare", "auto", "max_turns", "budget_usd", "system_prompt", "agent", "agents_json"])("%s在声明分支缺值或漏映射均不能spawn", async key => {
    const profile: AgentLaunch = { ...launch }; delete profile[key as keyof typeof launch];
    const pid = join(cwd, "pid");
    expect(() => new HeadlessDriver({ cli: "custom", template: custom_headless_template("custom", process.execPath, [...args, "--pid-file", pid]), launch: profile })).toThrow(/缺少启动值/);
    await expect(readFile(pid)).rejects.toMatchObject({ code: "ENOENT" });
    for (const branch of ["resume_args", "readonly_args", "readonly_resume_args"] as const) {
      const branches = { resume_args, readonly_args, readonly_resume_args };
      const missing = { ...branches, [branch]: branches[branch].filter(value => value !== `{{${key}}}`) };
      expect(() => custom_headless_template("custom", process.execPath, args, missing.resume_args, missing)).toThrow(/映射/);
    }
  });

  it("旧三旋钮配置argv/hash不变；未映射auto和协议配置仍拒绝同名别名", () => {
    const template = custom_headless_template("old", process.execPath, [...base, "-p", "{{prompt}}", "--model", "{{model}}", "--effort", "{{effort}}"]);
    const old = new HeadlessDriver({ cli: "old", template, launch: { model: "model-id", effort: "high" } });
    const sample = { prompt: "cord.configuration.prompt", cwd: "" };
    expect(old.configuration_hash).toBe(sha256Hex(canonicalJson({ domain: "cord.agent-config.headless.v1", name: "headless:old",
      argv: old.buildArgv(sample), readonly_argv: old.buildArgv({ ...sample, readonly: true }), resume_argv: null, readonly_resume_argv: null })));
    expect(old.capabilities.launch_options).toEqual(["model", "effort"]);
    for (const profile of [{ auto: true }, { mode: "code" }, { config_options: { extended: true } }]) {
      const registry = createAgentRegistry(parseAgentsYaml(JSON.stringify({ agents: { claude: { kind: "headless", bin: process.execPath, args: [fixture, "{{prompt}}"], launch: profile } } })).yaml);
      expect(registry.rejected).toContain("claude"); expect(() => registry.resolve("claude")).toThrow(/配置无效/);
    }
  });

  it.each([{ bare: "true" }, { auto: 1 }, { max_turns: 0 }, { max_turns: 1.5 }, { budget_usd: -1 }, { agents_json: "" }, { system_prompt: "" }])("typed启动值%j不能注册或spawn", async invalid => {
    const pid = join(cwd, "pid");
    expect(() => new HeadlessDriver({ cli: "custom", template: custom_headless_template("custom", process.execPath, [...args, "--pid-file", pid]),
      launch: { ...launch, ...invalid } as AgentLaunch })).toThrow();
    await expect(readFile(pid)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("仅声明在其他分支的旋钮不能绕过基本args能力集合", () => {
    for (const key of keys.slice(3)) {
      expect(() => custom_headless_template("custom", "wrapper", ["{{prompt}}"], undefined,
        { readonly_args: ["{{prompt}}", `{{${key}}}`] })).toThrow(/映射/);
    }
  });

  it("false布尔值不丢失，配置对象/argv变更不污染固定driver而新定义改变身份", async () => {
    const profile = { ...launch, bare: false, auto: false }; const local_args = [...args];
    const original = new HeadlessDriver({ cli: "custom", template: custom_headless_template("custom", process.execPath, local_args), launch: profile });
    profile.auto = true; profile.budget_usd = 9; local_args.push("--changed");
    const events = await collect(original.run({ prompt: "p", cwd })); const actual = events.map(event => (event.data as { raw?: { argv?: string[] } }).raw?.argv).find(Array.isArray)!;
    expect(actual[actual.indexOf("--bare") + 1]).toBe("false"); expect(actual[actual.indexOf("--auto") + 1]).toBe("false");
    expect(actual).not.toContain("--changed"); expect(actual[actual.indexOf("--budget_usd") + 1]).toBe("2.5");
    const changed = new HeadlessDriver({ cli: "custom", template: custom_headless_template("custom", process.execPath, local_args), launch: profile });
    expect(changed.configuration_hash).not.toBe(original.configuration_hash);
  });
});
