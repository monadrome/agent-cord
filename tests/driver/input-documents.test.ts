import { mkdtemp, mkdir, writeFile, readFile, rm, access, chmod, symlink, link, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";
import * as fs from "node:fs/promises";
import { AgentInputDocumentsSchema, type AgentInputDocuments } from "../../src/core/schema.js";
import { sha256Hex } from "../../src/core/hash.js";
import { prepare_input_documents, input_documents_prompt, INPUT_DOCUMENTS_PROMPT_RESERVE, unlock_input_documents } from "../../src/driver/input-documents.js";

vi.mock("node:fs/promises", async importOriginal => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, writeFile: vi.fn(original.writeFile) };
});

let root: string; let session_dir: string; let scratch: string;
const req_id = "REQ-DOCUMENTS";
const text = "# PRD\nHEAD\n" + "a".repeat(30000) + "MID_ONLY 中文\n" + "b".repeat(30000) + "\nTAIL\n";
function input(file = "prd.md", content = text): AgentInputDocuments { return { session_dir, req_id, files: [{ file, content_hash: sha256Hex(content), content_length: content.length }] }; }
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "cord-input-documents-")); session_dir = join(root, "cord", req_id); await mkdir(session_dir, { recursive: true });
  await writeFile(join(session_dir, "prd.md"), text); await writeFile(join(session_dir, "events.jsonl"), "PRIVATE_EVENTS"); await writeFile(join(session_dir, "unused.md"), "UNBOUND_TEXT"); scratch = join(root, "scratch"); await mkdir(scratch); });
afterEach(async () => { vi.restoreAllMocks(); vi.mocked(fs.writeFile).mockRestore(); await unlock_input_documents(scratch); await rm(root, { recursive: true, force: true }); });

