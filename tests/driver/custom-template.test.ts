import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HeadlessDriver, createAgentRegistry, parseAgentsYaml, type AgentEvent } from "../../src/index.js";
import { custom_headless_template } from "../../src/driver/custom-template.js";

const fixture = fileURLToPath(new URL("./fixtures/fake-cli.mjs", import.meta.url));
let cwd: string;
beforeEach(async () => { cwd = await mkdtemp(join(tmpdir(), "cord-custom-modes-")); });
afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });
const prefix = [fixture, "--mode", "claude", "--no-tools"];
const mapped = ["--model", "{{model}}", "--effort", "{{effort}}", "-p", "{{prompt}}"];
const args = [...prefix, "--write", ...mapped];
const resume_args = [...prefix, "--write-resume", "{{resume_session_id}}", ...mapped];
const readonly_args = [...prefix, "--read-only", ...mapped];
const readonly_resume_args = [...prefix, "--read-only-resume", "{{resume_session_id}}", ...mapped];
function worker(readonly = true, resume = true) {
  return new HeadlessDriver({ cli: "custom", template: custom_headless_template("custom", process.execPath, args, resume_args,
    readonly ? { readonly_args, ...(resume ? { readonly_resume_args } : {}) } : {}), launch: { model: "fixture-model", effort: "high" } });
}
async function collect(events: AsyncIterable<AgentEvent>) { const result: AgentEvent[] = []; for await (const event of events) result.push(event); return result; }

