/** 声明源码输入的字节身份、目录清单与 fail-closed 边界。 */
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseWorkflow, source_manifest_hash } from "agent-cord";
import YAML from "yaml";
import { readVerificationSource, verificationSourceInputs } from "../src/services/verification-inputs.js";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open), readdir: vi.fn(actual.readdir) };
});

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "cord-source-inputs-"));
  await fs.mkdir(join(root, "src"));
  await fs.writeFile(join(root, "src", "a.ts"), "export const a = 1;\n");
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(fs.open).mockReset();
  vi.mocked(fs.readdir).mockReset();
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(fs.open).mockImplementation(actual.open);
  vi.mocked(fs.readdir).mockImplementation(actual.readdir);
  await fs.rm(root, { recursive: true, force: true });
});

const read = (paths = ["src"]) => readVerificationSource(root, paths);

describe("验证源码输入身份", () => {
  it("按需返回同次安全扫描清单，源码摘要域不变且没有正文", async () => {
    const ordinary = await read();
    expect(ordinary.source_manifest).toBeUndefined();
    const detailed = await readVerificationSource(root, ["src"], true);
    expect(detailed.source_hash).toBe(ordinary.source_hash);
    expect(source_manifest_hash(detailed.source_manifest!)).toBe(ordinary.source_hash);
    expect(detailed.source_manifest!.map(entry => entry.path)).toEqual(["src", "src/a.ts"]);
    expect(JSON.stringify(detailed.source_manifest)).not.toContain("export const a");
  });
  it("相同输入重复扫描稳定，根位置/输入顺序/重复项不改变内容身份", async () => {
    await fs.writeFile(join(root, "package.json"), '{"name":"fixture"}');
    const first = await read(["src", "package.json"]);
    expect(await read(["package.json", "src", "src"])).toEqual(first);
    const other = join(root, "other");
    await fs.mkdir(other);
    await fs.cp(join(root, "src"), join(other, "src"), { recursive: true });
    await fs.copyFile(join(root, "package.json"), join(other, "package.json"));
    expect(await readVerificationSource(other, ["src", "package.json"])).toEqual(first);
    expect(first.source_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("二进制字节差异不能经 UTF-8 替换字符丢失", async () => {
    await fs.writeFile(join(root, "src", "binary"), Buffer.from([0xff]));
    const first = await read();
    await fs.writeFile(join(root, "src", "binary"), Buffer.from([0xfe]));
    expect((await read()).source_hash).not.toBe(first.source_hash);
  });

  it("内容、路径、类型和权限变化参与身份", async () => {
    const first = (await read()).source_hash;
    await fs.rename(join(root, "src", "a.ts"), join(root, "src", "b.ts"));
    const renamed = (await read()).source_hash;
    expect(renamed).not.toBe(first);
    await fs.chmod(join(root, "src", "b.ts"), 0o755);
    const executable = (await read()).source_hash;
    expect(executable).not.toBe(renamed);
    await fs.rm(join(root, "src", "b.ts"));
    await fs.mkdir(join(root, "src", "b.ts"));
    expect((await read()).source_hash).not.toBe(executable);
  });

  it("依赖、构建和运行目录被排除，新增目录或文件仍改变清单", async () => {
    const before = await read();
    for (const name of ["node_modules", "dist", ".git", "cord"]) {
      await fs.mkdir(join(root, "src", name));
      await fs.symlink("/missing-cache", join(root, "src", name, "ignored"));
    }
    expect(await read()).toEqual(before);
    await fs.mkdir(join(root, "src", "empty"));
    expect((await read()).source_hash).not.toBe(before.source_hash);
  });

  it.each(["../escape", "/etc/passwd", "src/../outside", "src\\a.ts", "src//a.ts", "src/./a.ts", "src/", "src\0bad", "node_modules", "src/dist", "cord/prd.md", "src/events.jsonl", "src/agents.yaml"])("拒绝非规范或保留路径 %s", async (file) => {
    await expect(read([file])).rejects.toThrow(/路径/);
  });

  it("声明文件缺失不能当空内容，恢复后可再次扫描", async () => {
    await expect(read(["missing.ts"])).rejects.toThrow(/不存在/);
    await fs.writeFile(join(root, "missing.ts"), "");
    expect((await read(["missing.ts"])).source_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("叶文件/目录及路径中间的符号链接均拒绝，外部内容不变", async () => {
    const outside = join(root, "external");
    await fs.mkdir(outside);
    await fs.writeFile(join(outside, "private.ts"), "PRIVATE_SOURCE");
    await fs.symlink(join(outside, "private.ts"), join(root, "src", "linked.ts"));
    await expect(read()).rejects.toThrow(/链接/);
    await fs.rm(join(root, "src", "linked.ts"));
    await fs.symlink(outside, join(root, "linked"));
    await expect(read(["linked/private.ts"])).rejects.toThrow(/链接/);
    await expect(read(["linked"])).rejects.toThrow(/链接/);
    expect(await fs.readFile(join(outside, "private.ts"), "utf8")).toBe("PRIVATE_SOURCE");
  });

  it("硬链接不能冒充独立验证输入", async () => {
    await fs.link(join(root, "src", "a.ts"), join(root, "linked.ts"));
    await expect(read()).rejects.toThrow(/独立/);
  });

  it("工作区根不能是链接，目录深度和文件大小有界", async () => {
    const alias = `${root}-link`;
    await fs.symlink(root, alias);
    try { await expect(readVerificationSource(alias, ["src"])).rejects.toThrow(/普通目录/); }
    finally { await fs.rm(alias); }
    const deep = join(root, "src", ...Array.from({ length: 33 }, () => "nested"));
    await fs.mkdir(deep, { recursive: true });
    await expect(read()).rejects.toThrow(/深度/);
    const large = join(root, "large.bin");
    await fs.writeFile(large, "");
    await fs.truncate(large, 16 * 1024 * 1024 + 1);
    await expect(read(["large.bin"])).rejects.toThrow(/字节数/);
  });

  it("目录项目数和 IO 故障阻断扫描，不返回部分身份", async () => {
    const names = Array.from({ length: 10001 }, (_, index) => `f${index}`);
    vi.mocked(fs.readdir).mockResolvedValueOnce(names as never);
    await expect(read()).rejects.toThrow(/数量/);
    const failure = Object.assign(new Error("read denied"), { code: "EACCES" });
    vi.mocked(fs.open).mockRejectedValueOnce(failure);
    await expect(read()).rejects.toThrow("read denied");
  });

  it("扫描过程中目录新增文件不能返回旧清单", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let added = false;
    vi.mocked(fs.readdir).mockImplementation((async (path: string) => {
      const names = await actual.readdir(path);
      if (!added) {
        added = true;
        await fs.writeFile(join(root, "src", "late.ts"), "LATE_CHANGE");
      }
      return names;
    }) as typeof fs.readdir);
    await expect(read()).rejects.toThrow(/发生变化/);
  });

  it("读取途中故障或文件增长时关闭描述符，恢复后重新扫描", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let closed = false;
    vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
      const handle = await actual.open(...args);
      const close = handle.close.bind(handle);
      handle.close = async () => { closed = true; await close(); };
      handle.read = (async () => { throw new Error("fixture IO failure"); }) as typeof handle.read;
      return handle;
    });
    await expect(read()).rejects.toThrow("fixture IO failure");
    expect(closed).toBe(true);
    closed = false;
    vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
      const handle = await actual.open(...args);
      const close = handle.close.bind(handle);
      handle.close = async () => { closed = true; await close(); };
      handle.read = (async (buffer: Buffer) => ({ buffer, bytesRead: 64 * 1024 })) as typeof handle.read;
      return handle;
    });
    await expect(read()).rejects.toThrow(/发生变化/);
    expect(closed).toBe(true);
    expect((await read()).source_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("总输入字节数超限不能返回部分清单", async () => {
    for (let index = 0; index < 5; index += 1) {
      const path = join(root, "src", `large-${index}.bin`);
      await fs.writeFile(path, "");
      await fs.truncate(path, 16 * 1024 * 1024);
    }
    await expect(read()).rejects.toThrow(/字节数/);
  });

  it("节点范围去重并集，显式空列表/非法值拒绝，缺省兼容无源码范围", () => {
    const node = parseWorkflow(YAML.stringify({ apiVersion: "agent-cord.dev/v1alpha1", kind: "Workflow", metadata: { id: "source" }, spec: { nodes: [{ id: "verify", gates: [{ id: "check", role: {}, attach: { node: "verify", when: "post" }, checks: [
      { ref: "verification-passed", with: { verification_id: "tests", inputs: ["src", "tests"] } },
      { ref: "verification-passed", with: { verification_id: "lint", inputs: ["src", "package.json"] } },
    ], pass: { require: "all" }, on_fail: "block" }] }] } })).spec.nodes[0]!;
    expect(verificationSourceInputs(node)).toEqual(["package.json", "src", "tests"]);
    node.gates[0]!.checks[0]!.with!["inputs"] = [];
    expect(() => verificationSourceInputs(node)).toThrow(/1-64/);
    node.gates[0]!.checks = [{ ref: "verification-passed", with: { verification_id: "tests" } }];
    expect(verificationSourceInputs(node)).toEqual([]);
  });
});
