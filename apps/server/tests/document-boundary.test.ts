/** REST 文档访问与 file gate 同边界，错误不能伪装成未生成。 */
import { link, mkdir, mkdtemp, open, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { ulid } from "ulid";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp, type BuiltServer } from "@agent-cord/server";

vi.mock("node:fs/promises", async (original) => { const actual = await original<typeof import("node:fs/promises")>(); return { ...actual, rename: vi.fn(actual.rename), open: vi.fn(actual.open) }; });
let root: string;
let server: BuiltServer;
const content = "# 文档\n\n## 验收\n原始内容。\n";
const doc = () => join(root, "cord", "REQ-FILES", "prd.md");
async function request(method: "GET" | "PUT" | "POST", url: string, body?: unknown) {
  const response = await server.app.inject({ method, url, headers: { ...(method !== "GET" ? { "idempotency-key": ulid() } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { payload: JSON.stringify(body) } : {}) });
  return { status: response.statusCode, body: response.json() as Record<string, any> };
}
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "cord-document-api-")); server = await buildApp({ root }); await server.sessions.create("REQ-FILES", "文件边界", content); });
afterEach(async () => { vi.restoreAllMocks(); vi.mocked(rename).mockClear(); await server.app.close(); server.index.close(); await rm(root, { recursive: true, force: true }); });

describe("REST 文档边界", () => {
  it("符号链接不可读写，外部原文不变，详情不会声明该文档可用；修复后可保存", async () => {
    const outside = join(root, "outside.md"); await writeFile(outside, content); await rm(doc()); await symlink(outside, doc());
    const url = "/api/v1/requirements/REQ-FILES/docs/prd";
    const read = await request("GET", url); expect(read.status).toBe(409); expect(JSON.stringify(read.body)).not.toContain("原始内容");
    expect((await request("PUT", url, { content: "不应覆盖外部文件" })).status).toBe(409);
    expect(await readFile(outside, "utf8")).toBe(content);
    expect((await request("GET", "/api/v1/requirements/REQ-FILES")).body.requirement.docs.prd).toBe(false);
    await rm(doc()); await writeFile(doc(), content);
    expect((await request("PUT", url, { content: "# 修复后文档" })).status).toBe(200);
    expect((await request("GET", url)).body.content).toBe("# 修复后文档");
  });
  it("硬链接不能读写普通文件或事实流，原文与事实不变", async () => {
    const source = join(root, "cord", "REQ-FILES", "events.jsonl"); const facts = await readFile(source, "utf8");
    await rm(doc()); await link(source, doc());
    expect((await request("GET", "/api/v1/requirements/REQ-FILES/docs/prd")).status).toBe(409);
    expect((await request("PUT", "/api/v1/requirements/REQ-FILES/docs/prd", { content: "不能改写事件" })).status).toBe(409);
    expect(await readFile(source, "utf8")).toBe(facts);
  });
  it("目录错误是 409，真正缺失是 404，缺失普通文档仍允许创建", async () => {
    await rm(doc()); await mkdir(doc());
    expect((await request("GET", "/api/v1/requirements/REQ-FILES/docs/prd")).status).toBe(409);
    await rm(doc(), { recursive: true });
    expect((await request("GET", "/api/v1/requirements/REQ-FILES/docs/prd")).status).toBe(404);
    expect((await request("PUT", "/api/v1/requirements/REQ-FILES/docs/prd", { content: "# 新文档" })).status).toBe(200);
    expect((await request("GET", "/api/v1/requirements/REQ-FILES/docs/prd")).body.content).toBe("# 新文档");
  });
  it("原子替换失败为 500，保留旧文档、清理临时文件，修复后新操作可保存", async () => {
    vi.mocked(rename).mockRejectedValueOnce(new Error("fixture rename unavailable"));
    expect((await request("PUT", "/api/v1/requirements/REQ-FILES/docs/prd", { content: "# 失败的新文档" })).status).toBe(500);
    expect(await readFile(doc(), "utf8")).toBe(content);
    expect((await readdir(join(root, "cord", "REQ-FILES"))).some((file) => file.startsWith(".cord-"))).toBe(false);
    expect((await request("PUT", "/api/v1/requirements/REQ-FILES/docs/prd", { content: "# 成功的新文档" })).status).toBe(200);
    expect(await readFile(doc(), "utf8")).toBe("# 成功的新文档");
  });
  it("权限/IO 读取错误返回 500 而不是缺失 404，正文与错误原文不泄漏，修复后读取成功", async () => {
    vi.mocked(open).mockRejectedValueOnce(Object.assign(new Error("PRIVATE_INTERNAL_IO_MARKER"), { code: "EACCES" }));
    const result = await request("GET", "/api/v1/requirements/REQ-FILES/docs/prd");
    expect(result.status).toBe(500); expect(JSON.stringify(result.body)).not.toContain("PRIVATE_INTERNAL_IO_MARKER");
    expect(JSON.stringify(result.body)).not.toContain(content);
    expect((await request("GET", "/api/v1/requirements/REQ-FILES/docs/prd")).body.content).toBe(content);
  });
  it("文件 checker 对外部链接阻断 run，普通文件修复后断点完成", async () => {
    const yaml = YAML.stringify({ apiVersion: "agent-cord.dev/v1alpha1", kind: "Workflow", metadata: { id: "file-evidence" }, spec: { nodes: [{ id: "review", gates: [{ id: "document", role: {}, attach: { node: "review", when: "post" }, checks: [{ ref: "doc-has-section", with: { path: "evidence.md", heading: "验收" } }], pass: { require: "all", human_confirm: false }, on_fail: "block" }] }] } });
    expect((await request("POST", "/api/v1/sdlcs/file-evidence/versions/publish", { yaml })).status).toBe(201);
    const evidence = join(root, "cord", "REQ-FILES", "evidence.md");
    const outside = join(root, "outside.md"); await writeFile(outside, content); await symlink(outside, evidence);
    const run = await server.runs.start("REQ-FILES", "file-evidence");
    const deadline = Date.now() + 10_000;
    while (server.runs.isActive("REQ-FILES")) { if (Date.now() > deadline) throw new Error("文件 gate 观察超时"); await new Promise<void>((resolve) => setImmediate(resolve)); }
    expect((await server.runs.getRun(run.run_id)).status).toBe("blocked");
    expect((await server.sessions.readEvents("REQ-FILES")).some((event) => event.type === "workflow.node.exited")).toBe(false);
    await rm(evidence); await writeFile(evidence, content); const recovery = await server.runs.start("REQ-FILES", "file-evidence");
    while (server.runs.isActive("REQ-FILES")) { if (Date.now() > deadline) throw new Error("文件 gate 恢复超时"); await new Promise<void>((resolve) => setImmediate(resolve)); }
    expect((await server.runs.getRun(recovery.run_id)).status).toBe("completed"); expect(await readFile(outside, "utf8")).toBe(content);
  });
});
