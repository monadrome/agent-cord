/** 文档文件边界：真实文件系统下的链接、保留路径与原子写入。 */
import { link, mkdir, mkdtemp, open, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readSessionDocument, resolveSessionFile, writeSessionDocument } from "../../src/coordinator/session-files.js";
import { sha256Hex } from "../../src/core/hash.js";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open), rename: vi.fn(actual.rename) };
});

let root: string;
let session_dir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cord-session-files-"));
  session_dir = join(root, "session");
  await mkdir(session_dir);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("session 文档文件边界", () => {
  it("预期 hash 过期时保留人工编辑，不创建临时文件", async () => {
    await writeFile(join(session_dir, "plan.md"), "人工已更新");
    await expect(writeSessionDocument(session_dir, "plan.md", "不应覆盖", { expected_hash: sha256Hex("旧计划") })).rejects.toThrow(/内容变化/);
    expect(await readFile(join(session_dir, "plan.md"), "utf8")).toBe("人工已更新");
    expect(await readdir(session_dir)).toEqual(["plan.md"]);
  });

  it("预期文件不存在但被另一写者创建时，不能覆盖新文档", async () => {
    await writeFile(join(session_dir, "plan.md"), "并发创建的文档");
    await expect(writeSessionDocument(session_dir, "plan.md", "不应覆盖", { expected_hash: null })).rejects.toThrow(/内容变化/);
    expect(await readFile(join(session_dir, "plan.md"), "utf8")).toBe("并发创建的文档");
  });

  it("匹配当前 hash 后允许代写，前后内容可核验", async () => {
    const old = "# 旧计划";
    await writeFile(join(session_dir, "plan.md"), old);
    await writeSessionDocument(session_dir, "plan.md", "# 新计划", { expected_hash: sha256Hex(old) });
    expect(await readSessionDocument(session_dir, "plan.md")).toBe("# 新计划");
  });

  it("临时文件落盘期间发生编辑，替换前再次校验并保留编辑，清理临时文件", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const file_path = join(session_dir, "plan.md");
    await writeFile(file_path, "原计划");
    vi.mocked(open).mockImplementation(async (path, flags, mode) => {
      const handle = await actual.open(path, flags, mode);
      if (flags === "wx") {
        const sync = handle.sync.bind(handle);
        handle.sync = async () => { await sync(); await writeFile(file_path, "替换前的人工作品"); };
      }
      return handle;
    });
    try {
      await expect(writeSessionDocument(session_dir, "plan.md", "不应覆盖", { expected_hash: sha256Hex("原计划") })).rejects.toThrow(/内容变化/);
      expect(await readFile(file_path, "utf8")).toBe("替换前的人工作品");
      expect(await readdir(session_dir)).toEqual(["plan.md"]);
    } finally {
      vi.mocked(open).mockImplementation(actual.open);
    }
  });

  it("支持嵌套普通文件，写入后没有遗留临时文件", async () => {
    await writeSessionDocument(session_dir, "reports/result.md", "# 第一版\n");
    expect(await readSessionDocument(session_dir, "reports/result.md")).toBe("# 第一版\n");
    await writeSessionDocument(session_dir, "reports/result.md", "# 第二版\n");
    expect(await readFile(join(session_dir, "reports/result.md"), "utf8")).toBe("# 第二版\n");
    expect(await readdir(join(session_dir, "reports"))).toEqual(["result.md"]);
  });

  it("父目录符号链接不能用于读写 session 外的文件", async () => {
    const outside = join(root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "result.md"), "外部文件");
    await symlink(outside, join(session_dir, "reports"));
    await expect(readSessionDocument(session_dir, "reports/result.md")).rejects.toThrow(/符号链接/);
    await expect(writeSessionDocument(session_dir, "reports/result.md", "不应写入")).rejects.toThrow(/符号链接/);
    expect(await readFile(join(outside, "result.md"), "utf8")).toBe("外部文件");
  });

  it("即使指向 session 内部，最终符号链接也不能被当作普通文档", async () => {
    await writeFile(join(session_dir, "real.md"), "原文");
    await symlink(join(session_dir, "real.md"), join(session_dir, "alias.md"));
    await expect(readSessionDocument(session_dir, "alias.md")).rejects.toThrow(/符号链接/);
    await expect(writeSessionDocument(session_dir, "alias.md", "不应写入")).rejects.toThrow(/符号链接/);
  });

  it("指向事实文件的硬链接不能绕过保留名称保护", async () => {
    const events = join(session_dir, "events.jsonl");
    await writeFile(events, "FACTS\n");
    await link(events, join(session_dir, "alias.md"));
    await expect(readSessionDocument(session_dir, "alias.md")).rejects.toThrow(/硬链接/);
    await expect(writeSessionDocument(session_dir, "alias.md", "不应写入")).rejects.toThrow(/硬链接/);
    expect(await readFile(events, "utf8")).toBe("FACTS\n");
  });

  it("已有固定 .tmp 的链接不被跟随或覆盖", async () => {
    const outside = join(root, "outside.md");
    await writeFile(outside, "保留外部内容");
    await symlink(outside, join(session_dir, "plan.md.tmp"));
    await writeSessionDocument(session_dir, "plan.md", "# 新计划\n");
    expect(await readFile(outside, "utf8")).toBe("保留外部内容");
    expect(await readFile(join(session_dir, "plan.md"), "utf8")).toBe("# 新计划\n");
    expect((await readdir(session_dir)).sort()).toEqual(["plan.md", "plan.md.tmp"]);
  });

  it("替换失败保留旧文档且清理临时文件，下一次可恢复写入", async () => {
    await writeFile(join(session_dir, "plan.md"), "原计划");
    vi.mocked(rename).mockRejectedValueOnce(new Error("rename IO unavailable"));
    await expect(writeSessionDocument(session_dir, "plan.md", "未完成的新计划")).rejects.toThrow("rename IO unavailable");
    expect(await readFile(join(session_dir, "plan.md"), "utf8")).toBe("原计划");
    expect(await readdir(session_dir)).toEqual(["plan.md"]);
    await writeSessionDocument(session_dir, "plan.md", "恢复后的计划");
    expect(await readSessionDocument(session_dir, "plan.md")).toBe("恢复后的计划");
  });

  it("拒绝保留路径大小写变体、平台路径分隔符和 Windows 绝对路径", () => {
    for (const file of ["EVENTS.JSONL", "reports/ledger.yaml", "agents.yaml", ".git/config", ".sdlc/v1.yaml", "../x.md", "a\\b.md", "C:/outside.md", "/outside.md"]) {
      expect(resolveSessionFile(session_dir, file), file).toBeNull();
    }
  });
});
