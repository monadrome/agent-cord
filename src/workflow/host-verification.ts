/** ADR-0056：宿主真实命令执行；原输出只留内存，事实保存完整流 hash。 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { canonicalJson, sha256Hex } from "../core/hash.js";
import { GoalCommandSchema, GoalCheckSandboxSchema, GoalCheckWorkspaceSchema, type GoalCheckSandbox, type GoalCheckWorkspace, type GoalCommand } from "../core/schema.js";
import { killProcessTree } from "../driver/headless.js";
import { read_worktree } from "../workspace/worktree.js";
import { CHECK_ASSETS_POLICY, check_assets_hash, prepare_check_assets, unlock_check_assets, verify_check_assets } from "./check-assets.js";
import { FROZEN_CHECK_SOURCE_POLICY, prepare_frozen_check_source, unlock_frozen_check_source, verify_frozen_check_source, type FrozenCheckSource } from "./verification-source.js";

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

export const HOST_CHECK_SANDBOX_POLICY = "readonly-workspace.srt-0.0.79.v1";
export function goalCommandHash(command: GoalCommand, sandbox?: GoalCheckSandbox, workspace?: GoalCheckWorkspace): string {
  if (sandbox !== undefined) GoalCheckSandboxSchema.parse(sandbox);
  if (workspace !== undefined) GoalCheckWorkspaceSchema.parse(workspace);
  return sha256Hex(canonicalJson(workspace !== undefined ? { domain: "cord.goal-command.v4", command, sandbox: sandbox ?? null, workspace, policy: HOST_CHECK_SANDBOX_POLICY,
    source_policy: FROZEN_CHECK_SOURCE_POLICY, ...(command.assets === undefined ? {} : { assets_policy: CHECK_ASSETS_POLICY, assets_hash: check_assets_hash(command.assets) }) }
    : command.assets !== undefined ? { domain: "cord.goal-command.v3", command, sandbox: sandbox ?? null, policy: CHECK_ASSETS_POLICY, assets_hash: check_assets_hash(command.assets) }
    : sandbox === undefined ? { domain: "cord.goal-command.v1", command }
    : { domain: "cord.goal-command.v2", command, sandbox, policy: HOST_CHECK_SANDBOX_POLICY }));
}

const completed_schema = z.strictObject({ kind: z.literal("completed"), exit_code: z.number().int().min(0).nullable(), signal: z.string().nullable(), spawn_error: z.boolean() });

export async function runHostCheck(command: GoalCommand, cwd: string, signal?: AbortSignal, remaining_ms = command.timeout_ms, sandbox?: GoalCheckSandbox, frozen_source?: FrozenCheckSource): Promise<HostCheckResult> {
  const checked = GoalCommandSchema.parse(command);
  if (sandbox !== undefined) GoalCheckSandboxSchema.parse(sandbox);
  const started_at = Date.now();
  const stdout_hash = createHash("sha256"); const stderr_hash = createHash("sha256");
  let stdout_tail = Buffer.alloc(0); let stderr_tail = Buffer.alloc(0);
  let cancelled = signal?.aborted === true; let timed_out = remaining_ms <= 0;
  let spawn_error = false; let exit_code: number | null = null;
  let scratch: string | undefined;
  let launch: { bin: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv; input?: { command: GoalCommand; cwd: string; scratch: string; git_paths: string[]; assets_dir?: string; original_cwd?: string } } = { bin: checked.bin, args: checked.args, cwd };
  const budget = Math.min(checked.timeout_ms, remaining_ms);
  const preparation = new AbortController(); const preparation_timer = setTimeout(() => preparation.abort(), Math.max(1, budget));
  const operation_signal = signal === undefined ? preparation.signal : AbortSignal.any([signal, preparation.signal]);
  if ((checked.assets !== undefined || frozen_source !== undefined) && sandbox !== "readonly_workspace" || frozen_source !== undefined && !checked.bin.startsWith("/")) spawn_error = true;
  if (sandbox !== undefined && !cancelled && !timed_out && !spawn_error) {
    try {
      if (!["darwin", "linux"].includes(process.platform)) throw new Error("unsupported");
      const root = await realpath(cwd);
      scratch = await realpath(await mkdtemp(join(tmpdir(), "cord-host-sandbox-")));
      const assets_dir = checked.assets === undefined ? undefined : await prepare_check_assets(checked.assets, root, scratch, operation_signal);
      const check_root = frozen_source === undefined ? root : await prepare_frozen_check_source(root, frozen_source, scratch, operation_signal);
      const linked = await read_worktree(root, operation_signal, Math.max(1, budget - (Date.now() - started_at)));
      const helper_js = fileURLToPath(new URL("./sandbox-check-helper.js", import.meta.url));
      const helper = existsSync(helper_js) ? [helper_js] : ["--import", pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href, fileURLToPath(new URL("./sandbox-check-helper.ts", import.meta.url))];
      const env: NodeJS.ProcessEnv = { HOME: scratch, TMPDIR: scratch, TMP: scratch, TEMP: scratch, PATH: process.env["PATH"] ?? "/usr/bin:/bin", LANG: "C.UTF-8" };
      launch = { bin: process.execPath, args: helper, cwd: root, env,
        input: { command: checked, cwd: check_root, scratch, git_paths: [join(root, ".git"), ...(linked === null ? [] : [linked.git_directory, linked.common_directory])],
          ...(frozen_source === undefined ? {} : { original_cwd: root }),
          ...(assets_dir === undefined ? {} : { assets_dir }) } };
    } catch { spawn_error = true; }
    cancelled = signal?.aborted === true;
    timed_out = Date.now() - started_at >= budget;
  }
  if (!cancelled && !timed_out && !spawn_error) await new Promise<void>(resolve => {
    const child = spawn(launch.bin, launch.args, { cwd: launch.cwd, env: launch.env, detached: process.platform !== "win32", shell: false,
      stdio: launch.input === undefined ? ["ignore", "pipe", "pipe"] : ["ignore", "pipe", "pipe", "ipc"] });
    let sandbox_started = false;
    let sandbox_result: z.infer<typeof completed_schema> | undefined;
    if (launch.input !== undefined) {
      const input = launch.input;
      child.on("message", value => {
        if (z.strictObject({ kind: z.literal("started") }).safeParse(value).success && !sandbox_started && sandbox_result === undefined) sandbox_started = true;
        else {
          const parsed = completed_schema.safeParse(value);
          if (!sandbox_started || sandbox_result !== undefined || !parsed.success) { spawn_error = true; stop(); }
          else sandbox_result = parsed.data;
        }
      });
      child.once("spawn", () => child.send(input, error => { if (error !== null) { spawn_error = true; stop(); } }));
    }
    let force_kill: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      killProcessTree(child, "SIGTERM");
      force_kill ??= setTimeout(() => killProcessTree(child, "SIGKILL"), 500);
    };
    const on_abort = () => { cancelled = true; stop(); };
    const deadline = setTimeout(() => { timed_out = true; stop(); }, Math.max(1, budget - (Date.now() - started_at)));
    signal?.addEventListener("abort", on_abort, { once: true });
    if (signal?.aborted) on_abort();
    child.stdout?.on("data", (chunk: Buffer) => { stdout_hash.update(chunk); stdout_tail = Buffer.from(Buffer.concat([stdout_tail, chunk]).subarray(-6000)); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr_hash.update(chunk); stderr_tail = Buffer.from(Buffer.concat([stderr_tail, chunk]).subarray(-6000)); });
    child.on("error", () => { spawn_error = true; });
    // 父进程退出后仍可能有后台子进程持有管道；回收整组再等待 close。
    child.on("exit", code => {
      exit_code = launch.input === undefined ? code : code === 0 && sandbox_result !== undefined ? sandbox_result.exit_code : null;
      if (launch.input !== undefined && (code !== 0 || sandbox_result === undefined || sandbox_result.spawn_error)) spawn_error = true;
      if (sandbox_result?.signal !== null && sandbox_result?.signal !== undefined) exit_code = null;
      killProcessTree(child, "SIGKILL");
    });
    child.on("close", () => {
      clearTimeout(deadline); if (force_kill !== undefined) clearTimeout(force_kill);
      signal?.removeEventListener("abort", on_abort); resolve();
    });
  });
  if (checked.assets !== undefined && !cancelled && !timed_out && !spawn_error) {
    try { await verify_check_assets(checked.assets, cwd, operation_signal); } catch { spawn_error = true; }
  }
  if (frozen_source !== undefined && !cancelled && !timed_out && !spawn_error) {
    try { await verify_frozen_check_source(cwd, frozen_source, operation_signal); } catch { spawn_error = true; }
  }
  if (scratch !== undefined) try { await unlock_check_assets(scratch); await unlock_frozen_check_source(scratch); await rm(scratch, { recursive: true, force: true }); } catch { spawn_error = true; }
  clearTimeout(preparation_timer); cancelled ||= signal?.aborted === true; timed_out ||= !cancelled && Date.now() - started_at >= budget;
  return {
    command_hash: goalCommandHash(checked, sandbox, frozen_source === undefined ? undefined : "frozen_inputs"), status: cancelled ? "cancelled" : timed_out ? "timeout" : !spawn_error && exit_code === 0 ? "passed" : "failed",
    exit_code, duration_ms: Date.now() - started_at, stdout_hash: stdout_hash.digest("hex"), stderr_hash: stderr_hash.digest("hex"),
    stdout_tail: stdout_tail.toString("utf8"), stderr_tail: stderr_tail.toString("utf8"), spawn_error,
  };
}
