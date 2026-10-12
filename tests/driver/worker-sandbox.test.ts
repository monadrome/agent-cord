import { mkdtemp, mkdir, readFile, writeFile, rm, access, cp, symlink } from "node:fs/promises";
import { fork } from "node:child_process";
import { tmpdir, homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HeadlessDriver } from "../../src/driver/headless.js";
import { AcpDriver } from "../../src/driver/acp.js";
import { custom_headless_template } from "../../src/driver/custom-template.js";
import { createAgentRegistry, parseAgentsYaml } from "../../src/driver/agents-yaml.js";
import { WorkerSandboxSchema, type WorkerSandboxInput } from "../../src/driver/worker-sandbox.js";
import type { AgentDriver, AgentEvent } from "../../src/core/ports.js";
import type { AgentInputDocuments } from "../../src/core/schema.js";
import { sha256Hex } from "../../src/core/hash.js";
import { stringify } from "yaml";

const fixture = fileURLToPath(new URL("./fixtures/sandbox-worker.mjs", import.meta.url));
const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
const native = process.platform === "darwin" && (major > 22 || major === 22 && minor >= 12) && (() => { try { createRequire(import.meta.url).resolve("@anthropic-ai/sandbox-runtime"); return true; } catch { return false; } })();
let directory: string; let root: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "cord-worker-native-")); root = join(directory, "workspace"); await mkdir(root); await writeFile(join(root, "value.txt"), "initial"); await mkdir(join(root, "cord")); await writeFile(join(root, "cord/events.jsonl"), "PROTECTED_FACTS"); await mkdir(join(root, ".git")); await writeFile(join(root, ".git/config"), "PROTECTED_GIT"); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
const config = (extra: Partial<WorkerSandboxInput> = {}): WorkerSandboxInput => ({ kind: "workspace", read_paths: [dirname(fixture)], ...extra });
function driver(protocol: "headless" | "acp", sandbox: WorkerSandboxInput | null = config(), args: string[] = [], env?: Record<string, string>): AgentDriver {
  if (protocol === "acp") return new AcpDriver({ bin: process.execPath, args: [fixture, "--acp", ...args], sandbox: sandbox ?? undefined, env });
  return new HeadlessDriver({ cli: "sandbox", name: "sandbox-headless", bin: process.execPath, sandbox: sandbox ?? undefined, env,
    template: custom_headless_template("sandbox", process.execPath, [fixture, ...args, "--readonly", "{{readonly}}", "-"], [fixture, ...args, "--readonly", "{{readonly}}", "--session", "{{resume_session_id}}", "-"], { prompt_input: "stdin" }) });
}
async function run(driver: AgentDriver, readonly = false, resume = false, input_documents?: AgentInputDocuments) {
  const task = { prompt: "current {{cord_input_dir}}", cwd: root, readonly, timeout_ms: 10000, input_documents, max_prompt_chars: 60000 };
  const events: AgentEvent[] = []; for await (const event of resume ? driver.resume("sandbox-session", task) : driver.run(task)) events.push(event); return events;
}
function result(events: AgentEvent[]) { expect(events.filter(event => event.type === "error"), JSON.stringify(events)).toHaveLength(0); return JSON.parse((events.find(event => event.type === "result")!.data as { text: string }).text); }

