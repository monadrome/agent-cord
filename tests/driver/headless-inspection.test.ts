import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HeadlessDriver } from "../../src/driver/headless.js";
import { cli_version } from "../../src/driver/headless-inspection.js";
const fixture = fileURLToPath(new URL("./fixtures/cli-inspection.mjs", import.meta.url));
let cwd: string; let record: string;
beforeEach(async () => { cwd = await mkdtemp(join(tmpdir(), "cord-cli-inspect-")); record = join(cwd, "calls.jsonl"); });
afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });
function driver(profile: "claude" | "codex" | "kimi", scenario = "normal", extra: string[] = []) {
  return new HeadlessDriver({ cli: profile, bin: process.execPath, prefixArgs: [fixture, "--profile", profile, "--scenario", scenario, "--record", record, ...extra, "--probe-args"],
    kill_grace_ms: 100, launch: { model: "PRIVATE_MODEL_MARKER", ...(profile === "claude" ? { bare: true, auto: true, system_prompt: "PRIVATE_ROLE_MARKER", effort: "high" } : {}) } });
}
async function calls() { return (await readFile(record, "utf8")).trim().split("\n").map(line => JSON.parse(line).args); }
async function expect_dead(pid: number): Promise<void> {
  const deadline = Date.now() + 1500;
  for (;;) {
    try { process.kill(pid, 0); } catch { return; }
    if (Date.now() > deadline) throw new Error("诊断子进程未收束");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

describe("Headless 固定CLI帮助查询", () => {
  it.each(["claude", "codex", "kimi"] as const)("%s 实际argv只有版本/help，不泄露输出/模型/角色，不改变执行身份", async profile => {
    const worker = driver(profile); const hash = worker.configuration_hash; const observed = await worker.inspect(cwd);
    expect(observed).toMatchObject({ evidence: "cli_help", profile, status: "passed", native_resume: "advertised", version: expect.stringMatching(/^\d+\.\d+\.\d+$/) });
    expect(observed!.help_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(observed!.launch_options.find(option => option.id === "model")).toMatchObject({ configured: true, advertised: true });
    if (profile === "codex") expect(observed!.launch_options.find(option => option.id === "effort")!.advertised).toBeNull();
    expect(await calls()).toEqual(profile === "codex" ? [["--version"], ["exec", "--help"], ["exec", "resume", "--help"]] : [["--version"], ["--help"]]);
    expect(JSON.stringify(observed)).not.toContain("PRIVATE_"); expect(JSON.stringify(observed)).not.toContain(fixture);
    expect(worker.configuration_hash).toBe(hash);
  });
  it.each(["missing-bare", "prose-only", "no-auto"])("%s 不从描述正文或缺少枚举猜测支持", async scenario => {
    const observed = await driver("claude", scenario).inspect(cwd);
    const id = scenario === "missing-bare" ? "bare" : scenario === "prose-only" ? "model" : "auto";
    expect(observed!.status).toBe("passed"); expect(observed!.launch_options.find(option => option.id === id)!.advertised).toBe(false);
  });
  it("CLI以引号枚举auto仍能识别，未枚举时保持未知", async () => {
    const observed = await driver("claude", "quoted-auto").inspect(cwd);
    expect(observed!.launch_options.find(option => option.id === "auto")!.advertised).toBe(true);
    const unknown = await driver("claude", "auto-no-choices").inspect(cwd);
    expect(unknown!.launch_options.find(option => option.id === "auto")!.advertised).toBeNull();
  });
  it.each(["fail", "unknown", "unknown-help", "large"])("%s 以有限失败/未知状态返回，不暴露stderr或原输出", async scenario => {
    const observed = await driver("claude", scenario).inspect(cwd);
    expect(observed!.status).toBe(scenario.includes("unknown") ? "unrecognized" : "failed");
    expect(JSON.stringify(observed)).not.toContain("PRIVATE_"); expect(observed!.native_resume).toBe("unknown");
  });
  it("缺二进制明确unavailable；自定义原始args没有探测声明，不猜运行", async () => {
    expect(await new HeadlessDriver({ cli: "claude", bin: "/missing/cord-cli" }).inspect(cwd)).toMatchObject({ status: "unavailable" });
    const custom = new HeadlessDriver({ cli: "custom", template: { name: "custom", bin: "/missing/custom", args: () => ["run"] } });
    expect(custom.capabilities.inspection).toBe("unsupported"); expect(await custom.inspect(cwd)).toBeNull();
  });
  it("总timeout约束全部命令，不能每个步骤重置预算", async () => {
    const observed = await driver("codex", "slow").inspect(cwd, 500);
    expect(observed!.status).toBe("timeout"); expect(observed!.checks.length).toBeLessThanOrEqual(3);
  });
  it("超时清理忽略SIGTERM的进程树，修复后新查询成功", async () => {
    const pid = join(cwd, "pid"); const child_pid = join(cwd, "child-pid");
    const observed = await driver("claude", "hang", ["--pid-file", pid, "--child-pid-file", child_pid]).inspect(cwd, 600);
    expect(observed!.status).toBe("timeout");
    for (const path of [pid, child_pid]) await expect_dead(Number(await readFile(path, "utf8")));
    expect((await driver("claude").inspect(cwd))!.status).toBe("passed");
  });
  it("帮助命令成功且组长已退出，仍清理留下的诊断子进程", async () => {
    const child_pid = join(cwd, "child-pid");
    expect((await driver("claude", "normal", ["--child-pid-file", child_pid]).inspect(cwd))!.status).toBe("passed");
    await expect_dead(Number(await readFile(child_pid, "utf8")));
  });
  it("版本解析只投影短标识，不公开任意版本输出", () => {
    expect(cli_version("codex", "codex-cli 1.2.3\nPRIVATE_ENV_MARKER")).toBe("1.2.3");
    expect(cli_version("claude", "3.2.1 (Claude Code)")).toBe("3.2.1");
    expect(cli_version("kimi", "secret-custom-build")).toBeNull();
  });
});
