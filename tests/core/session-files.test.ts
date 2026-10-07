/** 共享文件 helper：元信息不读正文、IO 与缺失分离、描述符可靠清理。 */
import { mkdir, mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readSessionDocument, statSessionDocument, writeSessionDocument } from "../../src/core/session-files.js";

vi.mock("node:fs/promises", async (original) => { const actual = await original<typeof import("node:fs/promises")>(); return { ...actual, open: vi.fn(actual.open) }; });
let root: string;
let dir: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "cord-core-documents-")); dir = join(root, "session"); await mkdir(dir); });
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

describe("共享文档访问", () => {
  it("stat 只检查元信息，不读取大文件的正文，使用后关闭描述符", async () => {
    await writeFile(join(dir, "binary.bin"), Buffer.alloc(100_000, 1));
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let read = false; let closed = false;
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const handle = await actual.open(...args);
      handle.readFile = async () => { read = true; throw new Error("存在性不应读取全文"); };
      const close = handle.close.bind(handle); handle.close = async () => { closed = true; await close(); };
      return handle;
    });
    expect((await statSessionDocument(dir, "binary.bin"))?.size).toBe(100_000);
    expect(read).toBe(false); expect(closed).toBe(true);
  });
  it("缺失普通文档返回 null，权限/IO 错误上抛，修复后仍可读取", async () => {
    expect(await readSessionDocument(dir, "missing.md")).toBeNull(); expect(await statSessionDocument(dir, "missing.md")).toBeNull();
    await writeFile(join(dir, "plan.md"), "# 有效计划");
    vi.mocked(open).mockRejectedValueOnce(Object.assign(new Error("fixture EACCES"), { code: "EACCES" }));
    await expect(readSessionDocument(dir, "plan.md")).rejects.toMatchObject({ code: "EACCES" });
    expect(await readSessionDocument(dir, "plan.md")).toBe("# 有效计划");
  });
  it("正文读取失败时也关闭描述符，下一次可以重新读取", async () => {
    await writeFile(join(dir, "plan.md"), "# Plan");
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let closed = false;
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const handle = await actual.open(...args);
      handle.readFile = async () => { throw new Error("fixture content IO unavailable"); };
      const close = handle.close.bind(handle); handle.close = async () => { closed = true; await close(); };
      return handle;
    });
    await expect(readSessionDocument(dir, "plan.md")).rejects.toThrow("fixture content IO unavailable");
    expect(closed).toBe(true); expect(await readSessionDocument(dir, "plan.md")).toBe("# Plan");
  });
  it("session 根的符号链接包含末尾斜杠也不放行读写", async () => {
    await writeFile(join(dir, "plan.md"), "# 原文"); const alias = join(root, "alias"); await symlink(dir, alias);
    for (const path of [alias, alias + "/"]) {
      await expect(statSessionDocument(path, "plan.md")).rejects.toThrow(/根路径/);
      await expect(readSessionDocument(path, "plan.md")).rejects.toThrow(/根路径/);
      await expect(writeSessionDocument(path, "plan.md", "不应覆盖")).rejects.toThrow(/根路径/);
    }
    expect(await readSessionDocument(dir, "plan.md")).toBe("# 原文");
  });
});
