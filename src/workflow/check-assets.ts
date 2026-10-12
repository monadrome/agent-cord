/** ADR-0102：发布pin核验/副本，实际字节不进入事实或控制IPC。 */
import { constants, type Stats } from "node:fs";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, open, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { canonicalJson, sha256Hex } from "../core/hash.js";
import { GoalCheckAssetsSchema, type GoalCheckAssets } from "../core/schema.js";
import { resolveSafeSessionFile } from "../core/session-files.js";
import { read_worktree } from "../workspace/worktree.js";
import { unlock_input_documents } from "../driver/input-documents.js";

export const CHECK_ASSETS_POLICY = "pinned-check-assets.v1";
const FILE_LIMIT = 16 * 1024 * 1024; const TOTAL_LIMIT = 64 * 1024 * 1024;
const inside = (path: string, parent: string) => { const suffix = relative(parent, path); return suffix === "" || suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix); };
const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mode === b.mode && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && b.nlink === 1;
export function check_assets_hash(assets: GoalCheckAssets): string {
  const parsed = GoalCheckAssetsSchema.parse(assets);
  return sha256Hex(canonicalJson({ domain: "cord.check-assets.v1", root: parsed.root, files: [...parsed.files].sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0), policy: CHECK_ASSETS_POLICY }));
}

async function asset_root(assets: GoalCheckAssets, workspace: string, signal?: AbortSignal): Promise<string> {
  const info = await lstat(assets.root); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("invalid asset root");
  const root = await realpath(assets.root); const cwd = await realpath(workspace);
  const linked = await read_worktree(cwd, signal); const reserved = [cwd, join(cwd, ".git"), ...(linked === null ? [] : [linked.git_directory, linked.common_directory])];
  if (reserved.some(path => inside(root, path) || inside(path, root))) throw new Error("assets overlap workspace");
  return root;
}
async function read_asset(root: string, file: GoalCheckAssets["files"][number], remaining: number, signal?: AbortSignal): Promise<Buffer> {
  const path = await resolveSafeSessionFile(root, file.file); const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat(); const limit = Math.min(FILE_LIMIT, remaining);
    if (!before.isFile() || before.nlink !== 1 || before.size > limit) throw new Error("invalid asset size");
    const chunks: Buffer[] = []; const buffer = Buffer.alloc(64 * 1024); let size = 0;
    for (;;) {
      if (signal?.aborted) throw new Error("cancelled");
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null); if (bytesRead === 0) break;
      size += bytesRead; if (size > limit) throw new Error("asset limit"); chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
    const content = Buffer.concat(chunks); const after = await handle.stat(); const current = await lstat(await resolveSafeSessionFile(root, file.file));
    if (!same(before, after) || !same(before, current) || size !== before.size || createHash("sha256").update(content).digest("hex") !== file.content_hash) throw new Error("asset pin mismatch");
    return content;
  } finally { await handle.close(); }
}

export async function verify_check_assets(value: GoalCheckAssets, workspace: string, signal?: AbortSignal): Promise<string> {
  const assets = GoalCheckAssetsSchema.parse(value); if (signal?.aborted) throw new Error("cancelled"); const root = await asset_root(assets, workspace, signal); let total = 0;
  for (const file of assets.files) total += (await read_asset(root, file, TOTAL_LIMIT - total, signal)).length;
  if (signal?.aborted) throw new Error("cancelled"); return check_assets_hash(assets);
}

export async function prepare_check_assets(value: GoalCheckAssets, workspace: string, scratch: string, signal?: AbortSignal): Promise<string> {
  const assets = GoalCheckAssetsSchema.parse(value); if (signal?.aborted) throw new Error("cancelled"); const root = await asset_root(assets, workspace, signal);
  const destination = join(scratch, "pinned-check-assets"); const directories = new Set([destination]); await mkdir(destination, { mode: 0o700 }); let total = 0;
  for (const file of assets.files) {
    const content = await read_asset(root, file, TOTAL_LIMIT - total, signal); total += content.length;
    const path = join(destination, file.file); let directory = dirname(path);
    for (;;) { directories.add(directory); if (directory === destination) break; directory = dirname(directory); }
    await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await writeFile(path, content, { flag: "wx", mode: 0o400 });
  }
  await verify_check_assets(assets, workspace, signal);
  for (const directory of [...directories].sort((a, b) => b.length - a.length)) await chmod(directory, 0o500);
  return destination;
}

/** 临时资产清理与Worker文档采用同一宿主解锁逻辑，限定明确目录名。 */
export async function unlock_check_assets(scratch: string): Promise<void> { await unlock_input_documents(scratch, "pinned-check-assets"); }
