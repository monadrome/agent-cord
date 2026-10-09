/** ADR-0056：宿主真实命令执行；原输出只留内存，事实保存完整流 hash。 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { canonicalJson, sha256Hex } from "../core/hash.js";
import { GoalCommandSchema, type GoalCommand } from "../core/schema.js";
import { killProcessTree } from "../driver/headless.js";

export interface HostCheckResult {
  command_hash: string;
  status: "passed" | "failed" | "timeout" | "cancelled";
  exit_code: number | null;
  duration_ms: number;
  stdout_hash: string;
  stderr_hash: string;
  stdout_tail: string;
  stderr_tail: string;
  spawn_error: boolean;
}

export function goalCommandHash(command: GoalCommand): string {
  return sha256Hex(canonicalJson({ domain: "cord.goal-command.v1", command }));
}

export async function runHostCheck(command: GoalCommand, cwd: string, signal?: AbortSignal, remaining_ms = command.timeout_ms): Promise<HostCheckResult> {
  const checked = GoalCommandSchema.parse(command);
  const started_at = Date.now();
  const stdout_hash = createHash("sha256"); const stderr_hash = createHash("sha256");
  let stdout_tail = Buffer.alloc(0); let stderr_tail = Buffer.alloc(0);
  let cancelled = signal?.aborted === true; let timed_out = remaining_ms <= 0;
  let spawn_error = false; let exit_code: number | null = null;
  if (!cancelled && !timed_out) await new Promise<void>(resolve => {
    const child = spawn(checked.bin, checked.args, { cwd, detached: process.platform !== "win32", shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let force_kill: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      killProcessTree(child, "SIGTERM");
      force_kill ??= setTimeout(() => killProcessTree(child, "SIGKILL"), 500);
    };
    const on_abort = () => { cancelled = true; stop(); };
    const deadline = setTimeout(() => { timed_out = true; stop(); }, Math.min(checked.timeout_ms, remaining_ms));
    signal?.addEventListener("abort", on_abort, { once: true });
    if (signal?.aborted) on_abort();
    child.stdout.on("data", (chunk: Buffer) => { stdout_hash.update(chunk); stdout_tail = Buffer.from(Buffer.concat([stdout_tail, chunk]).subarray(-6000)); });
    child.stderr.on("data", (chunk: Buffer) => { stderr_hash.update(chunk); stderr_tail = Buffer.from(Buffer.concat([stderr_tail, chunk]).subarray(-6000)); });
    child.on("error", () => { spawn_error = true; });
    // 父进程退出后仍可能有后台子进程持有管道；回收整组再等待 close。
    child.on("exit", code => { exit_code = code; killProcessTree(child, "SIGKILL"); });
    child.on("close", () => {
      clearTimeout(deadline); if (force_kill !== undefined) clearTimeout(force_kill);
      signal?.removeEventListener("abort", on_abort); resolve();
    });
  });
  return {
    command_hash: goalCommandHash(checked), status: cancelled ? "cancelled" : timed_out ? "timeout" : !spawn_error && exit_code === 0 ? "passed" : "failed",
    exit_code, duration_ms: Date.now() - started_at, stdout_hash: stdout_hash.digest("hex"), stderr_hash: stderr_hash.digest("hex"),
    stdout_tail: stdout_tail.toString("utf8"), stderr_tail: stderr_tail.toString("utf8"), spawn_error,
  };
}
