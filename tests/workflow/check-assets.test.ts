import { native_sandbox_available } from "../helpers/native-sandbox.js";
import { mkdtemp, mkdir, readFile, writeFile, rm, access, symlink, link, open, chmod } from "node:fs/promises";
import * as fs from "node:fs/promises";
import * as child_process from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GoalCommandSchema, GoalConfigSchema, type GoalCommand } from "../../src/core/schema.js";
import { canonicalJson, sha256Hex } from "../../src/core/hash.js";
import { verify_check_assets, check_assets_hash, prepare_check_assets, unlock_check_assets } from "../../src/workflow/check-assets.js";
import { runHostCheck, goalCommandHash } from "../../src/workflow/host-verification.js";

let directory: string; let root: string; let assets_root: string; let scratch: string;
const native = native_sandbox_available;
const verifier = "const fs=require('node:fs');if(fs.readFileSync('value.txt','utf8')!=='fixed')process.exit(3);console.log('TRUSTED_ASSET_PASSED');";
const pin = (text = verifier) => ({ root: assets_root, files: [{ file: "verify.cjs", content_hash: sha256Hex(text) }] });
const command = (text = verifier): GoalCommand => ({ id: "business", bin: process.execPath, args: ["{{check_assets}}/verify.cjs"], timeout_ms: 5000, assets: pin(text) });
vi.mock("node:fs/promises", async importOriginal => {
  const original = await importOriginal<typeof import("node:fs/promises")>(); return { ...original, writeFile: vi.fn(original.writeFile) };
});
vi.mock("node:child_process", async importOriginal => { const original = await importOriginal<typeof import("node:child_process")>(); return { ...original, spawn: vi.fn(original.spawn) }; });
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "cord-check-assets-")); root = join(directory, "workspace"); assets_root = join(directory, "trusted"); scratch = join(directory, "scratch");
  await mkdir(root); await mkdir(assets_root); await mkdir(scratch); await writeFile(join(root, "value.txt"), "fixed"); await writeFile(join(assets_root, "verify.cjs"), verifier); });
afterEach(async () => { vi.mocked(fs.writeFile).mockRestore(); vi.mocked(child_process.spawn).mockRestore(); await unlock_check_assets(scratch); await rm(directory, { recursive: true, force: true }); });

