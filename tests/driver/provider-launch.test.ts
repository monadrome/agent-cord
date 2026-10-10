import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AcpDriver, HeadlessDriver, createAgentRegistry, parseAgentsYaml, type AgentEvent, type AgentLaunch } from "../../src/index.js";
import { custom_headless_template } from "../../src/driver/custom-template.js";
import { canonicalJson, sha256Hex } from "../../src/core/hash.js";

const acp = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url));
const cli = fileURLToPath(new URL("./fixtures/fake-cli.mjs", import.meta.url));
const launch: AgentLaunch = { provider: "anthropic", model: "large", effort: "high", option_ids: { provider: "provider", model: "llm", effort: "thinking" } };
let cwd: string; let record: string;
beforeEach(async () => { cwd = await mkdtemp(join(tmpdir(), "cord-provider-launch-")); record = join(cwd, "requests.jsonl"); });
afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });
async function collect(events: AsyncIterable<AgentEvent>) { const result: AgentEvent[] = []; for await (const event of events) result.push(event); return result; }
const messages = async () => (await readFile(record, "utf8")).trim().split("\n").map(line => JSON.parse(line));
function driver(profile: AgentLaunch = launch, flags: string[] = []) { return new AcpDriver({ bin: process.execPath,
  args: [acp, "--config", "--provider-option", "--no-tools", "--record", record, ...flags], launch: profile, kill_grace_ms: 100 }); }

describe("Provider依赖配置", () => {
  it.each([false, true])("新路由解锁扩展/模型后按完整回执设置，原生恢复=%s", async resume => {
    const worker = driver({ ...launch, config_options: { extra: true, extended: true }, mode: "code", option_ids: { ...launch.option_ids, mode: "workflow" } },
      ["--provider-dependent-config", "--config-mode", "--config-only"]);
    const task = { prompt: "LATEST_PROVIDER_INPUT", cwd };
    const events = await collect(resume ? worker.resume("fixed-provider-session", task) : worker.run(task));
    expect(events.filter(event => event.type === "error")).toEqual([]); expect(events.some(event => event.type === "result")).toBe(true);
    const facts = await messages();
    expect(facts.filter(fact => fact.event === "session/set_config_option").map(fact => [fact.configId, fact.value])).toEqual([
      ["workflow", "code"], ["provider", "anthropic"], ["extended", true], ["extra", true], ["llm", "large"], ["thinking", "high"],
    ]);
    expect(facts.at(-1)).toMatchObject({ event: "prompt", text: "LATEST_PROVIDER_INPUT" });
    if (resume) { expect(facts.find(fact => fact.event === "session/load").sessionId).toBe("fixed-provider-session"); expect(facts.some(fact => fact.event === "session/new")).toBe(false); }
  });

  it.each(["unknown_id", "unknown_value", "wrong_type", "ignored", "reset"])("provider%s在prompt前拒绝", async mode => {
    const profile = mode === "unknown_id" ? { ...launch, option_ids: { ...launch.option_ids, provider: "unknown" } }
      : mode === "unknown_value" ? { ...launch, provider: "missing" } : launch;
    const flags = mode === "wrong_type" ? ["--provider-boolean"] : mode === "ignored" ? ["--mode", "ignore-config"] : mode === "reset" ? ["--reset-provider"] : [];
    const events = await collect(driver(profile, flags).run({ prompt: "p", cwd }));
    expect(events.some(event => event.type === "error" && (event.data as { kind?: string }).kind === "configuration")).toBe(true);
    expect(events.some(event => event.type === "result")).toBe(false); expect((await messages()).some(fact => fact.event === "prompt")).toBe(false);
  });

  it("查询以精确ID公开provider候选，不依赖category且不发送prompt", async () => {
    const observation = await driver(launch, ["--provider-without-category"]).inspect(cwd);
    expect(observation?.config_options.find(option => option.id === "provider")).toMatchObject({ type: "select", category: null, values: ["openai", "anthropic"], omitted_values: 0 });
    expect((await messages()).some(fact => fact.event === "prompt")).toBe(false);
  });

  it("只有provider配置绑定新顺序策略，未声明provider保留旧身份", () => {
    const worker = driver(); const args = [acp, "--config", "--provider-option", "--no-tools", "--record", record];
    const old_provider = sha256Hex(canonicalJson({ domain: "cord.agent-config.acp.v5", launch_state_policy: "explicit-session-selections.v1", launch,
      name: `acp:${process.execPath}`, bin: process.execPath, args }));
    expect(worker.configuration_hash).not.toBe(old_provider);
    const unchanged = { model: "large", effort: "high", option_ids: { model: "llm", effort: "thinking" } };
    expect(driver(unchanged).configuration_hash).toBe(sha256Hex(canonicalJson({ domain: "cord.agent-config.acp.v5", launch_state_policy: "explicit-session-selections.v1",
      launch: unchanged, name: `acp:${process.execPath}`, bin: process.execPath, args })));
    expect(driver({ ...launch, provider: "openai" }).configuration_hash).not.toBe(worker.configuration_hash);
  });
});