describe("宿主验证的当前全文输入", () => {
  it("复制完整中段/Unicode与清单，省略/未授权文件不随目录复制", async () => {
    const directory = await prepare_input_documents(input(), root, scratch); expect(await readFile(join(directory, "documents/prd.md"), "utf8")).toBe(text);
    expect(JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"))).toMatchObject({ req_id, policy: "verified-readonly-documents.v1", files: input().files });
    await expect(access(join(directory, "documents/events.jsonl"))).rejects.toThrow(); await expect(access(join(directory, "documents/unused.md"))).rejects.toThrow();
  });
  it("保留嵌套路径和精确空文档，清单按文件名排序", async () => {
    await mkdir(join(session_dir, "nested")); await writeFile(join(session_dir, "nested/manual.md"), "");
    const source = { ...input(), files: [...input().files, { file: "nested/manual.md", content_hash: sha256Hex(""), content_length: 0 }] };
    const directory = await prepare_input_documents(source, root, scratch); expect(await readFile(join(directory, "documents/nested/manual.md"), "utf8")).toBe("");
    expect(JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")).files.map((file: { file: string }) => file.file)).toEqual(["nested/manual.md", "prd.md"]);
  });
  it.each(["events.jsonl", "ledger.yaml", "nested/.git/config", "../prd.md", "/prd.md", "nested//doc", "agents.yaml"])("严格描述拒绝%s，不能复制事实或越界", async file => {
    expect(AgentInputDocumentsSchema.safeParse(input(file)).success).toBe(false);
    await expect(prepare_input_documents(input(file), root, scratch)).rejects.toThrow(); await expect(access(join(scratch, "input-documents"))).rejects.toThrow();
  });
  it.each(["hash", "length", "missing", "symlink", "hardlink", "foreign-session", "foreign-req", "duplicate", "extra"])("%s不能使用旧hash或陌生来源，调用拒绝", async mode => {
    const source = input();
    if (mode === "hash") await writeFile(join(session_dir, "prd.md"), text + "CHANGED");
    if (mode === "length") source.files[0]!.content_length--;
    if (mode === "missing") await rm(join(session_dir, "prd.md"));
    if (mode === "symlink") { await rm(join(session_dir, "prd.md")); await writeFile(join(root, "outside.md"), text); await symlink(join(root, "outside.md"), join(session_dir, "prd.md")); }
    if (mode === "hardlink") await link(join(session_dir, "prd.md"), join(root, "alias.md"));
    if (mode === "foreign-session") source.session_dir = root;
    if (mode === "foreign-req") source.req_id = "REQ-OTHER";
    if (mode === "duplicate") source.files.push(source.files[0]!);
    if (mode === "extra") (source as AgentInputDocuments & { extra: boolean }).extra = true;
    await expect(prepare_input_documents(source, root, scratch)).rejects.toThrow();
    await expect(access(join(scratch, "input-documents/documents/prd.md"))).rejects.toThrow();
  });
  it("单文档实际字节超限在加载正文前拒绝；取消不复制", async () => {
    const path = join(session_dir, "large.md"); const handle = await open(path, "w"); try { await handle.truncate(16 * 1024 * 1024 + 1); } finally { await handle.close(); }
    await expect(prepare_input_documents(input("large.md", ""), root, scratch)).rejects.toThrow();
    await unlock_input_documents(scratch); await rm(join(scratch, "input-documents"), { recursive: true, force: true });
    const controller = new AbortController(); controller.abort(); await expect(prepare_input_documents(input(), root, scratch, controller.signal)).rejects.toThrow();
  });
  it("无效UTF-8不能把替换字符当原文副本，多于128个文件在IO前拒绝", async () => {
    const raw = Buffer.from([0xff]); await writeFile(join(session_dir, "binary.md"), raw);
    await expect(prepare_input_documents(input("binary.md", raw.toString("utf8")), root, scratch)).rejects.toThrow();
    const source = input(); source.files = Array.from({ length: 129 }, (_, index) => ({ file: `file-${index}.md`, content_hash: sha256Hex(""), content_length: 0 }));
    expect(AgentInputDocumentsSchema.safeParse(source).success).toBe(false);
  });
  it("早复制文件在较晚文件复制期间变化时，整组封存拒绝旧副本", async () => {
    await writeFile(join(session_dir, "a.md"), "A"); await writeFile(join(session_dir, "z.md"), "Z");
    const source = { session_dir, req_id, files: [{ file: "a.md", content_hash: sha256Hex("A"), content_length: 1 }, { file: "z.md", content_hash: sha256Hex("Z"), content_length: 1 }] };
    const original = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).writeFile; let changed = false;
    vi.mocked(fs.writeFile).mockImplementation(async (file, data, options) => {
      await original(file, data, options);
      if (!changed && String(file).endsWith("/documents/z.md")) { changed = true; await original(join(session_dir, "a.md"), "CHANGED"); }
    });
    await expect(prepare_input_documents(source, root, scratch)).rejects.toThrow(); expect(changed).toBe(true);
    await expect(access(join(scratch, "input-documents/manifest.json"))).rejects.toThrow();
  });
  it("总字节预算覆盖所有允许文档，不能通过多个独立文件绕过", async () => {
    const size = 16 * 1024 * 1024; const content = "\0".repeat(size); const files: AgentInputDocuments["files"] = [];
    for (let index = 0; index < 5; index++) {
      const file = `large-${index}.md`; const handle = await open(join(session_dir, file), "w"); try { await handle.truncate(size); } finally { await handle.close(); }
      files.push({ file, content_hash: sha256Hex(content), content_length: size });
    }
    await expect(prepare_input_documents({ session_dir, req_id, files }, root, scratch)).rejects.toThrow();
    await expect(access(join(scratch, "input-documents/manifest.json"))).rejects.toThrow();
  });
  it("实际prompt根路径追加计入预算，用户token原样保留，不截断", () => {
    const original = "KEEP {{cord_input_dir}} $CORD_INPUT_DIR $(echo text)\n";
    const result = input_documents_prompt(original, "/temporary root/文档", original.length + INPUT_DOCUMENTS_PROMPT_RESERVE);
    expect(result.startsWith(original)).toBe(true); expect(result).toContain('input_documents_root: "/temporary root/文档"');
    expect(() => input_documents_prompt(original, "/tmp/input", original.length)).toThrow();
    expect(() => input_documents_prompt(original, "/tmp/" + "x".repeat(INPUT_DOCUMENTS_PROMPT_RESERVE))).toThrow();
  });
  it("只读模式复制后仍可由宿主解除目录模式并清理", async () => {
    const directory = await prepare_input_documents(input(), root, scratch); await chmod(scratch, 0o700); await unlock_input_documents(scratch); await rm(directory, { recursive: true }); await expect(access(directory)).rejects.toThrow();
  });
});
