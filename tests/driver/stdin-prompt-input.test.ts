import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HeadlessDriver, createAgentRegistry, parseAgentsYaml, type AgentEvent } from "../../src/index.js";
import { custom_headless_template } from "../../src/driver/custom-template.js";
import { canonicalJson, sha256Hex } from "../../src/core/hash.js";

const fixture = fileURLToPath(new URL("./fixtures/stdin-prompt-worker.mjs", import.meta.url));
let cwd: string;
beforeEach(async () => { cwd = await mkdtemp(join(tmpdir(), "cord-stdin-prompt-")); });
afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });
async function collect(source: AsyncIterable<AgentEvent>) { const events: AgentEvent[] = []; for await (const event of source) events.push(event); return events; }
const facts = async () => (await readFile(join(cwd, ".stdin-calls.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
const modes = [{ readonly: false, resume: false }, { readonly: true, resume: false }, { readonly: false, resume: true }, { readonly: true, resume: true }];

describe("Headless明确stdin Prompt输入", () => {
  it.each(modes)("Codex四组合$readonly/$resume精确stdin，不将选项/子命令prompt进入argv", async mode => {
    const driver = new HeadlessDriver({ cli: "codex", bin: process.execPath, prefixArgs: [fixture],
      launch: { model: "writer", effort: "high" }, readonly_launch: { model: "reviewer", effort: "low" } });
    for (const prompt of ["", "--help", "-", "resume", "PRIVATE_PROMPT\n中文\t$(literal) `literal` {{prompt}}\n"]) {
      const task = { prompt, cwd, readonly: mode.readonly }; const events = await collect(mode.resume ? driver.resume("fixed-session", task) : driver.run(task));
      const fact = (await facts()).at(-1); expect(fact.input_hex).toBe(Buffer.from(prompt, "utf8").toString("hex")); expect(fact.prompt).toBe(prompt);
      expect(fact.args.at(-1)).toBe("-"); expect(fact.args.join("\n")).not.toContain("PRIVATE_PROMPT");
      expect(fact.model).toBe(mode.readonly ? "reviewer" : "writer"); expect(fact.readonly).toBe(mode.readonly); expect(fact.session).toBe(mode.resume ? "fixed-session" : null);
      expect(events.some(event => event.type === "error")).toBe(false); expect(events.at(-1)).toMatchObject({ type: "result" });
    }
    expect(driver.capabilities).toMatchObject({ prompt_input: "stdin" });
  });

  it.each(modes)("自定义四组合$readonly/$resume选择同一stdin协议，两套值仍独立", async mode => {
    const args = [fixture, "--model", "{{model}}", "--effort", "{{effort}}", "--readonly", "{{readonly}}", "-"];
    const template = custom_headless_template("custom", process.execPath, args, [...args, "--session", "{{resume_session_id}}"], { prompt_input: "stdin" });
    const driver = new HeadlessDriver({ cli: "custom", template, launch: { model: "writer", effort: "high" }, readonly_launch: { model: "reviewer", effort: "low" } });
    const task = { prompt: "PRIVATE_STDIN\n完整原文不加换行", cwd, readonly: mode.readonly };
    await collect(mode.resume ? driver.resume("fixed-session", task) : driver.run(task)); const fact = (await facts()).at(-1);
    expect(fact.prompt).toBe(task.prompt); expect(fact.model).toBe(mode.readonly ? "reviewer" : "writer"); expect(fact.args.join("\n")).not.toContain("PRIVATE_STDIN");
    expect(fact.session).toBe(mode.resume ? "fixed-session" : null); expect(driver.capabilities).toMatchObject({ prompt_input: "stdin" });
  });

  it("相同静态argv不同输入通道有不同身份，旧argv-only仍绑定原v4定义", () => {
    const options = { cli: "custom", bin: process.execPath, template: { name: "custom", bin: process.execPath, args: () => [fixture, "-"] } };
    const legacy = new HeadlessDriver(options); const stdin = new HeadlessDriver({ ...options, template: { ...options.template, prompt_input: "stdin" } });
    expect(stdin.buildArgv({ prompt: "p", cwd })).toEqual(legacy.buildArgv({ prompt: "p", cwd })); expect(stdin.configuration_hash).not.toBe(legacy.configuration_hash);
    const task = { prompt: "cord.configuration.prompt", cwd: "" };
    const launch_configuration_hash = sha256Hex(canonicalJson({ domain: "cord.agent-config.headless.v1", name: legacy.name,
      argv: legacy.buildArgv(task), readonly_argv: legacy.buildArgv({ ...task, readonly: true }), resume_argv: null, readonly_resume_argv: null }));
    expect(legacy.configuration_hash).toBe(sha256Hex(canonicalJson({ domain: "cord.agent-config.headless.v4", completion_policy: "process-exit-required.v1", launch_configuration_hash })));
    expect(new HeadlessDriver({ ...options, template: { ...options.template, prompt_input: "argv" } }).configuration_hash).toBe(legacy.configuration_hash);
  });

  it.each(["timeout", "abort"])("stdin背压时%s仍回收进程，不因input写入未完成挂死", async mode => {
    const pid_file = join(cwd, "pid"); const controller = new AbortController();
    const driver = new HeadlessDriver({ cli: "custom", template: { name: "custom", bin: process.execPath, prompt_input: "stdin", args: () => [fixture, "--never-read", "--pid-file", pid_file, "-"] }, kill_grace_ms: 50 });
    const pending = collect(driver.run({ prompt: "PRIVATE_BACKPRESSURE".repeat(100000), cwd, timeout_ms: mode === "timeout" ? 1000 : 10000, signal: controller.signal }));
    const deadline = Date.now() + 4000; let pid: number | undefined;
    while (pid === undefined) {
      try { const value = (await readFile(pid_file, "utf8")).trim(); if (/^[1-9][0-9]*$/.test(value)) pid = Number(value); }
      catch { /* fixture尚未写出PID。 */ }
      if (pid === undefined) { if (Date.now() >= deadline) throw new Error("stdin fixture未启动"); await new Promise(resolve => setTimeout(resolve, 10)); }
    }
    if (mode === "abort") controller.abort(); const events = await pending;
    expect(events.some(event => event.type === "result")).toBe(false); expect(events.find(event => event.type === "error")).toMatchObject({ data: { kind: mode === "timeout" ? "timeout" : "agent" } });
    await expect.poll(() => { try { process.kill(pid!, 0); return true; } catch { return false; } }, { timeout: 2000 }).toBe(false);
    expect(JSON.stringify(events)).not.toContain("PRIVATE_BACKPRESSURE");
  });

  it("未知runtime模板通道拒绝，明确stdin帮助查询仍不发送task输入", async () => {
    expect(() => new HeadlessDriver({ cli: "custom", template: { name: "custom", bin: "unreachable", prompt_input: "unknown" as "stdin", args: () => [] } })).toThrow(/prompt_input/);
    const probe = fileURLToPath(new URL("./fixtures/cli-inspection.mjs", import.meta.url)); const record = join(cwd, "probes.jsonl");
    const driver = new HeadlessDriver({ cli: "codex", bin: process.execPath, prefixArgs: [probe, "--profile", "codex", "--record", record, "--probe-args"] });
    expect(await driver.inspect(cwd)).toMatchObject({ status: "passed" });
    expect((await readFile(record, "utf8")).trim().split("\n").map(line => JSON.parse(line).args)).toEqual([["--version"], ["exec", "--help"], ["exec", "resume", "--help"]]);
  });

  it.each([
    { kind: "headless", bin: "wrapper", args: ["{{prompt}}"], prompt_input: "stdin" },
    { kind: "headless", bin: "wrapper", args: ["-"], readonly_args: ["{{prompt}}"], prompt_input: "stdin" },
    { kind: "headless", bin: "wrapper", args: ["-"], prompt_input: "unknown" },
    { kind: "headless", template: "codex", prompt_input: "argv" },
    { kind: "acp", bin: "wrapper", prompt_input: "stdin" },
  ])("非法/混合/覆盖输入声明拒绝注册：%j", entry => {
    const registry = createAgentRegistry(parseAgentsYaml(JSON.stringify({ agents: { codex: entry } })).yaml);
    expect(registry.rejected).toContain("codex"); expect(() => registry.resolve("codex")).toThrow(/配置无效/);
  });
});
