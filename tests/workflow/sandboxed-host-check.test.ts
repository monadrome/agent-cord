import { native_sandbox_available } from "../helpers/native-sandbox.js";
import { mkdtemp, mkdir, readFile, writeFile, rm, access, copyFile, symlink } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { fork } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runHostCheck, goalCommandHash } from "../../src/workflow/host-verification.js";
import { GoalConfigSchema } from "../../src/core/schema.js";
import { canonicalJson, sha256Hex } from "../../src/core/hash.js";

let root: string;
const sandbox = "readonly_workspace" as const;
const native_available = native_sandbox_available;
const command = (script: string, timeout_ms = 5000, args: string[] = []) => ({ id: "check", bin: process.execPath, args: ["-e", script, ...args], timeout_ms });
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "cord-sandbox-check-")); await writeFile(join(root, "value.txt"), "initial"); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("宿主检查严格只读沙箱", () => {
  it("发布严格mode，显式模式改变检查hash而裸模式保持旧身份", () => {
    const base = { inputs: ["value.txt"], checks: [command("process.exit(0)")] };
    expect(GoalConfigSchema.parse({ ...base, check_sandbox: sandbox })).toMatchObject({ check_sandbox: sandbox });
    expect(GoalConfigSchema.safeParse({ ...base, check_sandbox: "auto" }).success).toBe(false);
    expect(goalCommandHash(base.checks[0], sandbox)).not.toBe(goalCommandHash(base.checks[0]));
    expect(goalCommandHash(base.checks[0], sandbox)).not.toBe(sha256Hex(canonicalJson({ domain: "cord.goal-command.v2", command: base.checks[0], sandbox, policy: "readonly-workspace.srt-0.0.79.v1" })));
  });

  it("cancel/耗尽预算不启动命令，未知模式fail-closed", async () => {
    const controller = new AbortController(); controller.abort();
    const script = "require('node:fs').writeFileSync('spawned','bad')";
    expect(await runHostCheck(command(script), root, controller.signal, 5000, sandbox)).toMatchObject({ status: "cancelled", exit_code: null });
    expect(await runHostCheck(command(script), root, undefined, 0, sandbox)).toMatchObject({ status: "timeout", exit_code: null });
    await expect(runHostCheck(command(script), root, undefined, 5000, "auto" as typeof sandbox)).rejects.toThrow();
    await expect(access(join(root, "spawned"))).rejects.toThrow();
    await expect(runHostCheck(command(script, 5000, ["NUL\0value"]), root, undefined, 5000, sandbox)).rejects.toThrow(/NUL/);
  });

  it("独立helper缺可选runtime时setup_failed，不能裸执行请求命令", async () => {
    const isolated = await mkdtemp(join(tmpdir(), "cord-sandbox-no-runtime-"));
    const require_ = createRequire(import.meta.url);
    try {
      await mkdir(join(isolated, "workflow")); await mkdir(join(isolated, "core")); await mkdir(join(isolated, "node_modules"));
      await mkdir(join(isolated, "sandbox"));
      await copyFile(fileURLToPath(new URL("../../src/sandbox/linux-bwrap.ts", import.meta.url)), join(isolated, "sandbox/linux-bwrap.ts"));
      await writeFile(join(isolated, "package.json"), '{"type":"module"}');
      await copyFile(fileURLToPath(new URL("../../src/workflow/sandbox-check-helper.ts", import.meta.url)), join(isolated, "workflow/sandbox-check-helper.ts"));
      await copyFile(fileURLToPath(new URL("../../src/core/schema.ts", import.meta.url)), join(isolated, "core/schema.ts"));
      await symlink(dirname(require_.resolve("zod/package.json")), join(isolated, "node_modules/zod"));
      const child = fork(join(isolated, "workflow/sandbox-check-helper.ts"), [], { execArgv: ["--import", require_.resolve("tsx")], stdio: ["ignore", "ignore", "ignore", "ipc"] });
      const messages: unknown[] = []; child.on("message", value => messages.push(value));
      const closed = new Promise<number | null>(resolve => child.once("close", code => resolve(code)));
      child.send({ command: command("require('node:fs').writeFileSync('should-not-run','bad')"), cwd: root, scratch: isolated, git_paths: [] });
      expect(await closed).toBe(1); expect(messages).toEqual([{ kind: "setup_failed" }]); await expect(access(join(root, "should-not-run"))).rejects.toThrow();
    } finally { await rm(isolated, { recursive: true, force: true }); }
  });

  const native_it = native_available ? it : it.skip;
  native_it("实际检查可读源码、只写临时HOME，保护源码/事件/宿主fixture并拒绝网络", async () => {
    await mkdir(join(root, "cord")); await writeFile(join(root, "cord/events.jsonl"), "PROTECTED_FACTS");
    const private_root = await mkdtemp(join(homedir(), "cord-sandbox-secret-fixture-"));
    const secret = join(private_root, "fixture.txt"); await writeFile(secret, "FAKE_CREDENTIAL");
    const server = createServer((request, response) => response.end("reachable")); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const previous = process.env["CORD_TEST_FAKE_SECRET"]; process.env["CORD_TEST_FAKE_SECRET"] = "FAKE_ENV_CREDENTIAL";
    try {
      const script = `const fs=require('node:fs');if(!process.env.HOME?.includes('cord-host-sandbox-'))process.exit(8);(async()=>{const r={source:fs.readFileSync('value.txt','utf8'),env:process.env.CORD_TEST_FAKE_SECRET??null};fs.writeFileSync(process.env.HOME+'/cache','ok');r.cache=fs.readFileSync(process.env.HOME+'/cache','utf8');for(const[k,p]of [['source_write','value.txt'],['facts','cord/events.jsonl'],['outside',process.argv[1]]]){try{fs.writeFileSync(p,'modified');r[k]='allowed'}catch(e){r[k]=e.code}}for(const[k,p]of [['facts_read','cord/events.jsonl'],['secret',process.argv[2]]]){try{fs.readFileSync(p);r[k]='allowed'}catch(e){r[k]=e.code}}try{await fetch('http://127.0.0.1:${port}',{signal:AbortSignal.timeout(1000)});r.network='allowed'}catch{r.network='blocked'}console.log(JSON.stringify(r))})()`;
      const result = await runHostCheck(command(script, 10000, [join(private_root, "outside"), secret]), root, undefined, 10000, sandbox);
      expect(result).toMatchObject({ status: "passed", exit_code: 0, spawn_error: false, command_hash: goalCommandHash(command(script, 10000, [join(private_root, "outside"), secret]), sandbox) });
      const observed = JSON.parse(result.stdout_tail);
      expect(observed).toMatchObject({ source: "initial", env: null, cache: "ok", network: "blocked" });
      for (const key of ["source_write", "facts", "outside", "facts_read", "secret"]) expect(observed[key], key).not.toBe("allowed");
      expect(await readFile(join(root, "value.txt"), "utf8")).toBe("initial"); expect(await readFile(join(root, "cord/events.jsonl"), "utf8")).toBe("PROTECTED_FACTS");
      expect(JSON.stringify(result)).not.toContain("FAKE_ENV_CREDENTIAL"); expect(JSON.stringify(result)).not.toContain("FAKE_CREDENTIAL");
    } finally { if (previous === undefined) delete process.env["CORD_TEST_FAKE_SECRET"]; else process.env["CORD_TEST_FAKE_SECRET"] = previous; await new Promise<void>(resolve => server.close(() => resolve())); await rm(private_root, { recursive: true, force: true }); }
  });

  native_it("argv字面文本/非零/信号退出不能制造通过，输出hash绑定真实检查", async () => {
    const literal = "$(touch SHOULD_NOT_EXIST) 'quoted' ! 中文\nline";
    const result = await runHostCheck(command("process.stdout.write(process.argv[1],()=>process.exit(3))", 5000, [literal]), root, undefined, 5000, sandbox);
    expect(result).toMatchObject({ status: "failed", exit_code: 3, stdout_hash: sha256Hex(literal), stdout_tail: literal, spawn_error: false });
    await expect(access(join(root, "SHOULD_NOT_EXIST"))).rejects.toThrow();
    expect(await runHostCheck(command("process.kill(process.pid,'SIGTERM')"), root, undefined, 5000, sandbox)).toMatchObject({ status: "failed", exit_code: process.platform === "linux" ? 143 : null });
    expect(await runHostCheck({ id: "missing", bin: "cord-sandbox-missing-command", args: [], timeout_ms: 5000 }, root, undefined, 5000, sandbox)).toMatchObject({ status: "failed", spawn_error: true, exit_code: null });
  });

  native_it("检查stdout伪造成功控制JSON不能覆盖实际非零退出", async () => {
    const spoofed = JSON.stringify({ kind: "completed", exit_code: 0, signal: null, spawn_error: false });
    const result = await runHostCheck(command("process.stdout.write(process.argv[1],()=>process.exit(3))", 5000, [spoofed]), root, undefined, 5000, sandbox);
    expect(result).toMatchObject({ status: "failed", exit_code: 3, stdout_hash: sha256Hex(spoofed), stdout_tail: spoofed });
  });

  native_it.each(["timeout", "cancel"])("%s收束严格检查进程树、输出无伪造passed", async mode => {
    const controller = new AbortController();
    const script = "const child=require('node:child_process').spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'});process.on('SIGTERM',()=>{});console.log(JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000)";
    const timer = mode === "cancel" ? setTimeout(() => controller.abort(), 1500) : undefined;
    try {
      const result = await runHostCheck(command(script, mode === "timeout" ? 1500 : 5000), root, controller.signal, 5000, sandbox);
      expect(result.status).toBe(mode === "timeout" ? "timeout" : "cancelled");
      const pids: number[] = JSON.parse(result.stdout_tail.trim()); expect(pids).toHaveLength(2);
      for (const pid of pids) { expect(pid).toBeGreaterThan(0); await expect.poll(() => { try { process.kill(pid, 0); return true; } catch { return false; } }).toBe(false); }
    } finally { if (timer) clearTimeout(timer); }
  });

  native_it("不同工作区并发检查的scratch和源码不交叉", async () => {
    const other = await mkdtemp(join(tmpdir(), "cord-sandbox-other-")); await writeFile(join(other, "value.txt"), "second");
    try {
      const result = await Promise.all([root, other].map(cwd => runHostCheck(command("console.log(JSON.stringify({source:require('node:fs').readFileSync('value.txt','utf8'),home:process.env.HOME,tmp:process.env.TMPDIR}))"), cwd, undefined, 5000, sandbox)));
      expect(result.map(item => item.status)).toEqual(["passed", "passed"]);
      const values = result.map(item => JSON.parse(item.stdout_tail)); expect(values.map(value => value.source)).toEqual(["initial", "second"]); expect(values[0].home).not.toBe(values[1].home);
      for (const value of values) { expect(value.tmp).toBe(value.home); await expect(access(value.home)).rejects.toThrow(); }
    } finally { await rm(other, { recursive: true, force: true }); }
  });
});
