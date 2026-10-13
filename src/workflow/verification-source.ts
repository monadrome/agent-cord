/** ADR-0041/0103：当前身份与冻结副本共用扫描，正文不进入事件。 */
import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { canonicalJson, sha256Hex } from "../core/hash.js";
import { resolveSessionFile } from "../core/session-files.js";
import { SourceManifestSchema, type SourceManifest } from "../core/schema.js";
import { unlock_input_documents } from "../driver/input-documents.js";

const EXCLUDED_DIRS = new Set([".git", ".index", ".sdlc", "cord", "node_modules", "dist"]);
const MAX_ENTRIES = 10_000;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_DEPTH = 32;

export class VerificationInputError extends Error {}

export interface VerificationSource {
  source_inputs: string[];
  source_hash: string | null;
  source_manifest?: SourceManifest;
}

function sameMetadata(first: Stats, second: Stats): boolean {
  return first.dev === second.dev && first.ino === second.ino && first.mode === second.mode
    && first.size === second.size && first.mtimeMs === second.mtimeMs && first.ctimeMs === second.ctimeMs;
}

async function scan_source(workspace_root: string, source_inputs: string[], include_manifest: boolean, signal?: AbortSignal, destination?: string): Promise<VerificationSource> {
  signal?.throwIfAborted();
  if (source_inputs.length === 0) return { source_inputs: [], source_hash: null };
  const root_info = await lstat(resolve(workspace_root));
  if (!root_info.isDirectory() || root_info.isSymbolicLink()) throw new VerificationInputError("验证工作区必须是普通目录");
  const root = await realpath(workspace_root);
  const entries = new Map<string, { path: string; kind: "file" | "directory"; mode: number; content_hash?: string }>();
  const observed = new Map<string, { info: Stats; names?: string[] }>();
  let total_bytes = 0;

  const locate = async (file: string): Promise<{ absolute: string; info: Stats }> => {
    if (resolveSessionFile(root, file) === null || file.split("/").some((part) => EXCLUDED_DIRS.has(part.toLowerCase()))) {
      throw new VerificationInputError(`验证输入路径越界或属于管理目录：${file}`);
    }
    let current = root;
    const parts = file.split("/");
    let info = root_info;
    for (const [index, part] of parts.entries()) {
      current = join(current, part);
      try { info = await lstat(current); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new VerificationInputError(`声明的验证输入不存在：${file}`);
        throw error;
      }
      if (info.isSymbolicLink() || (index < parts.length - 1 && !info.isDirectory())) {
        throw new VerificationInputError(`验证输入不能经过链接或非目录路径：${file}`);
      }
    }
    return { absolute: current, info };
  };
  const directoryNames = async (absolute: string): Promise<string[]> => {
    const names = await readdir(absolute);
    if (names.length > MAX_ENTRIES) throw new VerificationInputError("验证目录的文件数量超过上限");
    return names.filter((name) => !EXCLUDED_DIRS.has(name.toLowerCase())).sort();
  };
  const visit = async (file: string, depth: number): Promise<void> => {
    signal?.throwIfAborted();
    if (entries.has(file)) return;
    if (depth > MAX_DEPTH || entries.size >= MAX_ENTRIES) throw new VerificationInputError("验证输入数量或目录深度超过上限");
    const { absolute, info } = await locate(file);
    if (info.isDirectory()) {
      const names = await directoryNames(absolute);
      entries.set(file, { path: file, kind: "directory", mode: info.mode & 0o777 });
      observed.set(file, { info, names });
      if (destination !== undefined) await mkdir(join(destination, file), { recursive: true, mode: 0o700 });
      for (const name of names) await visit(`${file}/${name}`, depth + 1);
      return;
    }
    if (!info.isFile() || info.nlink !== 1) throw new VerificationInputError(`验证输入必须是独立普通文件：${file}`);
    if (info.size > MAX_FILE_BYTES || total_bytes + info.size > MAX_TOTAL_BYTES) throw new VerificationInputError("验证输入字节数超过上限");
    const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.nlink !== 1 || !sameMetadata(info, before)) throw new VerificationInputError(`扫描期间验证输入发生变化：${file}`);
      const hash = createHash("sha256");
      const chunks: Buffer[] = [];
      const buffer = Buffer.alloc(64 * 1024);
      let read_bytes = 0;
      for (;;) {
        signal?.throwIfAborted();
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        read_bytes += bytesRead;
        if (read_bytes > before.size) throw new VerificationInputError(`扫描期间验证输入发生变化：${file}`);
        hash.update(buffer.subarray(0, bytesRead));
        if (destination !== undefined) chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
      }
      const after = await handle.stat();
      if (!sameMetadata(before, after) || read_bytes !== before.size) throw new VerificationInputError(`扫描期间验证输入发生变化：${file}`);
      total_bytes += read_bytes;
      if (total_bytes > MAX_TOTAL_BYTES) throw new VerificationInputError("验证输入字节数超过上限");
      entries.set(file, { path: file, kind: "file", mode: after.mode & 0o777, content_hash: hash.digest("hex") });
      observed.set(file, { info: after });
      if (destination !== undefined) {
        const target = join(destination, file); await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, Buffer.concat(chunks), { flag: "wx", mode: 0o600 }); await chmod(target, after.mode & 0o777);
      }
    } finally { await handle.close(); }
  };

  for (const file of [...new Set(source_inputs)].sort()) await visit(file, 0);
  // 文件内容、路径类型和目录清单均需仍匹配本次观察；缓存目录不参与身份。
  for (const [file, original] of observed) {
    signal?.throwIfAborted();
    const { absolute, info } = await locate(file);
    const valid = original.names === undefined ? sameMetadata(original.info, info) && info.nlink === 1
      : info.isDirectory() && info.dev === original.info.dev && info.ino === original.info.ino && info.mode === original.info.mode
        && JSON.stringify(await directoryNames(absolute)) === JSON.stringify(original.names);
    if (!valid) throw new VerificationInputError(`扫描期间验证输入发生变化：${file}`);
  }
  const manifest = [...entries.values()].sort((first, second) => first.path < second.path ? -1 : first.path > second.path ? 1 : 0);
  if (destination !== undefined) for (const entry of [...manifest].reverse()) {
    signal?.throwIfAborted();
    if (entry.kind === "directory") await chmod(join(destination, entry.path), entry.mode);
  }
  return { source_inputs: [...new Set(source_inputs)].sort(), source_hash: sha256Hex(canonicalJson({ domain: "cord.verification-source.v1", entries: manifest })),
    ...(include_manifest ? { source_manifest: SourceManifestSchema.parse(manifest) } : {}) };
}