describe("Worker实际OS沙箱", () => {
  it.each([{ kind: "auto" }, { kind: "workspace", allowed_domains: ["*"] }, { kind: "workspace", env_allowlist: ["HOME"] }, { kind: "workspace", env_allowlist: ["NODE_OPTIONS"] },
    { kind: "workspace", read_paths: ["relative"] }, { kind: "workspace", state_dir: "/" }, { kind: "workspace", allowed_domains: ["api.example.com:99999"] }])("严格配置拒绝%j", sandbox => { expect(WorkerSandboxSchema.safeParse(sandbox).success).toBe(false); });
  it("明确沙箱改变两协议身份、能力与registry；旧配置仍不声明OS隔离", () => {
    for (const protocol of ["headless", "acp"] as const) {
      const base = driver(protocol, null); const isolated = driver(protocol); expect(base.capabilities?.workspace_isolation).toBe("shared_lease");
      expect(isolated.capabilities).toMatchObject({ workspace_isolation: "os_sandbox", installation: "unchecked", sandbox: { network: "allowlist", environment: "allowlist", state: "ephemeral" } });
      expect(base.configuration_hash).not.toBe(isolated.configuration_hash); expect(driver(protocol, config({ allowed_domains: ["api.example.com"] })).configuration_hash).not.toBe(isolated.configuration_hash);
    }
    const loaded = parseAgentsYaml(stringify({ agents: { worker: { kind: "headless", bin: process.execPath, args: [fixture, "{{prompt}}"], sandbox: config() } } }));
    expect(createAgentRegistry(loaded.yaml).resolve("worker").capabilities?.workspace_isolation).toBe("os_sandbox");
  });
  it("非法state位置与缺环境零worker调用，不在事实目录创建状态", async () => {
    const path = join(root, "cord/private-state"); const events = await run(driver("headless", config({ state_dir: path })));
    expect(events).toMatchObject([{ type: "error", data: { kind: "configuration" } }]); await expect(access(path)).rejects.toThrow();
    expect(await run(driver("acp", config({ env_allowlist: ["CORD_MISSING_ENV_FIXTURE"] })))).toMatchObject([{ type: "error", data: { kind: "configuration" } }]);
  });
  it("非法readonly与可信安装工作区重叠不能派发可写worker", async () => {
    const worker = driver("headless"); const events: AgentEvent[] = [];
    for await (const event of worker.run({ prompt: "current", cwd: root, readonly: "true" as unknown as boolean })) events.push(event);
    expect(events).toMatchObject([{ type: "error", data: { kind: "configuration" } }]);
    for await (const event of worker.run({ prompt: "current", cwd: fileURLToPath(new URL("../../", import.meta.url)) })) expect(event).toMatchObject({ type: "error", data: { kind: "configuration" } });
    expect(await readFile(join(root, "value.txt"), "utf8")).toBe("initial");
    expect(await run(driver("headless", config({ read_paths: ["/./"] })))).toMatchObject([{ type: "error", data: { kind: "configuration" } }]);
  });
  it("独立helper缺runtime时不裸执行，控制失败来自IPC", async () => {
    const isolated = join(directory, "isolated"); await mkdir(isolated); await cp(fileURLToPath(new URL("../../src", import.meta.url)), join(isolated, "src"), { recursive: true });
    await writeFile(join(isolated, "package.json"), '{"type":"module"}'); await mkdir(join(isolated, "node_modules")); const require_ = createRequire(import.meta.url);
    for (const name of ["zod", "execa", "yaml", "ulid"]) await symlink(fileURLToPath(new URL("../../node_modules/" + name, import.meta.url)), join(isolated, "node_modules", name));
    const scratch = join(directory, "scratch"); await mkdir(scratch);
    const child = fork(join(isolated, "src/driver/worker-sandbox-helper.ts"), [], { execArgv: ["--import", require_.resolve("tsx")], stdio: ["ignore", "ignore", "ignore", "ipc"] });
    const messages: unknown[] = []; child.on("message", message => messages.push(message));
    const closed = new Promise<number | null>(resolve => child.once("close", resolve));
    child.send({ bin: process.execPath, args: ["-e", "require('node:fs').writeFileSync('SHOULD_NOT_RUN','bad')"], cwd: root, scratch, home: scratch, readonly: false, sandbox: WorkerSandboxSchema.parse(config()), git_paths: [], read_paths: [], environment: {} });
    expect(await closed).toBe(1); expect(messages).toEqual([{ kind: "sandbox_failed" }]); await expect(access(join(root, "SHOULD_NOT_RUN"))).rejects.toThrow();
  });
  const native_it = native ? it : it.skip;
  native_it.each(["headless", "acp"] as const)("%s可写代码但保护事实/Git/用户文件，readonly真正拒绝代码写入", async protocol => {
    const private_root = await mkdtemp(join(homedir(), "cord-worker-secret-fixture-")); const secret = join(private_root, "secret"); await writeFile(secret, "FAKE_PRIVATE_MARKER");
    const previous = process.env.CORD_FAKE_PRIVATE; process.env.CORD_FAKE_PRIVATE = "FAKE_ENV_MARKER";
    try {
      const worker = driver(protocol, config(), ["--alias-probes", "--secret", secret, "--outside", join(private_root, "outside")]);
      const writable = result(await run(worker)); expect(writable).toMatchObject({ source_write: "allowed", facts_read: "blocked", facts_write: "blocked", facts_rename: "blocked", facts_link_write: "blocked", facts_symlink_write: "blocked", git_read: "blocked", git_write: "blocked", outside: "blocked", secret: "blocked", private_env: false });
      await writeFile(join(root, "value.txt"), "initial"); const readonly = result(await run(worker, true)); expect(readonly.source_write).toBe("blocked");
      expect(await readFile(join(root, "value.txt"), "utf8")).toBe("initial"); expect(await readFile(join(root, "cord/events.jsonl"), "utf8")).toBe("PROTECTED_FACTS");
      expect(await readFile(join(root, ".git/config"), "utf8")).toBe("PROTECTED_GIT"); await expect(access(writable.home)).rejects.toThrow(); await expect(access(readonly.home)).rejects.toThrow();
    } finally { if (previous === undefined) delete process.env.CORD_FAKE_PRIVATE; else process.env.CORD_FAKE_PRIVATE = previous; await rm(private_root, { recursive: true, force: true }); }
  });
  native_it.each(["headless", "acp"] as const)("%s明确env白名单与持久状态，指定session恢复同一缓存，临时目录仍清理", async protocol => {
    const worker = driver(protocol, config({ state_dir: join(directory, "state"), env_allowlist: ["CORD_FAKE_AUTH"] }), [], { CORD_FAKE_AUTH: "FIXTURE_TOKEN" });
    const first = result(await run(worker)); const second = result(await run(worker, false, true));
    expect(first).toMatchObject({ auth_env: true, count: 1 }); expect(second).toMatchObject({ auth_env: true, count: 2, session: "sandbox-session" }); expect(second.home).toBe(first.home);
    expect(await readFile(join(first.home, "session.txt"), "utf8")).toBe("2"); await expect(access(first.tmp)).rejects.toThrow(); await expect(access(second.tmp)).rejects.toThrow();
  });
  native_it("实际网络只允许明确IP/端口，未知目标不访问本地服务", async () => {
    let hits = 0; const server = createServer((_request, response) => { hits++; response.end("OK"); }); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const allowed = result(await run(driver("headless", config({ allowed_domains: [`127.0.0.1:${port}`] }), ["--url", `http://127.0.0.1:${port}/fixture`]))); expect(allowed.network, JSON.stringify(allowed)).toBe(200); expect(hits).toBe(1);
      const denied = result(await run(driver("headless", config(), ["--url", `http://127.0.0.1:${port}/fixture`]))); expect(denied.network).not.toBe(200); expect(hits).toBe(1);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  native_it("argv保持字面边界，伪造stdout成功不能覆盖真正非零退出", async () => {
    const literal = "$(touch SHOULD_NOT_EXIST) 'quoted' 中文\nnext";
    expect(result(await run(driver("headless", config(), ["--literal", literal]))).literal).toBe(literal); await expect(access(join(root, "SHOULD_NOT_EXIST"))).rejects.toThrow();
    const failed = await run(driver("headless", config(), ["--exit-failure"])); expect(failed.some(event => event.type === "error")).toBe(true);
  });
  native_it("无prompt CLI帮助查询也在同一沙箱，仍不证明模型访问", async () => {
    const worker = new HeadlessDriver({ cli: "codex", bin: process.execPath, prefixArgs: [fixture], sandbox: config(), launch: { model: "fixture-model", effort: "low" } });
    expect(await worker.inspect(root, 10000)).toMatchObject({ status: "passed", profile: "codex", native_resume: "advertised" });
    expect(await readFile(join(root, "value.txt"), "utf8")).toBe("initial");
  });
  native_it("持久状态按工作区和配置分区，不混用其他任务的缓存", async () => {
    const original = root; const state = join(directory, "state"); const worker = driver("headless", config({ state_dir: state })); const first = result(await run(worker));
    root = join(directory, "other-workspace"); await mkdir(root); await writeFile(join(root, "value.txt"), "initial"); const other = result(await run(worker)); root = original;
    const changed = result(await run(driver("headless", config({ state_dir: state, allowed_domains: ["api.example.com"] }))));
    expect(new Set([first.home, other.home, changed.home]).size).toBe(3); expect([first.count, other.count, changed.count]).toEqual([1, 1, 1]);
  });
  native_it.each(["headless", "acp"] as const)("%s读取当前全文中段，实际副本写/改名/chmod/别名拒绝，resume重建副本并清理", async protocol => {
    const session_dir = join(root, "cord/REQ-INPUT"); await mkdir(session_dir); let text = "# HEAD\n" + "a".repeat(30000) + "MID_ONLY 中文" + "b".repeat(30000) + "\nTAIL";
    const input = (): AgentInputDocuments => ({ session_dir, req_id: "REQ-INPUT", files: [{ file: "prd.md", content_hash: sha256Hex(text), content_length: text.length }] });
    await writeFile(join(session_dir, "prd.md"), text); const worker = driver(protocol, config({ state_dir: join(directory, "state") }), ["--operation", "documents"]);
    const first = result(await run(worker, false, false, input()));
    expect(first).toMatchObject({ middle: true, root_matches_prompt: true, literal: true, write: "blocked", rename: "blocked", chmod: "blocked", manifest_write: "blocked", hardlink: "blocked", facts: "blocked", count: 1 });
    expect(first.prompt_chars).toBeLessThanOrEqual(60000); expect(first.manifest.files).toEqual(input().files); await expect(access(first.directory)).rejects.toThrow();
    text += "\nCURRENT_RESUME_INPUT"; await writeFile(join(session_dir, "prd.md"), text);
    const second = result(await run(worker, true, true, input())); expect(second).toMatchObject({ middle: true, root_matches_prompt: true, count: 2 });
    expect(second.manifest.files).toEqual(input().files); expect(second.directory).not.toBe(first.directory); await expect(access(second.directory)).rejects.toThrow();
    expect(await readFile(join(session_dir, "prd.md"), "utf8")).toBe(text);
  });
  native_it("argv任务使用追加后的真实全文根，省略中段可读且字面token保留", async () => {
    const session_dir = join(root, "cord/REQ-INPUT"); await mkdir(session_dir); const text = "MID_ONLY 中文"; await writeFile(join(session_dir, "prd.md"), text);
    const worker = new HeadlessDriver({ cli: "documents", sandbox: config(), template: custom_headless_template("documents", process.execPath,
      [fixture, "--operation", "documents", "--prompt", "{{prompt}}"], undefined) });
    const observed = result(await run(worker, false, false, { session_dir, req_id: "REQ-INPUT", files: [{ file: "prd.md", content_hash: sha256Hex(text), content_length: text.length }] }));
    expect(observed).toMatchObject({ middle: true, root_matches_prompt: true, literal: true }); await expect(access(observed.directory)).rejects.toThrow();
  });
  it("显式输入副本请求在裸driver下拒绝，不能静默只用旧prompt", async () => {
    const input = { session_dir: join(root, "cord/REQ-INPUT"), req_id: "REQ-INPUT", files: [] };
    for (const protocol of ["headless", "acp"] as const) expect(await run(driver(protocol, null), false, false, input)).toMatchObject([{ type: "error", data: { kind: "configuration" } }]);
    expect(await readFile(join(root, "value.txt"), "utf8")).toBe("initial");
  });
  native_it.each(["headless", "acp"] as const)("%s readonly指定恢复保留缓存并继续限制写入，临时HOME无法伪造持久session", async protocol => {
    const worker = driver(protocol, config({ state_dir: join(directory, "state") })); await run(worker);
    const readonly = result(await run(worker, true, true)); expect(readonly).toMatchObject({ count: 2, source_write: "blocked" });
    const ephemeral = driver(protocol); await run(ephemeral); expect((await run(ephemeral, false, true)).some(event => event.type === "error")).toBe(true);
  });
  native_it.each(["headless", "acp"] as const)("%s取消/超时收束忽略SIGTERM的agent与子进程，并清理只读全文副本", async protocol => {
    const session_dir = join(root, "cord/REQ-CANCEL"); await mkdir(session_dir); const content = "# CANCEL_BOUND_INPUT\n"; await writeFile(join(session_dir, "prd.md"), content);
    const input_documents = { session_dir, req_id: "REQ-CANCEL", files: [{ file: "prd.md", content_hash: sha256Hex(content), content_length: content.length }] };
    for (const mode of ["cancel", "timeout"] as const) {
      const worker = driver(protocol, config(), ["--operation", "never"]); const controller = new AbortController(); let pids: number[] = []; let home = ""; const errors: unknown[] = [];
      for await (const event of worker.run({ prompt: "current", cwd: root, input_documents, max_prompt_chars: 60000, timeout_ms: mode === "timeout" ? 1800 : 10000, signal: controller.signal })) {
        const data = event.data as { text?: string; kind?: string };
        if ((event.type === "result" || event.type === "text") && data.text?.startsWith("{\"pids\"")) { const observed = JSON.parse(data.text); pids = observed.pids; home = observed.home; if (mode === "cancel") controller.abort(); }
        if (event.type === "error") errors.push(data);
      }
      expect(pids).toHaveLength(2); expect(errors.length).toBeGreaterThan(0); if (mode === "timeout") expect(errors.some(error => (error as { kind: string }).kind === "timeout")).toBe(true);
      for (const pid of pids) { expect(pid).toBeGreaterThan(0); await expect.poll(() => { try { process.kill(pid, 0); return true; } catch { return false; } }).toBe(false); }
      await expect(access(home)).rejects.toThrow();
    }
  });
});
