import { native_sandbox_available } from "../helpers/native-sandbox.js";
import * as fs from "node:fs/promises";
import * as child_process from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GoalConfigSchema, type GoalCommand } from "../../src/core/schema.js";
import { readVerificationSource, prepare_frozen_check_source, verify_frozen_check_source, unlock_frozen_check_source, type FrozenCheckSource } from "../../src/workflow/verification-source.js";
import { runHostCheck, goalCommandHash } from "../../src/workflow/host-verification.js";

vi.mock("node:fs/promises", async original => { const actual = await original<typeof import("node:fs/promises")>(); return { ...actual, writeFile: vi.fn(actual.writeFile) }; });
vi.mock("node:child_process", async original => { const actual = await original<typeof import("node:child_process")>(); return { ...actual, spawn: vi.fn(actual.spawn) }; });
let directory: string; let root: string; let scratch: string;
const native = native_sandbox_available;
const command = (script = "process.exit(0)", args: string[] = [], timeout_ms = 5000): GoalCommand => ({ id: "frozen", bin: process.execPath, args: ["-e", script, ...args], timeout_ms });
const source = async (inputs = ["src"]): Promise<FrozenCheckSource> => {
  const value = await readVerificationSource(root, inputs, true); return { source_hash: value.source_hash!, source_manifest: value.source_manifest! };
};
beforeEach(async () => {
  directory = await fs.mkdtemp(join(tmpdir(), "cord-frozen-check-")); root = join(directory, "workspace"); scratch = join(directory, "scratch");
  await fs.mkdir(join(root, "src"), { recursive: true }); await fs.mkdir(scratch); await fs.writeFile(join(root, "src/a.bin"), Buffer.from([0xff, 0, 0xfe])); await fs.chmod(join(root, "src/a.bin"), 0o751);
});
afterEach(async () => { vi.restoreAllMocks(); await unlock_frozen_check_source(scratch); await fs.rm(directory, { recursive: true, force: true }); });

