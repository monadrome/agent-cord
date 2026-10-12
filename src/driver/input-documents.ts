/** ADR-0101：输入副本只消费宿主快照hash，正文不进入控制IPC或事件流。 */
import { constants, type Stats } from "node:fs";
import { isUtf8 } from "node:buffer";
import { chmod, lstat, mkdir, open, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AgentInputDocumentsSchema, type AgentInputDocuments } from "../core/schema.js";
import { resolveSafeSessionFile } from "../core/session-files.js";
import { canonicalJson, sha256Hex } from "../core/hash.js";

export const INPUT_DOCUMENTS_POLICY = "verified-readonly-documents.v1";
export const INPUT_DOCUMENTS_PROMPT_RESERVE = 4096;
const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const same_file = (before: Stats, after: Stats) => before.dev === after.dev && before.ino === after.ino && before.mode === after.mode
  && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs && after.nlink === 1;

async function read_verified_document(input: AgentInputDocuments, file: AgentInputDocuments["files"][number], remaining_bytes: number, signal?: AbortSignal): Promise<{ text: string; bytes: number }> {
  const path = await resolveSafeSessionFile(input.session_dir, file.file);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat(); const limit = Math.min(MAX_DOCUMENT_BYTES, remaining_bytes);
    if (!before.isFile() || before.nlink !== 1 || before.size > limit) throw new Error("invalid document size");
    const chunks: Buffer[] = []; const buffer = Buffer.alloc(64 * 1024); let bytes = 0;
    for (;;) {
      if (signal?.aborted) throw new Error("cancelled");
      const result = await handle.read(buffer, 0, buffer.length, null); if (result.bytesRead === 0) break;
      bytes += result.bytesRead; if (bytes > limit) throw new Error("document too large");
      chunks.push(Buffer.from(buffer.subarray(0, result.bytesRead)));
    }
    const after = await handle.stat(); const current = await lstat(await resolveSafeSessionFile(input.session_dir, file.file));
    const raw = Buffer.concat(chunks); if (!isUtf8(raw)) throw new Error("invalid UTF8 document");
    const text = raw.toString("utf8");
    if (!same_file(before, after) || !same_file(before, current) || bytes !== before.size || text.length !== file.content_length || sha256Hex(text) !== file.content_hash) throw new Error("document changed");
    return { text, bytes };
  } finally { await handle.close(); }
}

export async function prepare_input_documents(raw: AgentInputDocuments, root: string, scratch: string, signal?: AbortSignal): Promise<string> {
  const input = AgentInputDocumentsSchema.parse(raw);
  const root_info = await lstat(root); if (!root_info.isDirectory() || root_info.isSymbolicLink()) throw new Error("invalid workspace");
  const workspace = await realpath(root); const cord = join(workspace, "cord"); const session = join(cord, input.req_id);
  const cord_info = await lstat(cord); const session_info = await lstat(input.session_dir);
  if (!cord_info.isDirectory() || cord_info.isSymbolicLink() || !session_info.isDirectory() || session_info.isSymbolicLink()
    || await realpath(input.session_dir) !== session || await realpath(cord) !== cord) throw new Error("foreign session");
  const destination = join(scratch, "input-documents"); const directories = new Set<string>([destination]); let bytes = 0;
  await mkdir(destination, { mode: 0o700 });
  const files = [...input.files].sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
  for (const file of files) {
    if (signal?.aborted) throw new Error("cancelled");
    const content = await read_verified_document(input, file, MAX_TOTAL_BYTES - bytes, signal); bytes += content.bytes;
    const target = join(destination, "documents", file.file); let directory = dirname(target);
    for (;;) { directories.add(directory); if (directory === destination) break; directory = dirname(directory); }
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, content.text, { flag: "wx", mode: 0o400 });
  }
  // 较早复制的文档可能在后续文件读取时变化；封存前再核验整组当前材料。
  let current_bytes = 0;
  for (const file of files) current_bytes += (await read_verified_document(input, file, MAX_TOTAL_BYTES - current_bytes, signal)).bytes;
  const manifest = { policy: INPUT_DOCUMENTS_POLICY, req_id: input.req_id, files };
  await writeFile(join(destination, "manifest.json"), canonicalJson(manifest), { flag: "wx", mode: 0o400 });
  for (const directory of [...directories].sort((a, b) => b.length - a.length)) await chmod(directory, 0o500);
  if (signal?.aborted) throw new Error("cancelled");
  return destination;
}

export function input_documents_prompt(prompt: string, root: string, max_chars = 60000): string {
  if (!Number.isSafeInteger(max_chars) || max_chars < 0) throw new Error("invalid prompt budget");
  const instructions = `\n\n## 宿主只读全文输入\ninput_documents_root: ${JSON.stringify(root)}\ninput_documents_manifest: ${JSON.stringify(join(root, "manifest.json"))}\n- 原cord需求文档定位符对应本目录documents/<file>；仅清单文件可用。此副本绑定本次快照，不包含事件/账本或其他需求。\n- 可按需读取省略全文，不能修改、移动或替换副本；没有实际读取的材料不能声称已核验。原cord/Git目录仍禁止访问。`;
  if (instructions.length > INPUT_DOCUMENTS_PROMPT_RESERVE || prompt.length + instructions.length > max_chars) throw new Error("input locator exceeds prompt budget");
  return prompt + instructions;
}

/** 仅在agent进程收束后解除宿主自己设置的目录模式，保证临时副本可删除。 */
export async function unlock_input_documents(scratch: string, directory: "input-documents" | "pinned-check-assets" = "input-documents"): Promise<void> {
  const visit = async (path: string): Promise<void> => {
    let info; try { info = await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("invalid input cleanup path");
    await chmod(path, 0o700);
    for (const entry of await readdir(path, { withFileTypes: true })) if (entry.isDirectory() && !entry.isSymbolicLink()) await visit(join(path, entry.name));
  };
  await visit(join(scratch, directory));
}