describe("自定义Provider实参", () => {
  const base = [cli, "--mode", "claude", "--no-tools"];
  const mapped = ["--provider", "{{provider}}", "--model", "{{model}}", "--effort", "{{effort}}", "-p", "{{prompt}}"];
  const args = [...base, "--write", ...mapped];
  const resume_args = [...base, "--write-resume", "{{resume_session_id}}", ...mapped];
  const readonly_args = [...base, "--read-only", ...mapped];
  const readonly_resume_args = [...base, "--read-only-resume", "{{resume_session_id}}", ...mapped];
  it.each([{ readonly: false, resume: false, flag: "--write" }, { readonly: true, resume: false, flag: "--read-only" },
    { readonly: false, resume: true, flag: "--write-resume" }, { readonly: true, resume: true, flag: "--read-only-resume" }])("$flag真实argv保持provider与指定session", async mode => {
    const worker = new HeadlessDriver({ cli: "custom", template: custom_headless_template("custom", process.execPath, args, resume_args, { readonly_args, readonly_resume_args }),
      launch: { provider: "anthropic", model: "large", effort: "high" } });
    const task = { prompt: "{{provider}} $(literal)", cwd, readonly: mode.readonly };
    const events = await collect(mode.resume ? worker.resume("fixed-session", task) : worker.run(task));
    const argv = events.map(event => (event.data as { raw?: { argv?: string[] } }).raw?.argv).find(Array.isArray)!;
    expect(argv[argv.indexOf("--provider") + 1]).toBe("anthropic"); expect(argv).toContain(mode.flag);
    expect(argv).toContain("{{provider}} $(literal)"); expect(argv).toContain("large"); expect(argv).toContain("high");
    if (mode.resume) expect(argv).toContain("fixed-session"); else expect(argv).not.toContain("fixed-session");
  });
  it.each(["resume_args", "readonly_args", "readonly_resume_args"])("%s漏provider映射拒绝配置", branch => {
    const branches = { resume_args, readonly_args, readonly_resume_args };
    const invalid = { ...branches, [branch]: branches[branch as keyof typeof branches].filter(value => value !== "{{provider}}") };
    expect(() => custom_headless_template("custom", "wrapper", args, invalid.resume_args, invalid)).toThrow(/provider/);
  });
  it("provider别名重载改变身份且旧resolver保持原实参；内置CLI拒绝不回退", () => {
    const spec = { agents: { custom: { kind: "headless", bin: process.execPath, args, launch: { provider: "anthropic", model: "large", effort: "high" } } } };
    const original = createAgentRegistry(parseAgentsYaml(JSON.stringify(spec)).yaml).resolve("custom") as HeadlessDriver;
    spec.agents.custom.launch.provider = "openai";
    const latest = createAgentRegistry(parseAgentsYaml(JSON.stringify(spec)).yaml).resolve("custom") as HeadlessDriver;
    expect(original.configuration_hash).not.toBe(latest.configuration_hash);
    expect(original.buildArgv({ prompt: "p", cwd })).toContain("anthropic"); expect(latest.buildArgv({ prompt: "p", cwd })).toContain("openai");
    for (const template of ["claude", "codex", "kimi"]) {
      const registry = createAgentRegistry(parseAgentsYaml(`agents: { ${template}: { kind: headless, template: ${template}, launch: { provider: openai } } }`).yaml);
      expect(registry.rejected).toContain(template); expect(() => registry.resolve(template)).toThrow(/配置无效/);
    }
  });
});