export function readVerificationSource(workspace_root: string, source_inputs: string[], include_manifest = false, signal?: AbortSignal): Promise<VerificationSource> {
  return scan_source(workspace_root, source_inputs, include_manifest, signal);
}

export const FROZEN_CHECK_SOURCE_POLICY = "frozen-check-source.v1";
export interface FrozenCheckSource { source_hash: string; source_manifest: SourceManifest }

function source_roots(source: FrozenCheckSource): string[] {
  const manifest = SourceManifestSchema.parse(source.source_manifest);
  if (sha256Hex(canonicalJson({ domain: "cord.verification-source.v1", entries: manifest })) !== source.source_hash) throw new VerificationInputError("冻结清单与源码摘要不一致");
  const directories = new Set(manifest.filter(entry => entry.kind === "directory").map(entry => entry.path));
  return manifest.filter(entry => {
    let parent = dirname(entry.path);
    while (parent !== ".") { if (directories.has(parent)) return false; parent = dirname(parent); }
    return true;
  }).map(entry => entry.path);
}

export async function verify_frozen_check_source(workspace: string, source: FrozenCheckSource, signal?: AbortSignal): Promise<void> {
  const current = await readVerificationSource(workspace, source_roots(source), false, signal);
  if (current.source_hash !== source.source_hash) throw new VerificationInputError("冻结检查的原源码发生变化");
}

export async function prepare_frozen_check_source(workspace: string, source: FrozenCheckSource, scratch: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted(); const inputs = source_roots(source); const root = await realpath(workspace); const temporary = await realpath(scratch);
  const inside = (path: string, parent: string) => { const suffix = relative(parent, path); return suffix === "" || suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix); };
  if (inside(temporary, root) || inside(root, temporary)) throw new VerificationInputError("冻结副本必须在工作区之外");
  const destination = join(temporary, "frozen-check-workspace"); await mkdir(destination, { mode: 0o700 });
  const copied = await scan_source(root, inputs, false, signal, destination);
  if (copied.source_hash !== source.source_hash) throw new VerificationInputError("复制期间源码与冻结清单不一致");
  await verify_frozen_check_source(root, source, signal);
  return destination;
}

export async function unlock_frozen_check_source(scratch: string): Promise<void> { await unlock_input_documents(scratch, "frozen-check-workspace"); }
