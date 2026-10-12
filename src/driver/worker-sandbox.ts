/** ADR-0100：共享启动准备，runtime全局状态只存在于每调用helper。 */
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { canonicalJson, sha256Hex } from "../core/hash.js";
import type { AgentTask } from "../core/ports.js";
import { read_worktree } from "../workspace/worktree.js";
import { prepare_input_documents, input_documents_prompt, unlock_input_documents } from "./input-documents.js";

export const WORKER_SANDBOX_POLICY = "workspace.srt-0.0.79.v2";
const absolute_path = z.string().min(1).max(4096).refine(value => isAbsolute(value) && value !== "/" && !/[\x00-\x1f\x7f]/.test(value), "沙箱路径必须是明确绝对路径");
const env_name = z.string().regex(/^[A-Z_][A-Z0-9_]{0,63}$/).refine(value => !/^(HOME|TMPDIR|TMP|TEMP|PATH|LANG|NODE_.*|LD_.*|DYLD_.*|PYTHON.*|BASH_ENV|ENV|SHELL|.*_PROXY|CLOUDSDK_PROXY_.*|JAVA_TOOL_OPTIONS|GIT_SSH_COMMAND|SANDBOX_.*|CORD_INPUT_.*)$/i.test(value), "不能覆盖运行时或沙箱环境");
const domain = z.string().min(1).max(253).regex(/^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::[1-9][0-9]{0,4})?$/).refine(value => !value.includes("..") && (!value.includes(":") || Number(value.split(":")[1]) <= 65535), "网络域名或端口无效");
const unique = <T extends z.ZodType>(schema: T, limit: number) => z.array(schema).max(limit).refine(values => new Set(values).size === values.length, "沙箱配置不能重复").default([]);
export const WorkerSandboxSchema = z.strictObject({ kind: z.literal("workspace"),
  allowed_domains: unique(domain, 64), env_allowlist: unique(env_name, 64), read_paths: unique(absolute_path, 32), state_dir: absolute_path.optional(),
});
export type WorkerSandbox = z.infer<typeof WorkerSandboxSchema>;
export type WorkerSandboxInput = z.input<typeof WorkerSandboxSchema>;
export const WorkerSandboxLaunchSchema = z.strictObject({
  bin: z.string().min(1).refine(value => !value.includes("\0")), args: z.array(z.string().refine(value => !value.includes("\0"))),
  cwd: z.string().min(1), scratch: z.string().min(1), home: z.string().min(1), readonly: z.boolean(),
  sandbox: WorkerSandboxSchema, git_paths: z.array(z.string()), read_paths: z.array(z.string()),
  environment: z.record(z.string(), z.string().refine(value => !value.includes("\0"))),
  input_documents_dir: z.string().min(1).optional(),
});
export type WorkerSandboxLaunch = z.infer<typeof WorkerSandboxLaunchSchema>;
export interface WorkerLaunch { bin: string; args: string[]; env: NodeJS.ProcessEnv; input?: WorkerSandboxLaunch; prompt?: string; cleanup(): Promise<void>; }
const inside = (path: string, parent: string) => { const suffix = relative(parent, path); return suffix === "" || suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix); };
async function state_destination(path: string): Promise<string> {
  try { const info = await lstat(path); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("invalid state"); return await realpath(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return join(await state_destination(dirname(path)), basename(path)); }
}
export function sandbox_capability(sandbox: WorkerSandbox) {
  return { policy: WORKER_SANDBOX_POLICY, network: "allowlist" as const, environment: "allowlist" as const, state: sandbox.state_dir === undefined ? "ephemeral" as const : "persistent" as const, input_documents: "verified_copy" as const };
}

export async function prepare_worker_launch(bin: string, args: string[], task: AgentTask, environment: NodeJS.ProcessEnv, configuration_hash: string, sandbox?: WorkerSandbox, build_args?: (prompt: string) => string[]): Promise<WorkerLaunch> {
  if (sandbox === undefined) {
    if (task.input_documents !== undefined) throw new Error("全文输入副本需要Worker沙箱");
    return { bin, args, env: environment, async cleanup() {} };
  }
  let scratch: string | undefined;
  try {
    if (task.readonly !== undefined && typeof task.readonly !== "boolean") throw new Error("invalid task mode");
    if (task.signal?.aborted || !["darwin", "linux"].includes(process.platform)) throw new Error("unsupported");
    const root_info = await lstat(task.cwd); if (!root_info.isDirectory() || root_info.isSymbolicLink()) throw new Error("invalid root");
    const root = await realpath(task.cwd);
    const trusted_root = await realpath(fileURLToPath(new URL("../../", import.meta.url)));
    if (inside(root, trusted_root) || inside(trusted_root, root)) throw new Error("workspace overlaps trusted installation");
    const linked = await read_worktree(root, task.signal, Math.min(task.timeout_ms ?? 5000, 5000));
    const git_paths = [join(root, ".git"), ...(linked === null ? [] : [linked.git_directory, linked.common_directory])];
    const read_paths = await Promise.all(sandbox.read_paths.map(path => realpath(path)));
    if (read_paths.some(path => path === "/")) throw new Error("unbounded read asset");
    scratch = await realpath(await mkdtemp(join(tmpdir(), "cord-worker-sandbox-")));
    const input_documents_dir = task.input_documents === undefined ? undefined : await prepare_input_documents(task.input_documents, root, scratch, task.signal);
    const prompt = input_documents_dir === undefined ? task.prompt : input_documents_prompt(task.prompt, input_documents_dir, task.max_prompt_chars);
    let home = scratch;
    if (sandbox.state_dir !== undefined) {
      const state = await state_destination(sandbox.state_dir);
      if (inside(state, root) || inside(root, state) || inside(state, trusted_root) || inside(trusted_root, state)
        || git_paths.some(path => inside(state, path) || inside(path, state))) throw new Error("state overlaps workspace");
      await mkdir(state, { recursive: true, mode: 0o700 });
      const state_info = await lstat(state);
      if (!state_info.isDirectory() || state_info.isSymbolicLink() || (state_info.mode & 0o022) !== 0
        || process.getuid !== undefined && state_info.uid !== process.getuid()) throw new Error("unsafe state ownership");
      const namespace = sha256Hex(canonicalJson({ domain: "cord.worker-state.v1", root, configuration_hash }));
      const state_home = join(state, namespace); await mkdir(state_home, { recursive: true, mode: 0o700 });
      const info = await lstat(state_home); if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new Error("invalid home");
      home = await realpath(state_home);
    }
    const selected: Record<string, string> = {};
    for (const name of sandbox.env_allowlist) { const value = environment[name]; if (value === undefined) throw new Error("missing environment"); selected[name] = value; }
    const helper_js = fileURLToPath(new URL("./worker-sandbox-helper.js", import.meta.url));
    const helper = existsSync(helper_js) ? [helper_js] : ["--import", pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href, fileURLToPath(new URL("./worker-sandbox-helper.ts", import.meta.url))];
    const input = WorkerSandboxLaunchSchema.parse({ bin, args: input_documents_dir === undefined || build_args === undefined ? args : build_args(prompt), cwd: root, scratch, home, readonly: task.readonly === true, sandbox, git_paths, read_paths, environment: selected,
      ...(input_documents_dir === undefined ? {} : { input_documents_dir }) });
    let cleanup: Promise<void> | undefined; const private_scratch = scratch;
    return { bin: process.execPath, args: helper, env: { PATH: environment["PATH"] ?? "/usr/bin:/bin", LANG: "C.UTF-8", HOME: scratch, TMPDIR: scratch, TMP: scratch, TEMP: scratch }, input, prompt,
      cleanup: () => cleanup ??= unlock_input_documents(private_scratch).then(() => rm(private_scratch, { recursive: true, force: true })) };
  } catch {
    if (scratch !== undefined) await unlock_input_documents(scratch).then(() => rm(scratch!, { recursive: true, force: true })).catch(() => undefined);
    throw new Error("无法准备Worker沙箱，请核验工作区、只读资产、环境名单与状态目录");
  }
}

const receipt = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("sandbox_started"), policy: z.literal(WORKER_SANDBOX_POLICY) }),
  z.strictObject({ kind: z.literal("sandbox_finished"), exit_code: z.number().int().min(0).nullable(), signal: z.string().nullable() }),
  z.strictObject({ kind: z.literal("sandbox_failed") }),
]);
export function watch_worker_sandbox(child: { getEachMessage?: () => AsyncIterable<unknown> }, enabled: boolean, on_failure: () => void) {
  let started = !enabled; let completed = !enabled; let failed = false;
  let resolve_start!: (value: boolean) => void;
  const ready = enabled ? new Promise<boolean>(resolve => { resolve_start = resolve; }) : Promise.resolve(true);
  if (enabled) void (async () => {
    try {
      if (child.getEachMessage === undefined) throw new Error("missing IPC");
      for await (const value of child.getEachMessage()) {
        const message = receipt.safeParse(value);
        if (!message.success || failed || message.data.kind === "sandbox_failed"
          || message.data.kind === "sandbox_started" && started || message.data.kind === "sandbox_finished" && (!started || completed)) { failed = true; resolve_start(false); on_failure(); return; }
        if (message.data.kind === "sandbox_started") { started = true; resolve_start(true); }
        else if (message.data.kind === "sandbox_finished") { completed = true; if (message.data.exit_code !== 0 || message.data.signal !== null) failed = true; }
      }
    } catch { if (!started) { failed = true; on_failure(); } }
    finally { if (!started) resolve_start(false); }
  })();
  return { wait_ready: () => ready, ready: () => started && !failed, completed: () => completed && !failed };
}