describe("冻结声明源码检查", () => {
  it("发布仅接受严格沙箱/绝对解释器，新命令身份不能复用实时结果", () => {
    const base = { inputs: ["src"], checks: [command()], check_workspace: "frozen_inputs" };
    expect(GoalConfigSchema.safeParse(base).success).toBe(false);
    expect(GoalConfigSchema.parse({ ...base, check_sandbox: "readonly_workspace" }).review_changes).toBeUndefined();
    expect(GoalConfigSchema.safeParse({ ...base, check_sandbox: "readonly_workspace", checks: [{ ...command(), bin: "node" }] }).success).toBe(false);
    expect(GoalConfigSchema.safeParse({ ...base, check_sandbox: "readonly_workspace", check_workspace: "auto" }).success).toBe(false);
    expect(goalCommandHash(command(), "readonly_workspace", "frozen_inputs")).not.toBe(goalCommandHash(command(), "readonly_workspace"));
    expect(() => goalCommandHash(command(), "readonly_workspace", "auto" as "frozen_inputs")).toThrow();
  });
  it("声明目录/空目录/二进制/权限与原身份一致，缓存和范围外内容不复制", async () => {
    await fs.mkdir(join(root, "src/empty")); await fs.mkdir(join(root, "src/node_modules")); await fs.writeFile(join(root, "src/node_modules/ignored"), "private"); await fs.writeFile(join(root, "outside"), "private");
    const original = await source(); const copy = await prepare_frozen_check_source(root, original, scratch);
    expect(await fs.readFile(join(copy, "src/a.bin"))).toEqual(Buffer.from([0xff, 0, 0xfe]));
    expect((await fs.stat(join(copy, "src/a.bin"))).mode & 0o777).toBe(0o751);
    expect(await readVerificationSource(copy, ["src"], true)).toMatchObject(original);
    await expect(fs.access(join(copy, "outside"))).rejects.toThrow(); await expect(fs.access(join(copy, "src/node_modules"))).rejects.toThrow();
    await fs.writeFile(join(root, "src/a.bin"), "changed"); expect(await fs.readFile(join(copy, "src/a.bin"))).toEqual(Buffer.from([0xff, 0, 0xfe]));
    await expect(verify_frozen_check_source(root, original)).rejects.toThrow(/变化/);
  });
  it("仅声明叶文件时创建必要父目录，不复制相邻文件", async () => {
    await fs.writeFile(join(root, "src/unlisted"), "private"); const original = await source(["src/a.bin"]); const copy = await prepare_frozen_check_source(root, original, scratch);
    expect(await readVerificationSource(copy, ["src/a.bin"], true)).toMatchObject(original); expect(await fs.readdir(join(copy, "src"))).toEqual(["a.bin"]);
  });
  it.each(["missing", "added", "deleted", "mode", "type", "symlink", "hardlink", "hash", "manifest", "overlap"])("%s拒绝冻结旧清单", async mode => {
    const original = await source();
    if (mode === "missing" || mode === "deleted") await fs.rm(join(root, "src/a.bin"));
    if (mode === "added") await fs.writeFile(join(root, "src/new"), "new");
    if (mode === "mode") await fs.chmod(join(root, "src/a.bin"), 0o600);
    if (mode === "type") { await fs.rm(join(root, "src/a.bin")); await fs.mkdir(join(root, "src/a.bin")); }
    if (mode === "symlink") { await fs.rm(join(root, "src/a.bin")); await fs.symlink("/etc/passwd", join(root, "src/a.bin")); }
    if (mode === "hardlink") await fs.link(join(root, "src/a.bin"), join(root, "alias"));
    if (mode === "hash") original.source_hash = "a".repeat(64);
    if (mode === "manifest") original.source_manifest = [];
    if (mode === "overlap") { scratch = join(root, "scratch"); await fs.mkdir(scratch); }
    await expect(prepare_frozen_check_source(root, original, scratch)).rejects.toThrow();
  });
  it("复制期间早期文件变化，关闭整组清单而不接纳混合版本", async () => {
    await fs.writeFile(join(root, "src/z.txt"), "later"); const original = await source(); const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises"); let changed = false;
    vi.mocked(fs.writeFile).mockImplementation(async (file, data, options) => { await actual.writeFile(file, data, options); if (String(file).endsWith("frozen-check-workspace/src/z.txt")) { changed = true; await actual.writeFile(join(root, "src/a.bin"), "changed"); } });
    await expect(prepare_frozen_check_source(root, original, scratch)).rejects.toThrow(/变化/); expect(changed).toBe(true);
  });
  it("单文件/总字节与取消有界，部分受限目录能够清理", async () => {
    const original = await source(); const controller = new AbortController(); controller.abort(); await expect(prepare_frozen_check_source(root, original, scratch, controller.signal)).rejects.toThrow();
    await fs.truncate(join(root, "src/a.bin"), 16 * 1024 * 1024 + 1); await expect(prepare_frozen_check_source(root, original, scratch)).rejects.toThrow(/字节数/);
    await unlock_frozen_check_source(scratch); await fs.rm(join(scratch, "frozen-check-workspace"), { recursive: true, force: true });
    await fs.truncate(join(root, "src/a.bin"), 16 * 1024 * 1024);
    for (let index = 0; index < 4; index++) { await fs.writeFile(join(root, `src/large-${index}`), ""); await fs.truncate(join(root, `src/large-${index}`), 16 * 1024 * 1024); }
    await expect(prepare_frozen_check_source(root, original, scratch)).rejects.toThrow(/字节数/);
  });
  it("缺沙箱/相对解释器/取消/已耗尽预算均零执行", async () => {
    const original = await source(); expect(await runHostCheck(command(), root, undefined, 5000, undefined, original)).toMatchObject({ status: "failed", spawn_error: true, exit_code: null });
    expect(await runHostCheck({ ...command(), bin: "node" }, root, undefined, 5000, "readonly_workspace", original)).toMatchObject({ status: "failed", spawn_error: true, exit_code: null });
    const controller = new AbortController(); controller.abort(); expect(await runHostCheck(command(), root, controller.signal, 5000, "readonly_workspace", original)).toMatchObject({ status: "cancelled", exit_code: null });
    expect(await runHostCheck(command(), root, undefined, 0, "readonly_workspace", original)).toMatchObject({ status: "timeout", exit_code: null });
  });
  const native_it = native ? it : it.skip;
  native_it.each(["timeout", "cancel", "io"])("%s在准备阶段停止，部分副本清理且不启动检查", async mode => {
    const original = await source(); const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises"); const controller = new AbortController(); let copied_path: string | undefined;
    vi.mocked(fs.writeFile).mockImplementation(async (file, data, options) => {
      await actual.writeFile(file, data, options);
      if (String(file).includes("/frozen-check-workspace/")) { copied_path = String(file); if (mode === "io") throw Error("fixture copy IO failure"); if (mode === "cancel") controller.abort(); else await new Promise(resolve => setTimeout(resolve, 30)); }
    });
    vi.mocked(child_process.spawn).mockClear(); const result = await runHostCheck(command("process.exit(0)", [], mode === "timeout" ? 10 : 5000), root, controller.signal, 5000, "readonly_workspace", original);
    expect(result.status).toBe(mode === "cancel" ? "cancelled" : mode === "timeout" ? "timeout" : "failed"); expect(result.exit_code).toBeNull(); expect(child_process.spawn).not.toHaveBeenCalled(); expect(copied_path).toBeDefined(); await expect(fs.access(copied_path!)).rejects.toThrow();
  });
  native_it("真实cwd物理副本/模式，OS拒绝写/chmod/改名/硬链接与原根读取，运行后清理", async () => {
    const original = await source(); const script = `const fs=require('node:fs'),p=require('node:path'),results={};for(const[k,f]of Object.entries({write:()=>fs.writeFileSync('src/a.bin','bad'),chmod:()=>fs.chmodSync('src/a.bin',0o600),rename:()=>fs.renameSync(process.cwd(),p.join(process.env.HOME,'moved')),alias:()=>{fs.linkSync('src/a.bin',p.join(process.env.HOME,'alias'));fs.writeFileSync(p.join(process.env.HOME,'alias'),'bad')},original:()=>fs.readFileSync(p.join(process.argv[1],'src/a.bin'))})){try{f();results[k]='allowed'}catch{results[k]='blocked'}}console.log(JSON.stringify({results,cwd:process.cwd(),raw:[...fs.readFileSync('src/a.bin')],mode:fs.statSync('src/a.bin').mode&511}));`;
    const result = await runHostCheck(command(script, [root]), root, undefined, 5000, "readonly_workspace", original); expect(result).toMatchObject({ status: "passed", exit_code: 0, spawn_error: false });
    const observed = JSON.parse(result.stdout_tail); expect(observed.results).toEqual({ write: "blocked", chmod: "blocked", rename: "blocked", alias: "blocked", original: "blocked" }); expect(observed.raw).toEqual([255, 0, 254]); expect(observed.mode).toBe(0o751); expect(observed.cwd).not.toBe(root);
    await expect(fs.access(observed.cwd)).rejects.toThrow(); expect(result.command_hash).toBe(goalCommandHash(command(script, [root]), "readonly_workspace", "frozen_inputs"));
  });
  native_it("复制后原源码在检查期间变化，实际读取仍为原字节且不记录passed", async () => {
    const original = await source(); const actual_fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises"); const actual_child = await vi.importActual<typeof import("node:child_process")>("node:child_process"); let changed: Promise<void> | undefined;
    vi.mocked(child_process.spawn).mockImplementation((bin, args, options) => { const child = actual_child.spawn(bin, args, options); child.stdout?.on("data", chunk => { if (changed === undefined && String(chunk).includes("FROZEN_STARTED")) changed = actual_fs.writeFile(join(root, "src/a.bin"), "changed"); }); return child; });
    const script = "console.log('FROZEN_STARTED');setTimeout(()=>console.log(JSON.stringify([...require('node:fs').readFileSync('src/a.bin')])),400)";
    const result = await runHostCheck(command(script), root, undefined, 5000, "readonly_workspace", original); expect(changed).toBeDefined(); await changed;
    expect(result.stdout_tail).toContain("[255,0,254]"); expect(result).toMatchObject({ status: "failed", spawn_error: true, exit_code: 0 });
  });
  native_it("固定资产和冻结源码共同运行，未声明依赖不能回退原目录", async () => {
    const trusted = join(directory, "trusted"); await fs.mkdir(trusted); const script = "const fs=require('node:fs');if(fs.existsSync('unlisted'))process.exit(8);console.log(JSON.stringify([...fs.readFileSync('src/a.bin')]))";
    await fs.writeFile(join(trusted, "verify.cjs"), script); await fs.writeFile(join(root, "unlisted"), "private"); const original = await source();
    const check = { ...command(), args: ["{{check_assets}}/verify.cjs"], assets: { root: trusted, files: [{ file: "verify.cjs", content_hash: createHash("sha256").update(script).digest("hex") }] } };
    expect(await runHostCheck(check, root, undefined, 5000, "readonly_workspace", original)).toMatchObject({ status: "passed", stdout_tail: "[255,0,254]\n" });
    expect(await runHostCheck(command("require('node:fs').readFileSync('unlisted')"), root, undefined, 5000, "readonly_workspace", original)).toMatchObject({ status: "failed", spawn_error: false, exit_code: 1 });
  });
  native_it("不带固定资产的冻结检查也拒绝原可写工作区解释器", async () => {
    const bin = join(root, "untrusted-bin"); await fs.writeFile(bin, "#!/bin/sh\nexit 0\n"); await fs.chmod(bin, 0o700);
    expect(await runHostCheck({ ...command(), bin, args: [] }, root, undefined, 5000, "readonly_workspace", await source())).toMatchObject({ status: "failed", spawn_error: true, exit_code: null });
  });
  native_it.each(["timeout", "cancel"])("%s收束父子进程并清理冻结树", async mode => {
    const script = "const child=require('node:child_process').spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'});process.on('SIGTERM',()=>{});console.log(JSON.stringify({pids:[process.pid,child.pid],cwd:process.cwd()}));setInterval(()=>{},1000)";
    const controller = new AbortController(); const timer = mode === "cancel" ? setTimeout(() => controller.abort(), 2000) : undefined;
    try { const result = await runHostCheck(command(script, [], mode === "timeout" ? 2000 : 10000), root, controller.signal, 10000, "readonly_workspace", await source());
      expect(result.status).toBe(mode === "cancel" ? "cancelled" : "timeout"); const observed = JSON.parse(result.stdout_tail);
      for (const pid of observed.pids) { expect(pid).toBeGreaterThan(0); await expect.poll(() => { try { process.kill(pid, 0); return true; } catch { return false; } }).toBe(false); }
      await expect(fs.access(observed.cwd)).rejects.toThrow();
    } finally { if (timer !== undefined) clearTimeout(timer); }
  });
});
