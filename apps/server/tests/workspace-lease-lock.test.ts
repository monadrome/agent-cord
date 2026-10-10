import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceLease, WorkspaceLeaseBusy, WorkspaceLeaseUnresolved } from "../src/services/workspace-lease.js";

const fixture = fileURLToPath(new URL("../../../tests/driver/fixtures/workspace-lease-holder.mjs", import.meta.url));
let root: string;
const leases: WorkspaceLease[] = [];
const children: ChildProcess[] = [];
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "cord-lease-lock-")); });
afterEach(async () => {
  for (const lease of leases.splice(0)) lease.close();
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) {
    const stopped = once(child, "exit"); child.kill("SIGKILL"); await stopped;
  }
  await rm(root, { recursive: true, force: true });
});
function lock(workspace = root): WorkspaceLease {
  const lease = new WorkspaceLease(workspace); leases.push(lease); return lease;
}
async function holder(pid_file?: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["--import", "tsx", fixture, root, ...(pid_file === undefined ? [] : [pid_file])], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  children.push(child);
  let timeout: NodeJS.Timeout | undefined;
  try {
    const [message] = await Promise.race([
      once(child, "message"), new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("执行锁子进程未就绪")), 5000); }),
    ]);
    expect(message).toEqual({ status: "held" });
  } finally { clearTimeout(timeout); }
  return child;
}

describe("SQLite workspace lease", () => {
  it("同 workspace 不同句柄互斥，相同 owner 幂等，错误 owner 不能释放", () => {
    const first = lock(); const second = lock();
    first.acquire("REQ-A", "run-a"); first.acquire("REQ-A", "run-a");
    expect(() => second.acquire("REQ-B", "run-b")).toThrow(WorkspaceLeaseBusy);
    expect(first.release("REQ-A", "run-b")).toBe(false);
    expect(() => second.acquire("REQ-B", "run-b")).toThrow(WorkspaceLeaseBusy);
    expect(first.release("REQ-A", "run-a")).toBe(true);
    expect(first.release("REQ-A", "run-a")).toBe(false);
    expect(() => second.acquire("REQ-B", "run-b")).not.toThrow();
  });

  it.each(["release", "crash"] as const)("真实子进程 %s 后核验正常释放与未确认标记", async mode => {
    const child = await holder();
    const contender = lock();
    expect(() => contender.acquire("REQ-B", "run-b")).toThrow(WorkspaceLeaseBusy);
    const stopped = once(child, "exit");
    if (mode === "crash") child.kill("SIGKILL"); else child.send({ action: "release" });
    await stopped;
    if (mode === "crash") {
      expect(() => contender.acquire("REQ-B", "run-b")).toThrow(WorkspaceLeaseUnresolved);
      // 此 fixture 无 worker；模拟运维完成核验后的锁修复。
      await rm(join(root, "cord/.index/workspace-lease-owner.json"));
    }
    expect(() => contender.acquire("REQ-B", "run-b")).not.toThrow();
  });

  it("持有进程强杀后 detached worker 仍活着，标记阻断新的执行", async () => {
    const pid_file = join(root, "orphan.pid");
    const child = await holder(pid_file);
    const pid = Number(await readFile(pid_file, "utf8"));
    try {
      const stopped = once(child, "exit"); child.kill("SIGKILL"); await stopped;
      expect(() => process.kill(pid, 0)).not.toThrow();
      expect(() => lock().acquire("REQ-B", "run-b")).toThrow(WorkspaceLeaseUnresolved);
    } finally { try { process.kill(pid, "SIGKILL"); } catch { /* 已收束 */ } }
  });

  it("持有标记被外部修改时拒绝释放，保留异常标记而不自动清除", async () => {
    const first = lock(); first.acquire("REQ-A", "run-a");
    const marker = join(root, "cord/.index/workspace-lease-owner.json");
    await writeFile(marker, JSON.stringify({ lease_id: "other" }));
    expect(() => first.release("REQ-A", "run-a")).toThrow(/无法确认释放/);
    expect(() => lock().acquire("REQ-B", "run-b")).toThrow(WorkspaceLeaseUnresolved);
  });

  it("root 符号路径别名不能绕过真实目录的锁", async () => {
    const alias = join(root, "alias"); await symlink(root, alias);
    const first = lock(); const second = lock(alias);
    first.acquire("REQ-A", "run-a");
    expect(() => second.acquire("REQ-B", "run-b")).toThrow(WorkspaceLeaseBusy);
  });

  it.each(["corrupt", "directory", "symlink"] as const)("%s 锁文件是读取故障，不伪装 busy，修复后可恢复", async kind => {
    await mkdir(join(root, "cord/.index"), { recursive: true });
    const file = join(root, "cord/.index/workspace-lease.sqlite");
    if (kind === "corrupt") await writeFile(file, "INVALID_SQLITE_CONTENT");
    else if (kind === "directory") await mkdir(file);
    else { const target = join(root, "sensitive.txt"); await writeFile(target, "DO_NOT_EDIT"); await symlink(target, file); }
    const lease = lock();
    let error: unknown;
    try { lease.acquire("REQ-A", "run-a"); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ statusCode: 500, code: "internal_error" });
    expect(error).not.toBeInstanceOf(WorkspaceLeaseBusy);
    expect(String(error)).not.toContain("INVALID_SQLITE_CONTENT");
    await rm(file, { recursive: true, force: true });
    expect(() => lease.acquire("REQ-A", "run-a")).not.toThrow();
  });
});
