import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runHostCheck } from "../../src/workflow/host-verification.js";
import { sha256Hex } from "../../src/core/hash.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "cord-host-check-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function command(script: string, timeout_ms = 5000) { return { id: "test", bin: process.execPath, args: ["-e", script], timeout_ms }; }
function alive(pid: number) { try { process.kill(pid, 0); return true; } catch { return false; } }

describe("宿主验证命令", () => {
  it("只接受真实退出码，记录完整输出 hash，保留有界尾部", async () => {
    const text = "x".repeat(20000) + "THE_END";
    const result = await runHostCheck(command("process.stdout.write('x'.repeat(20000)+'THE_END', () => { process.stderr.write('failed'); process.exit(3); })"), root);
    expect(result).toMatchObject({ status: "failed", exit_code: 3, stdout_hash: sha256Hex(text), stderr_hash: sha256Hex("failed"), spawn_error: false });
    expect(result.stdout_tail.length).toBeLessThanOrEqual(6000); expect(result.stdout_tail).toContain("THE_END");
  });
  it("argv 不经 shell，参数中的命令替换保持普通文本", async () => {
    const result = await runHostCheck({ id: "literal", bin: process.execPath, args: ["-e", "process.stdout.write(process.argv[1])", "$(touch SHOULD_NOT_EXIST)"], timeout_ms: 5000 }, root);
    expect(result).toMatchObject({ status: "passed", exit_code: 0, stdout_tail: "$(touch SHOULD_NOT_EXIST)" });
  });
  it.each(["timeout", "cancel"])("%s 杀掉静默验证的父子进程", async mode => {
    const controller = new AbortController();
    const script = "const fs=require('node:fs'); const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); fs.writeFileSync('pids.json',JSON.stringify([process.pid,c.pid])); setInterval(()=>{},1000)";
    const timer = mode === "cancel" ? setTimeout(() => controller.abort(), 350) : undefined;
    try {
      const result = await runHostCheck(command(script, mode === "timeout" ? 350 : 5000), root, controller.signal);
      expect(result.status).toBe(mode === "cancel" ? "cancelled" : "timeout");
      const pids: number[] = JSON.parse(await readFile(join(root, "pids.json"), "utf8"));
      for (let attempt = 0; attempt < 30 && pids.some(alive); attempt++) await new Promise(resolve => setTimeout(resolve, 20));
      expect(pids.map(alive)).toEqual([false, false]);
    } finally { if (timer) clearTimeout(timer); }
  });
  it("命令启动失败与预先取消都不产生伪造的零退出码", async () => {
    expect(await runHostCheck({ id: "missing", bin: "cord-missing-test-binary-32904", args: [], timeout_ms: 1000 }, root)).toMatchObject({ status: "failed", exit_code: null, spawn_error: true });
    const controller = new AbortController(); controller.abort();
    expect(await runHostCheck(command("process.exit(0)"), root, controller.signal)).toMatchObject({ status: "cancelled", exit_code: null });
  });
});