describe("固定独立验证资产", () => {
  it("发布pin只允许明确定位/绝对bin/严格模式，原hash域保持", () => {
    expect(GoalConfigSchema.safeParse({ inputs: ["value.txt"], checks: [command()] }).success).toBe(false);
    expect(GoalConfigSchema.parse({ inputs: ["value.txt"], check_sandbox: "readonly_workspace", checks: [command()] }).checks[0]?.assets).toEqual(pin());
    const plain = { id: "plain", bin: process.execPath, args: ["-e", "process.exit(0)"], timeout_ms: 5000 };
    expect(goalCommandHash(plain)).toBe(sha256Hex(canonicalJson({ domain: "cord.goal-command.v1", command: plain })));
    expect(goalCommandHash(command(), "readonly_workspace")).not.toBe(goalCommandHash({ ...command(), assets: undefined, args: [] }, "readonly_workspace"));
    expect(goalCommandHash(command(), "readonly_workspace")).not.toBe(goalCommandHash(command(verifier + "\n"), "readonly_workspace"));
    const old_sandbox_hash = sha256Hex(canonicalJson({ domain: "cord.goal-command.v3", command: command(), sandbox: "readonly_workspace", policy: "pinned-check-assets.v1", assets_hash: check_assets_hash(pin()) }));
    expect(goalCommandHash(command(), "readonly_workspace")).not.toBe(old_sandbox_hash);
  });
  it.each(["bin", "missing-token", "unlisted-token", "embedded-token", "no-assets", "root", "duplicate", "traversal", "management", "hash"])("严格契约拒绝%s", mode => {
    const changed = structuredClone(command());
    if (mode === "bin") changed.bin = "node";
    if (mode === "missing-token") changed.args = ["verify.cjs"];
    if (mode === "unlisted-token") changed.args = ["{{check_assets}}/other.cjs"];
    if (mode === "embedded-token") changed.args = ["--file={{check_assets}}/verify.cjs"];
    if (mode === "no-assets") delete changed.assets;
    if (mode === "root") changed.assets!.root = "/";
    if (mode === "duplicate") changed.assets!.files.push(changed.assets!.files[0]!);
    if (mode === "traversal") changed.assets!.files[0]!.file = "../verify.cjs";
    if (mode === "management") changed.assets!.files[0]!.file = "cord/events.jsonl";
    if (mode === "hash") changed.assets!.files[0]!.content_hash = "invalid";
    expect(GoalCommandSchema.safeParse(changed).success).toBe(false);
  });
  it("核验外部当前pin，副本字节不改变且能由宿主清理", async () => {
    expect(await verify_check_assets(pin(), root)).toBe(check_assets_hash(pin())); const copy = await prepare_check_assets(pin(), root, scratch);
    expect(await readFile(join(copy, "verify.cjs"), "utf8")).toBe(verifier); await unlock_check_assets(scratch); await rm(copy, { recursive: true }); await expect(access(copy)).rejects.toThrow();
  });
  it.each(["changed", "missing", "symlink", "hardlink", "workspace", "ancestor"])("%s不是可采用固定资产，不能复制或调用", async mode => {
    const assets = pin();
    if (mode === "changed") await writeFile(join(assets_root, "verify.cjs"), "process.exit(0)");
    if (mode === "missing") await rm(join(assets_root, "verify.cjs"));
    if (mode === "symlink") { await rm(join(assets_root, "verify.cjs")); await writeFile(join(directory, "alias.cjs"), verifier); await symlink(join(directory, "alias.cjs"), join(assets_root, "verify.cjs")); }
    if (mode === "hardlink") await link(join(assets_root, "verify.cjs"), join(directory, "alias.cjs"));
    if (mode === "workspace") { assets.root = root; await writeFile(join(root, "verify.cjs"), verifier); }
    if (mode === "ancestor") { assets.root = directory; await writeFile(join(directory, "verify.cjs"), verifier); }
    await expect(verify_check_assets(assets, root)).rejects.toThrow();
    await expect(prepare_check_assets(assets, root, scratch)).rejects.toThrow();
  });
  it("未启用严格沙箱不执行资产命令，取消也零检查调用", async () => {
    expect(await runHostCheck(command(), root)).toMatchObject({ status: "failed", spawn_error: true, exit_code: null });
    const controller = new AbortController(); controller.abort(); expect(await runHostCheck(command(), root, controller.signal, 5000, "readonly_workspace")).toMatchObject({ status: "cancelled", exit_code: null });
  });
  it("单文件实际字节超限先拒绝；二次整组读取拒绝复制中漂移", async () => {
    const handle = await open(join(assets_root, "large.bin"), "w"); try { await handle.truncate(16 * 1024 * 1024 + 1); } finally { await handle.close(); }
    await expect(verify_check_assets({ root: assets_root, files: [{ file: "large.bin", content_hash: sha256Hex("") }] }, root)).rejects.toThrow();
    await writeFile(join(assets_root, "support.txt"), "support"); const original = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).writeFile; let changed = false;
    vi.mocked(fs.writeFile).mockImplementation(async (file, data, options) => { await original(file, data, options); if (!changed && String(file).endsWith("/pinned-check-assets/support.txt")) { changed = true; await original(join(assets_root, "verify.cjs"), "process.exit(0)"); } });
    await expect(prepare_check_assets({ ...pin(), files: [...pin().files, { file: "support.txt", content_hash: sha256Hex("support") }] }, root, scratch)).rejects.toThrow(); expect(changed).toBe(true);
  });
  it("总资产预算不能通过多个独立文件绕过，二进制字节按发布hash复制", async () => {
    const raw = Buffer.from([0xff, 0, 0xfe]); await writeFile(join(assets_root, "binary.bin"), raw);
    const { createHash } = await import("node:crypto"); const hash = createHash("sha256").update(raw).digest("hex");
    const copy = await prepare_check_assets({ root: assets_root, files: [{ file: "binary.bin", content_hash: hash }] }, root, scratch); expect(await readFile(join(copy, "binary.bin"))).toEqual(raw);
    const size = 16 * 1024 * 1024; const content_hash = sha256Hex("\0".repeat(size)); const files = [];
    for (let index = 0; index < 5; index++) { const file = `large-${index}.bin`; const handle = await open(join(assets_root, file), "w"); try { await handle.truncate(size); } finally { await handle.close(); } files.push({ file, content_hash }); }
    await expect(verify_check_assets({ root: assets_root, files }, root)).rejects.toThrow();
  });
  const native_it = native ? it : it.skip;
  native_it("真实独立验证忽略已被改成exit0的本地测试，代码修复后原pin通过", async () => {
    await writeFile(join(root, "local-tests.cjs"), "process.exit(0)"); await writeFile(join(root, "value.txt"), "broken");
    expect(await runHostCheck(command(), root, undefined, 5000, "readonly_workspace")).toMatchObject({ status: "failed", spawn_error: false, exit_code: 3 });
    await writeFile(join(root, "value.txt"), "fixed"); expect(await runHostCheck(command(), root, undefined, 5000, "readonly_workspace")).toMatchObject({ status: "passed", exit_code: 0 });
    expect(await readFile(join(assets_root, "verify.cjs"), "utf8")).toBe(verifier);
  });
  native_it("真实副本保护写/chmod/改名/别名，原资产不可读；字面argv和临时目录清理", async () => {
    const script = `const fs=require('node:fs'),p=require('node:path');const attempts={};for(const[k,f]of Object.entries({write:()=>fs.writeFileSync(__filename,'bad'),chmod:()=>fs.chmodSync(__filename,0o600),rename:()=>fs.renameSync(__dirname,p.join(process.env.HOME,'moved')),alias:()=>{fs.linkSync(__filename,p.join(process.env.HOME,'alias'));fs.writeFileSync(p.join(process.env.HOME,'alias'),'bad')},original:()=>fs.readFileSync(process.argv[2])})){try{f();attempts[k]='allowed'}catch{attempts[k]='blocked'}}console.log(JSON.stringify({attempts,copy:__dirname,arg:process.argv[3]}));`;
    await writeFile(join(assets_root, "verify.cjs"), script); const literal = "$(touch SHOULD_NOT_EXIST) 'quoted' 中文";
    const result = await runHostCheck({ ...command(script), args: ["{{check_assets}}/verify.cjs", join(assets_root, "verify.cjs"), literal] }, root, undefined, 5000, "readonly_workspace");
    expect(result).toMatchObject({ status: "passed", exit_code: 0, spawn_error: false }); const observed = JSON.parse(result.stdout_tail);
    expect(observed.attempts).toEqual({ write: "blocked", chmod: "blocked", rename: "blocked", alias: "blocked", original: "blocked" }); expect(observed.arg).toBe(literal);
    await expect(access(observed.copy)).rejects.toThrow(); await expect(access(join(root, "SHOULD_NOT_EXIST"))).rejects.toThrow();
  });
  native_it("漂移资产不派发检查，不用其新exit0内容认证为通过", async () => {
    await writeFile(join(assets_root, "verify.cjs"), "require('node:fs').writeFileSync(process.env.HOME+'/INVOKED','bad');process.exit(0)");
    expect(await runHostCheck(command(), root, undefined, 5000, "readonly_workspace")).toMatchObject({ status: "failed", spawn_error: true, exit_code: null });
  });
  native_it("可写工作区解释器不属于固定资产的可信执行边界，拒绝启动", async () => {
    const local_bin = join(root, "interpreter"); await writeFile(local_bin, "#!/bin/sh\nexit 0\n"); await chmod(local_bin, 0o700);
    expect(await runHostCheck({ ...command(), bin: local_bin }, root, undefined, 5000, "readonly_workspace")).toMatchObject({ status: "failed", spawn_error: true, exit_code: null });
  });
  native_it("实际检查开始后宿主原资产变化，独立runHostCheck也拒绝旧副本通过", async () => {
    const script = "console.log('PINNED_CHECK_STARTED');setTimeout(()=>process.exit(0),1000)"; await writeFile(join(assets_root, "verify.cjs"), script);
    const original = (await vi.importActual<typeof import("node:child_process")>("node:child_process")).spawn;
    const original_write = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).writeFile; let changed: Promise<void> | undefined;
    vi.mocked(child_process.spawn).mockImplementation((bin, args, options) => {
      const child = original(bin, args, options); child.stdout?.on("data", chunk => {
        if (changed === undefined && String(chunk).includes("PINNED_CHECK_STARTED")) changed = original_write(join(assets_root, "verify.cjs"), "process.exit(0)");
      }); return child;
    });
    const result = await runHostCheck(command(script), root, undefined, 5000, "readonly_workspace");
    expect(result.stdout_tail).toContain("PINNED_CHECK_STARTED"); expect(changed).toBeDefined(); await changed;
    expect(result).toMatchObject({ status: "failed", spawn_error: true, exit_code: 0 });
  });
  native_it.each(["timeout", "cancel"])("%s收束固定资产检查父子进程，保护目录清理且无passed", async mode => {
    const script = "const child=require('node:child_process').spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'});process.on('SIGTERM',()=>{});console.log(JSON.stringify({pids:[process.pid,child.pid],copy:__dirname}));setInterval(()=>{},1000)";
    await writeFile(join(assets_root, "verify.cjs"), script); const controller = new AbortController(); const timer = mode === "cancel" ? setTimeout(() => controller.abort(), 2000) : undefined;
    try {
      const result = await runHostCheck({ ...command(script), timeout_ms: mode === "timeout" ? 2000 : 10000 }, root, controller.signal, 10000, "readonly_workspace");
      expect(result.status).toBe(mode === "cancel" ? "cancelled" : "timeout"); const observed = JSON.parse(result.stdout_tail); expect(observed.pids).toHaveLength(2);
      for (const pid of observed.pids) { expect(pid).toBeGreaterThan(0); await expect.poll(() => { try { process.kill(pid, 0); return true; } catch { return false; } }).toBe(false); }
      await expect(access(observed.copy)).rejects.toThrow();
    } finally { if (timer !== undefined) clearTimeout(timer); }
  });
});
