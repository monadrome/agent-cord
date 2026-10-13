/** ADR-0096：整个server工作单元的linked worktree，非OS沙箱。 */
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { execa } from "execa";
import type { AgentDriver, AgentEvent, AgentTask } from "../core/ports.js";
import { canonicalJson, sha256Hex } from "../core/hash.js";
import { resume_session_error, task_timeout_error } from "../driver/task-preflight.js";

export interface LinkedWorktree {
  root: string;
  git_directory: string;
  common_directory: string;
  head_commit: string;
  identity_hash: string;
}

export class WorktreeError extends Error {}
const CONTROL = /[\x00-\x1f\x7f]/;
const COMMIT = /^[0-9a-f]{40,64}$/;

function valid_path(value: string): void {
  if (value.trim().length === 0 || CONTROL.test(value)) throw new WorktreeError("工作树路径不能为空或包含控制字符");
}

async function git(cwd: string, args: string[], signal?: AbortSignal, timeout_ms = 5000): Promise<string> {
  // Git路径/config环境覆盖可能改变仓库或执行hook；本次本地操作不继承这些覆盖。
  const env = Object.fromEntries(Object.keys(process.env).filter(name => name.startsWith("GIT_")).map(name => [name, undefined]));
  try {
    const result = await execa("git", ["--no-replace-objects", "-c", "core.hooksPath=/dev/null", "-c", "submodule.recurse=false", ...args], {
      cwd, env, timeout: timeout_ms, cancelSignal: signal, forceKillAfterDelay: 1000, maxBuffer: 1024 * 1024, reject: false,
    });
    if (result.failed || result.exitCode !== 0) throw new WorktreeError("Git工作树操作未确认，请检查Git安装、仓库与目标目录");
    return result.stdout;
  } catch { throw new WorktreeError("Git工作树操作未确认，请检查Git安装、仓库与目标目录"); }
}

async function plain_directory(path: string): Promise<string> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new WorktreeError("工作树根和Git元数据必须是普通目录");
  return realpath(path);
}

