/** ADR-0041：声明的源码输入清单；只返回摘要，不保存正文。 */
import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { canonicalJson, resolveSessionFile, sha256Hex, type WorkflowDef } from "agent-cord";
import { z } from "zod";

const InputPathsSchema = z.array(z.string().min(1).max(500)).min(1).max(64);
const EXCLUDED_DIRS = new Set([".git", ".index", ".sdlc", "cord", "node_modules", "dist"]);
const MAX_ENTRIES = 10_000;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_DEPTH = 32;

export class VerificationInputError extends Error {}

export interface VerificationSource {
  source_inputs: string[];
  source_hash: string | null;
}

/** 当前节点所有验证检查的声明取并集，保持 context 与每个 gate 的指纹一致。 */
export function verificationSourceInputs(node: WorkflowDef["spec"]["nodes"][number]): string[] {
  const paths: string[] = [];
  for (const gate of node.gates) for (const check of gate.checks) {
    if (check.ref !== "verification-passed" || check.with?.["inputs"] === undefined) continue;
    const parsed = InputPathsSchema.safeParse(check.with["inputs"]);
    if (!parsed.success) throw new VerificationInputError("verification-passed.inputs 必须声明 1-64 个文件或目录路径");
    paths.push(...parsed.data);
  }
  return [...new Set(paths)].sort();
}

function sameMetadata(first: Stats, second: Stats): boolean {
  return first.dev === second.dev && first.ino === second.ino && first.mode === second.mode
    && first.size === second.size && first.mtimeMs === second.mtimeMs && first.ctimeMs === second.ctimeMs;
}

export async function readVerificationSource(workspace_root: string, source_inputs: string[]): Promise<VerificationSource> {
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
    if (entries.has(file)) return;
    if (depth > MAX_DEPTH || entries.size >= MAX_ENTRIES) throw new VerificationInputError("验证输入数量或目录深度超过上限");
    const { absolute, info } = await locate(file);
    if (info.isDirectory()) {
      const names = await directoryNames(absolute);
      entries.set(file, { path: file, kind: "directory", mode: info.mode & 0o777 });
      observed.set(file, { info, names });
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
      const buffer = Buffer.alloc(64 * 1024);
      let read_bytes = 0;
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        read_bytes += bytesRead;
        if (read_bytes > before.size) throw new VerificationInputError(`扫描期间验证输入发生变化：${file}`);
        hash.update(buffer.subarray(0, bytesRead));
      }
      const after = await handle.stat();
      if (!sameMetadata(before, after) || read_bytes !== before.size) throw new VerificationInputError(`扫描期间验证输入发生变化：${file}`);
      total_bytes += read_bytes;
      if (total_bytes > MAX_TOTAL_BYTES) throw new VerificationInputError("验证输入字节数超过上限");
      entries.set(file, { path: file, kind: "file", mode: after.mode & 0o777, content_hash: hash.digest("hex") });
      observed.set(file, { info: after });
    } finally { await handle.close(); }
  };

  for (const file of [...new Set(source_inputs)].sort()) await visit(file, 0);
  // 文件内容、路径类型和目录清单均需仍匹配本次观察；缓存目录不参与身份。
  for (const [file, original] of observed) {
    const { absolute, info } = await locate(file);
    const valid = original.names === undefined ? sameMetadata(original.info, info) && info.nlink === 1
      : info.isDirectory() && info.dev === original.info.dev && info.ino === original.info.ino && info.mode === original.info.mode
        && JSON.stringify(await directoryNames(absolute)) === JSON.stringify(original.names);
    if (!valid) throw new VerificationInputError(`扫描期间验证输入发生变化：${file}`);
  }
  const manifest = [...entries.values()].sort((first, second) => first.path < second.path ? -1 : first.path > second.path ? 1 : 0);
  return { source_inputs: [...new Set(source_inputs)].sort(), source_hash: sha256Hex(canonicalJson({ domain: "cord.verification-source.v1", entries: manifest })) };
}