describe("自定义wrapper任务模式", () => {
  it.each([
    { readonly: false, resume: false, flag: "--write" }, { readonly: true, resume: false, flag: "--read-only" },
    { readonly: false, resume: true, flag: "--write-resume" }, { readonly: true, resume: true, flag: "--read-only-resume" },
  ])("四种模式实际argv仅含$flag完整分支", async mode => {
    const agent = worker(); const task = { prompt: "LATEST_REQUIREMENT", cwd, readonly: mode.readonly };
    const events = await collect(mode.resume ? agent.resume("fixed-session", task) : agent.run(task));
    const actual = events.map(event => (event.data as { raw?: { argv?: string[] } }).raw?.argv).find(Array.isArray)!;
    expect(actual).toContain(mode.flag); expect(actual).toContain("fixture-model"); expect(actual).toContain("high"); expect(actual).toContain("LATEST_REQUIREMENT");
    expect(actual.filter(value => ["--write", "--read-only", "--write-resume", "--read-only-resume"].includes(value))).toEqual([mode.flag]);
    if (mode.resume) expect(actual).toContain("fixed-session"); else expect(actual).not.toContain("fixed-session");
    expect(agent.capabilities).toMatchObject({ readonly_launch: "mapped", readonly_resume: "supported", native_resume: "supported" });
  });

  it("readonly占位直接绑定true/false，prompt内占位和shell文本不递归展开", async () => {
    const template = custom_headless_template("custom", process.execPath, [...prefix, "--readonly", "{{readonly}}", "-p", "{{prompt}}"],
      [...prefix, "--session", "{{resume_session_id}}", "--readonly", "{{readonly}}", "-p", "{{prompt}}"]);
    const agent = new HeadlessDriver({ cli: "custom", template });
    for (const readonly of [false, true]) {
      const events = await collect(agent.resume("chosen", { prompt: "{{readonly}} $(literal) `literal`", cwd, readonly }));
      const actual = events.map(event => (event.data as { raw?: { argv?: string[] } }).raw?.argv).find(Array.isArray)!;
      expect(actual[actual.indexOf("--readonly") + 1]).toBe(String(readonly)); expect(actual).toContain("{{readonly}} $(literal) `literal`");
    }
    expect(agent.capabilities).toMatchObject({ readonly_launch: "mapped", readonly_resume: "supported" });
  });

  it("有独立readonly_args却无readonly_resume_args时，不回退可写resume或新session", async () => {
    const pid = join(cwd, "pid");
    const template = custom_headless_template("custom", process.execPath, [...args, "--pid-file", pid], resume_args, { readonly_args });
    const agent = new HeadlessDriver({ cli: "custom", template, launch: { model: "m", effort: "high" } });
    expect(agent.capabilities).toMatchObject({ native_resume: "supported", readonly_resume: "unsupported", readonly_launch: "mapped" });
    await expect(collect(agent.resume("fixed-session", { prompt: "p", cwd, readonly: true }))).rejects.toThrow(/只读模式/);
    await expect(readFile(pid, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect((await collect(agent.run({ prompt: "p", cwd, readonly: true }))).some(event => event.type === "result")).toBe(true);
  });

  it("旧无只读映射配置保留新任务argv并公开unmapped，旧readonly原生恢复拒绝", async () => {
    const agent = worker(false);
    expect(agent.buildArgv({ prompt: "p", cwd, readonly: true })).toEqual(agent.buildArgv({ prompt: "p", cwd }));
    expect(agent.capabilities).toMatchObject({ readonly_launch: "unmapped", readonly_resume: "unsupported" });
    await expect(collect(agent.resume("id", { prompt: "p", cwd, readonly: true }))).rejects.toThrow(/只读模式/);
  });

  it("外部模板仅声明普通resume不能冒称只读恢复，未映射时不启动进程", async () => {
    const pid = join(cwd, "pid");
    const template = { name: "external", bin: process.execPath, supports_resume: true,
      args: ({ prompt, resume_session_id }: { prompt: string; resume_session_id?: string }) => [...prefix, "--pid-file", pid,
        ...(resume_session_id === undefined ? [] : ["--session", resume_session_id]), "-p", prompt] };
    const agent = new HeadlessDriver({ cli: "external", template });
    expect(agent.capabilities).toMatchObject({ native_resume: "supported", readonly_launch: "unmapped", readonly_resume: "unsupported" });
    await expect(collect(agent.resume("fixed-session", { prompt: "p", cwd, readonly: true }))).rejects.toThrow(/只读模式/);
    await expect(readFile(pid, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect((await collect(agent.resume("fixed-session", { prompt: "p", cwd }))).some(event => event.type === "result")).toBe(true);
    expect(await readFile(pid, "utf8")).toMatch(/^\d+$/);
    const mapped = new HeadlessDriver({ cli: "external", template: { ...template, supports_readonly: true, supports_readonly_resume: true,
      args: input => [...template.args(input), "--readonly", String(input.readonly)] } });
    expect(mapped.capabilities).toMatchObject({ readonly_launch: "mapped", readonly_resume: "supported" });
    expect(mapped.configuration_hash).not.toBe(agent.configuration_hash);
    expect(mapped.buildArgv({ prompt: "p", cwd, readonly: true }, "fixed-session")).toContain("true");
  });

  it.each(["unknown", "missing_model", "extra_effort", "missing_prompt", "new_session_id", "missing_resume_id", "missing_dependencies"])("错误readonly分支%s阻断配置而不忽略", mode => {
    const read = [...readonly_args]; const read_resume = [...readonly_resume_args];
    if (mode === "unknown") read.push("{{unknown}}");
    if (mode === "missing_model") read[read.indexOf("{{model}}")] = "fixed-default";
    if (mode === "extra_effort") read.push("{{effort}}");
    if (mode === "missing_prompt") read[read.indexOf("{{prompt}}")] = "fixed-text";
    if (mode === "new_session_id") read.push("{{resume_session_id}}");
    if (mode === "missing_resume_id") read_resume[read_resume.indexOf("{{resume_session_id}}")] = "latest";
    expect(() => custom_headless_template("x", "x", mode === "extra_effort" ? ["{{prompt}}"] : args,
      mode === "missing_dependencies" ? undefined : resume_args, { readonly_args: read, readonly_resume_args: read_resume })).toThrow();
  });

  it("readonly占位不能仅在新会话声明，却冒称readonly resume已映射", () => {
    const template = custom_headless_template("x", "x", ["--readonly", "{{readonly}}", "{{prompt}}"], ["{{resume_session_id}}", "{{prompt}}"]);
    const agent = new HeadlessDriver({ cli: "x", template });
    expect(agent.capabilities).toMatchObject({ readonly_launch: "mapped", readonly_resume: "unsupported" });
    expect(() => agent.buildArgv({ prompt: "p", cwd, readonly: true }, "id")).toThrow(/只读/);
  });

  it("完整分支进入配置身份，修改readonly分支不影响在途resolver，但新定义身份变化", () => {
    const spec = { agents: { custom: { kind: "headless", bin: process.execPath, args, resume_args, readonly_args, readonly_resume_args,
      launch: { model: "m", effort: "high" } } } };
    const first = createAgentRegistry(parseAgentsYaml(JSON.stringify(spec)).yaml); const old = first.resolve("custom") as HeadlessDriver;
    spec.agents.custom.readonly_args = [...readonly_args, "--new-read-policy"];
    const next = createAgentRegistry(parseAgentsYaml(JSON.stringify(spec)).yaml); const latest = next.resolve("custom") as HeadlessDriver;
    expect(old.buildArgv({ prompt: "p", cwd, readonly: true })).not.toContain("--new-read-policy");
    expect(latest.buildArgv({ prompt: "p", cwd, readonly: true })).toContain("--new-read-policy");
    expect(old.configuration_hash).not.toBe(latest.configuration_hash);
  });

  it("模板形态不能混入自定义readonly分支，错误同名别名不能回退内置", () => {
    const registry = createAgentRegistry(parseAgentsYaml('agents: { claude: { kind: headless, template: claude, readonly_args: ["{{prompt}}"] } }').yaml);
    expect(registry.rejected).toContain("claude"); expect(() => registry.resolve("headless:claude")).toThrow(/配置无效/);
  });
});