/** 普通目录/主工作树/子模块不推断更强隔离；坏gitfile不能冒充可用工作树。 */
export async function read_worktree(root: string, signal?: AbortSignal, timeout_ms = 5000): Promise<LinkedWorktree | null> {
  valid_path(root);
  if (task_timeout_error(timeout_ms) !== null) throw new WorktreeError("工作树查询timeout无效");
  const deadline = Date.now() + timeout_ms;
  let canonical_root: string;
  try { canonical_root = await plain_directory(resolve(root)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  valid_path(canonical_root);
  const query = (args: string[]) => {
    if (Date.now() >= deadline) throw new WorktreeError("工作树查询超时");
    return git(canonical_root, args, signal, Math.min(5000, deadline - Date.now()));
  };
  let metadata;
  try { metadata = await lstat(join(canonical_root, ".git")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw new WorktreeError("无法读取工作树Git身份"); }
  if (metadata.isDirectory()) return null;
  if (!metadata.isFile() || metadata.nlink !== 1) throw new WorktreeError("工作树gitfile必须是独立普通文件");
  const top = await query(["rev-parse", "--path-format=absolute", "--show-toplevel"]);
  const git_directory = await plain_directory(await query(["rev-parse", "--absolute-git-dir"]));
  const common_directory = await plain_directory(await query(["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  if (await realpath(top) !== canonical_root) throw new WorktreeError("server必须绑定实际工作树根目录");
  if (git_directory === common_directory) return null;
  const backlink = join(git_directory, "gitdir"); const backlink_info = await lstat(backlink);
  if (!backlink_info.isFile() || backlink_info.nlink !== 1 || backlink_info.size > 4096) throw new WorktreeError("工作树Git反向引用不可验证");
  const backlink_path = (await readFile(backlink, "utf8")).replace(/\r?\n$/, "");
  if (await realpath(backlink_path) !== join(canonical_root, ".git")) throw new WorktreeError("工作树Git反向引用与当前根不匹配");
  // Git2.34不支持此处-z；禁用非ASCII引用，当前根拒绝控制字符，引用路径严格解码。
  const registered = (await query(["-c", "core.quotePath=false", "worktree", "list", "--porcelain"])).split("\n\n").map(record => {
    const value = record.split("\n").find(field => field.startsWith("worktree "))?.slice("worktree ".length);
    if (value === undefined) return undefined;
    try { const path: unknown = value.startsWith('"') ? JSON.parse(value) : value; return typeof path === "string" && !CONTROL.test(path) ? path : undefined; }
    catch { return undefined; }
  }).filter((path): path is string => path !== undefined);
  let found = false;
  for (const path of registered) {
    try { if (await realpath(path) === canonical_root) found = true; }
    catch { /* 不存在的其他工作树不影响当前登记核验。 */ }
  }
  if (!found) throw new WorktreeError("当前目录不是Git登记的linked工作树");
  const head_commit = await query(["rev-parse", "--verify", "HEAD^{commit}"]);
  if (!COMMIT.test(head_commit)) throw new WorktreeError("工作树commit身份不可验证");
  const directories = await Promise.all([canonical_root, git_directory, common_directory].map(async path => {
    const info = await lstat(path); return { path, dev: info.dev, ino: info.ino };
  }));
  const identity_hash = sha256Hex(canonicalJson({ domain: "cord.worktree-directory.v1", directories }));
  return { root: canonical_root, git_directory, common_directory, head_commit, identity_hash };
}

function inside(path: string, parent: string): boolean {
  const suffix = relative(parent, path);
  return suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !suffix.startsWith(sep));
}

/** 只从明确commit创建新detached工作树；不复制dirty输入、不force、不自动删除未知结果。 */
export async function create_worktree(source_root: string, destination: string, base_ref?: string): Promise<LinkedWorktree> {
  valid_path(source_root); valid_path(destination);
  if (base_ref !== undefined && (base_ref.trim().length === 0 || base_ref.startsWith("-") || CONTROL.test(base_ref))) throw new WorktreeError("base必须是明确Git引用或commit");
  const source = await plain_directory(await git(resolve(source_root), ["rev-parse", "--show-toplevel"]));
  const common = await plain_directory(await git(source, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  const target = join(await plain_directory(dirname(resolve(destination))), basename(resolve(destination)));
  if (inside(target, source) || inside(target, common) || inside(source, target)) throw new WorktreeError("目标工作树必须在源工作树与Git公共目录之外");
  try { await lstat(target); throw new WorktreeError("目标路径已存在，不覆盖或复用用户目录"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (base_ref === undefined && (await git(source, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).length > 0) {
    throw new WorktreeError("源工作树有未提交改动；请先提交，或用--base明确选择已有commit（不会复制dirty文件）");
  }
  const commit = await git(source, ["rev-parse", "--verify", "--end-of-options", `${base_ref ?? "HEAD"}^{commit}`]);
  if (!COMMIT.test(commit)) throw new WorktreeError("base不是可核验commit");
  const state_paths = (await git(source, ["ls-tree", "-r", "--name-only", "-z", commit, "--", "cord"])).split("\0").filter(Boolean);
  if (state_paths.some(path => !["cord/agents.yaml", "cord/cord.toml"].includes(path) && !path.startsWith("cord/knowledge/"))) {
    throw new WorktreeError("base包含既有需求或运行管理数据，不能隐式复制授权；请选择只含代码/配置的commit，已有需求迁移需单独处理");
  }
  await mkdir(target, { mode: 0o700 });
  try {
    await git(source, ["worktree", "add", "--detach", "--no-guess-remote", "--", target, commit], undefined, 30000);
    const worktree = await read_worktree(target);
    if (worktree === null || worktree.head_commit !== commit || worktree.common_directory !== common) throw new WorktreeError("新工作树身份与请求commit不匹配");
    return worktree;
  } catch { throw new WorktreeError(`工作树创建结果未确认，保留现场；请检查目标 ${JSON.stringify(target)} 与git worktree list，不自动删除或重放`); }
}

/** 每次派发前核验物理工作树；HEAD变化由实际源码输入约束，元数据/root不能偷偷替换。 */
export async function assert_worktree(worktree: LinkedWorktree, cwd = worktree.root, signal?: AbortSignal, timeout_ms = 5000): Promise<void> {
  const current = await read_worktree(cwd, signal, timeout_ms);
  if (current === null || current.root !== worktree.root || current.git_directory !== worktree.git_directory || current.common_directory !== worktree.common_directory || current.identity_hash !== worktree.identity_hash) {
    throw new WorktreeError("工作树cwd或Git身份已变化，停止派发，请恢复原工作树后重试");
  }
}

function failure(message: string, kind: "agent" | "configuration" | "timeout"): AgentEvent {
  return { type: "error", data: { message, kind } };
}

export function bind_worktree_driver(driver: AgentDriver, worktree: LinkedWorktree | null): AgentDriver {
  if (worktree === null) return driver;
  const binding = { ...worktree };
  const configuration_hash = driver.configuration_hash === undefined ? undefined : sha256Hex(canonicalJson({
    domain: "cord.agent-worktree.v1", driver_hash: driver.configuration_hash,
    root: binding.root, git_directory: binding.git_directory, common_directory: binding.common_directory, identity_hash: binding.identity_hash,
  }));
  const execute = async function* (task: AgentTask, session_id?: string, resume = false): AsyncIterable<AgentEvent> {
    if (task.signal?.aborted) { yield failure("任务已取消", "agent"); return; }
    const error = (task.timeout_ms === undefined ? null : task_timeout_error(task.timeout_ms)) ?? (resume ? resume_session_error(session_id, driver.capabilities?.transport === "headless") : null);
    if (error !== null) { yield failure(error, "configuration"); return; }
    const started = Date.now();
    try { await assert_worktree(binding, task.cwd, task.signal, task.timeout_ms ?? 5000); }
    catch {
      const kind = task.signal?.aborted ? "agent" : task.timeout_ms !== undefined && Date.now() - started >= task.timeout_ms ? "timeout" : "configuration";
      yield failure(kind === "agent" ? "任务已取消" : kind === "timeout" ? "工作树核验超时" : "工作树cwd或Git身份不可验证，停止派发", kind); return;
    }
    if (task.signal?.aborted) { yield failure("任务已取消", "agent"); return; }
    const remaining = task.timeout_ms === undefined ? undefined : task.timeout_ms - (Date.now() - started);
    if (remaining !== undefined && remaining <= 0) { yield failure("工作树派发前核验超时", "timeout"); return; }
    const current_task = remaining === undefined ? task : { ...task, timeout_ms: remaining };
    yield* resume ? driver.resume(session_id!, current_task) : driver.run(current_task);
    if (task.signal?.aborted) { yield failure("任务已取消", "agent"); return; }
    const post_budget = task.timeout_ms === undefined ? 5000 : task.timeout_ms - (Date.now() - started);
    if (post_budget <= 0) { yield failure("工作树任务总时长已超限", "timeout"); return; }
    try { await assert_worktree(binding, task.cwd, task.signal, post_budget); }
    catch {
      const kind = task.signal?.aborted ? "agent" : task.timeout_ms !== undefined && Date.now() - started >= task.timeout_ms ? "timeout" : "configuration";
      yield failure(kind === "agent" ? "任务已取消" : kind === "timeout" ? "工作树核验超时" : "执行期间工作树Git身份已变化或不可验证，不能采用本次结果", kind);
    }
  };
  return { name: driver.name, configuration_hash,
    ...(driver.capabilities === undefined ? {} : { capabilities: { ...driver.capabilities, workspace_isolation: driver.capabilities.workspace_isolation === "os_sandbox" ? "os_sandbox" : "worktree" } }),
    run: task => execute(task), resume: (session_id, task) => execute(task, session_id, true),
  };
}
