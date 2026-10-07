/** 文档与文件证据的共享边界（ADR-0028/0036）；不替代 worker 的 OS 权限。 */
import { constants, type Stats } from "node:fs";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, realpath, rename, rm, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { EVENTS_FILE, LEDGER_FILE } from "./session.js";
import { sha256Hex } from "./hash.js";

const RESERVED_COMPONENTS = new Set([EVENTS_FILE, LEDGER_FILE, "agents.yaml", ".git", ".index", ".sdlc"]);

export class SessionFileError extends Error {}

export class SessionFileConflictError extends SessionFileError {
  constructor(readonly actual_hash: string | null) {
    super("代写前观察到文档内容变化，请重新确认最新产物，保留当前文件");
  }
}

/** 词法校验：只允许普通相对文档路径，不允许事实文件与管理目录。 */
export function resolveSessionFile(session_dir: string, file: string): string | null {
  const parts = file.split("/");
  if (
    file.trim().length === 0 || isAbsolute(file) || /^[A-Za-z]:/.test(file) ||
    file.includes("\\") || file.includes("\0") ||
    parts.some((part) => part === "" || part === "." || part === ".." || RESERVED_COMPONENTS.has(part.toLowerCase()))
  ) return null;
  const root = resolve(session_dir);
  const candidate = resolve(root, file);
  const from_root = relative(root, candidate);
  if (!from_root || from_root === ".." || from_root.startsWith(`..${sep}`) || isAbsolute(from_root)) return null;
  return candidate;
}

/** 检查所有已存在路径段；允许尚未创建的普通文档与父目录。 */
export async function resolveSafeSessionFile(session_dir: string, file: string): Promise<string> {
  if (resolveSessionFile(session_dir, file) === null) {
    throw new SessionFileError(`文档 path 越出或不符合 session 目录边界，不得指向事实文件或管理目录：${JSON.stringify(file)}`);
  }
  const root_info = await lstat(resolve(session_dir));
  if (root_info.isSymbolicLink() || !root_info.isDirectory()) throw new SessionFileError("session 文档根路径必须是独立目录，不能是符号链接");
  const root = await realpath(session_dir);
  const parts = file.split("/");
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index]!);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
    if (info.isSymbolicLink()) throw new SessionFileError(`文档路径不能包含符号链接：${file}`);
    if (index < parts.length - 1) {
      if (!info.isDirectory()) throw new SessionFileError(`文档父路径必须是目录：${file}`);
    } else if (!info.isFile() || info.nlink !== 1) {
      throw new SessionFileError(`文档必须是独立的普通文件，不能是目录、特殊文件或硬链接：${file}`);
    }
  }
  return join(root, ...parts);
}

/** 读取与元信息校验共用 no-follow 描述符，缺失叶文件返回 null。 */
async function withSessionDocument<T>(session_dir: string, file: string, inspect: (handle: FileHandle, info: Stats) => Promise<T>): Promise<T | null> {
  const file_path = await resolveSafeSessionFile(session_dir, file);
  let handle;
  try {
    handle = await open(file_path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1) throw new SessionFileError(`文档必须是独立的普通文件：${file}`);
    return await inspect(handle, info);
  } finally {
    await handle.close();
  }
}

/** 不加载正文；文件存在性不把链接、目录、特殊文件当有效证据。 */
export function statSessionDocument(session_dir: string, file: string): Promise<Stats | null> {
  return withSessionDocument(session_dir, file, async (_handle, info) => info);
}

/** 缺失返回 null，其余错误上抛，不能把读取故障当作未生成文档。 */
export function readSessionDocument(session_dir: string, file: string): Promise<string | null> {
  return withSessionDocument(session_dir, file, (handle) => handle.readFile("utf8"));
}

/** 独占临时文件 + fsync + rename，失败时清理临时文件。 */
export async function writeSessionDocument(
  session_dir: string,
  file: string,
  content: string,
  options: { expected_hash?: string | null } = {},
): Promise<void> {
  const check_expected = async (): Promise<void> => {
    if (options.expected_hash === undefined) return;
    const current = await readSessionDocument(session_dir, file);
    const actual_hash = current === null ? null : sha256Hex(current);
    if (actual_hash !== options.expected_hash) throw new SessionFileConflictError(actual_hash);
  };
  const file_path = await resolveSafeSessionFile(session_dir, file);
  await check_expected();
  await mkdir(dirname(file_path), { recursive: true });
  await resolveSafeSessionFile(session_dir, file);
  const temporary = join(dirname(file_path), `.cord-${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await resolveSafeSessionFile(session_dir, file);
    await check_expected();
    await rename(temporary, file_path);
  } finally {
    await rm(temporary, { force: true });
  }
}
