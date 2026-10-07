/** 文件 gate 的物理证据：链接/保留路径不得放行，修复后可恢复。 */
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFileExistsChecker, createFileNonemptyChecker, createDocHasSectionChecker } from "../../src/workflow/checkers.js";

let root: string;
let dir: string;
const content = "# 证据\n\n## 验收\n结果已验证。\n";
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "cord-file-gate-")); dir = join(root, "session"); await mkdir(dir); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const checkers = [createFileExistsChecker(), createFileNonemptyChecker(), createDocHasSectionChecker()];
async function results(file: string) { return Promise.all(checkers.map((checker) => checker.check({ session_dir: dir, anchors: [], payload: {}, params: { path: file, heading: "验收" } }))); }
async function blocked(file: string) { for (const result of await results(file)) { expect(result.result).toBe("block"); expect(result.anchors).toEqual([]); } }

describe("文件证据边界", () => {
  it("最终文件指向 session 外部时全部 block，替换为普通文档后全部 pass", async () => {
    const outside = join(root, "external.md"); await writeFile(outside, content); await symlink(outside, join(dir, "result.md"));
    await blocked("result.md"); expect(await readFile(outside, "utf8")).toBe(content);
    await rm(join(dir, "result.md")); await writeFile(join(dir, "result.md"), content);
    for (const result of await results("result.md")) expect(result.result).toBe("pass");
  });
  it("父目录符号链接不能让外部内容作为 session 证据", async () => {
    await mkdir(join(root, "external")); await writeFile(join(root, "external", "result.md"), content);
    await symlink(join(root, "external"), join(dir, "reports")); await blocked("reports/result.md");
  });
  it("session 内部符号链接也不能冒充独立文档", async () => {
    await writeFile(join(dir, "real.md"), content); await symlink(join(dir, "real.md"), join(dir, "alias.md")); await blocked("alias.md");
  });
  it("硬链接和事实文件别名都不能作为放行依据", async () => {
    await writeFile(join(dir, "events.jsonl"), content); await link(join(dir, "events.jsonl"), join(dir, "alias.md")); await blocked("alias.md");
    await blocked("events.jsonl");
  });
  it("所有保留管理路径与非规范路径均 block，即便文件有内容", async () => {
    for (const file of ["ledger.yaml", "agents.yaml", "EVENTS.JSONL", ".git/config", ".index/evidence.md", ".sdlc/evidence.md", "nested/ledger.yaml"]) {
      const absolute = join(dir, file); await mkdir(join(absolute, ".."), { recursive: true }); await writeFile(absolute, content); await blocked(file);
    }
    await writeFile(join(dir, "result.md"), content);
    for (const file of ["./result.md", "nested/../result.md", "/outside.md", "C:/outside.md", "a\\result.md"]) await blocked(file);
  });
  it("session 根本身为链接时不能跟随它读取另一需求", async () => {
    await writeFile(join(dir, "result.md"), content); const alias = join(root, "linked-session"); await symlink(dir, alias);
    for (const checker of checkers) expect((await checker.check({ session_dir: alias, anchors: [], payload: {}, params: { path: "result.md", heading: "验收" } })).result).toBe("block");
  });
  it("普通嵌套文件成功，目录/缺失/错误父路径阻断", async () => {
    await mkdir(join(dir, "reports")); await writeFile(join(dir, "reports", "result.md"), content);
    for (const result of await results("reports/result.md")) expect(result.result).toBe("pass");
    await blocked("reports"); await blocked("missing.md"); await blocked("reports/result.md/child.md");
  });
});
