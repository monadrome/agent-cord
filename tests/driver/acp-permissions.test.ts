import { mkdtemp, mkdir, rm, writeFile, symlink, link, realpath, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { AcpDriver } from "../../src/driver/acp.js";
import { AcpPermissionPolicySchema, decideAcpWorkspacePermission } from "../../src/driver/acp-permissions.js";
import { createAgentRegistry, parseAgentsYaml } from "../../src/driver/agents-yaml.js";
import * as files from "../../src/core/session-files.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "cord-acp-permission-")); await mkdir(join(root, "src")); await mkdir(join(root, "tests")); await writeFile(join(root, "src", "data.ts"), "DRAFT"); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const policy = AcpPermissionPolicySchema.parse({ read: ["src", "tests", "package.json"], edit: ["src"] });
function request(kind = "edit", paths = [join(root, "src", "data.ts")]): RequestPermissionRequest {
  return { sessionId: "test", toolCall: { toolCallId: "call", kind, title: "PRIVATE_TITLE", locations: paths.map(path => ({ path })), rawInput: { secret: "PRIVATE_INPUT" } },
    options: [{ optionId: "remember", kind: "allow_always", name: "PRIVATE_LABEL" }, { optionId: "once", kind: "allow_once", name: "允许一次" }] } as RequestPermissionRequest;
}

describe("ACP 声明文件权限", () => {
  it("真实 ACP read/edit 请求依次一次授权，回执 metadata 不污染输出", async () => {
    await writeFile(join(root, "src", "value.txt"), "initial");
    const bin = fileURLToPath(new URL("./fixtures/acp-permission-worker.mjs", import.meta.url));
    const driver = new AcpDriver({ bin: process.execPath, args: [bin], permission_policy: { read: ["src"], edit: ["src"] } });
    const events = [];
    for await (const event of driver.run({ prompt: "交付 Draft", cwd: root, timeout_ms: 5000 })) events.push(event);
    expect(await readFile(join(root, "src", "value.txt"), "utf8")).toBe("fixed");
    const permissions = JSON.parse("[" + (await readFile(join(root, ".permission-worker-log.jsonl"), "utf8")).trim().split("\n").join(",") + "]");
    expect(permissions.map((item: any) => item.outcome)).toEqual([{ outcome: "selected", optionId: "once" }, { outcome: "selected", optionId: "once" }]);
    expect(events.filter(event => event.type === "error")).toHaveLength(0);
    expect(events.filter(event => event.type === "text" && (event.data as any).channel === "metadata")).toHaveLength(2);
    expect(JSON.stringify(events.find(event => event.type === "result")?.data)).not.toContain("PRIVATE_PERMISSION");
  });

  it("readonly 即使声明 read/edit 也拒绝请求，文件不变", async () => {
    await writeFile(join(root, "src", "value.txt"), "initial");
    const bin = fileURLToPath(new URL("./fixtures/acp-permission-worker.mjs", import.meta.url));
    const driver = new AcpDriver({ bin: process.execPath, args: [bin], permission_policy: { read: ["src"], edit: ["src"] } });
    const events = [];
    for await (const event of driver.run({ prompt: "只读", cwd: root, readonly: true, timeout_ms: 5000 })) events.push(event);
    expect(await readFile(join(root, "src", "value.txt"), "utf8")).toBe("initial");
    const replies = (await readFile(join(root, ".permission-worker-log.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(replies[0].outcome).toEqual({ outcome: "selected", optionId: "reject" });
    expect(events.filter(event => event.type === "text" && (event.data as any).channel === "metadata")).toHaveLength(1);
  });
  it("read/edit 当前普通文件和 edit 新路径可一次授权，不选择永久选项", async () => {
    expect(await decideAcpWorkspacePermission(request("read"), policy, root)).toEqual({ optionId: "once" });
    expect(await decideAcpWorkspacePermission(request(), policy, root)).toEqual({ optionId: "once" });
    expect(await decideAcpWorkspacePermission(request("edit", [join(root, "src", "nested", "new.ts")]), policy, root)).toEqual({ optionId: "once" });
    expect(await decideAcpWorkspacePermission(request("read", [join(root, "src", "missing.ts")]), policy, root)).toEqual({ cancelled: true });
  });

  it.each(["execute", "delete", "move", "search", "fetch", "other", "think", "switch_mode"])("未知或未声明的 %s 操作拒绝", async kind => {
    expect(await decideAcpWorkspacePermission(request(kind), policy, root)).toEqual({ cancelled: true });
  });

  it("缺 kind/locations、原始 input 中的路径与相对位置不能推断为授权", async () => {
    for (const req of [
      { ...request(), toolCall: { toolCallId: "call", kind: "edit", rawInput: { path: join(root, "src", "data.ts") } } },
      { ...request(), toolCall: { toolCallId: "call", locations: [{ path: join(root, "src", "data.ts") }] } },
      request("edit", []), request("edit", ["src/data.ts"]), request("edit", [root + "/src/../src/data.ts"]),
    ]) expect(await decideAcpWorkspacePermission(req as RequestPermissionRequest, policy, root)).toEqual({ cancelled: true });
  });

  it("目录前缀兄弟、越界、事实/配置/管理文件与多位置部分越界全拒绝", async () => {
    for (const paths of [
      [join(root, "src-other", "file.ts")], [join(root, "..", "external.ts")], [join(root, "src", "events.jsonl")],
      [join(root, "src", "ledger.yaml")], [join(root, "src", "agents.yaml")], [join(root, "src", ".git", "config")],
      [join(root, "src", ".index", "data")], [join(root, "src", ".sdlc", "flow")], [root],
      [join(root, "src", "data.ts"), join(root, "tests", "file.ts")],
    ]) expect(await decideAcpWorkspacePermission(request("edit", paths), policy, root)).toEqual({ cancelled: true });
  });

  it("拒绝符号链接、中间链接、硬链接、目录叶与根目录链接", async () => {
    await symlink(join(root, "tests"), join(root, "src", "linked-dir"));
    await symlink(join(root, "src", "data.ts"), join(root, "src", "linked.ts"));
    await link(join(root, "src", "data.ts"), join(root, "src", "hard.ts"));
    for (const path of [join(root, "src", "linked-dir", "new.ts"), join(root, "src", "linked.ts"), join(root, "src", "hard.ts"), join(root, "src")]) {
      expect(await decideAcpWorkspacePermission(request("edit", [path]), policy, root)).toEqual({ cancelled: true });
    }
    const alias = root + "-link"; await symlink(root, alias);
    try { expect(await decideAcpWorkspacePermission(request("edit", [join(alias, "src", "new.ts")]), policy, alias)).toEqual({ cancelled: true }); }
    finally { await rm(alias); }
  });

  it("真实路径与工作目录的规范别名都可以定位，IO 失败不放行", async () => {
    const canonical = await realpath(root);
    expect(await decideAcpWorkspacePermission(request("edit", [join(canonical, "src", "data.ts")]), policy, root)).toEqual({ optionId: "once" });
    const failure = vi.spyOn(files, "resolveSafeSessionFile").mockRejectedValue(Error("PRIVATE_IO"));
    try { expect(await decideAcpWorkspacePermission(request(), policy, root)).toEqual({ cancelled: true }); }
    finally { failure.mockRestore(); }
  });

  it("没有一次选项或重复 optionId 时取消，不放大成持久授权", async () => {
    const req = request();
    req.options = [req.options[0]!];
    expect(await decideAcpWorkspacePermission(req, policy, root)).toEqual({ cancelled: true });
    req.options = [{ optionId: "same", kind: "allow_always", name: "永久" }, { optionId: "same", kind: "allow_once", name: "一次" }];
    expect(await decideAcpWorkspacePermission(req, policy, root)).toEqual({ cancelled: true });
  });

  it("策略归一化、指纹绑定范围，无策略保留旧身份，环境不进入身份", () => {
    const plain = new AcpDriver({ bin: "agent", args: ["acp"] });
    const first = new AcpDriver({ bin: "agent", args: ["acp"], permission_policy: { read: ["tests", "src", "src"], edit: ["src"] }, env: { TEST_CONTEXT: "PRIVATE_A" } });
    const second = new AcpDriver({ bin: "agent", args: ["acp"], permission_policy: { edit: ["src"], read: ["src", "tests"] }, env: { TEST_CONTEXT: "PRIVATE_B" } });
    expect(first.configuration_hash).toBe(second.configuration_hash);
    expect(first.configuration_hash).not.toBe(plain.configuration_hash);
    expect(new AcpDriver({ bin: "agent", args: ["acp"], permission_policy: { edit: ["tests"], read: ["src", "tests"] } }).configuration_hash).not.toBe(first.configuration_hash);
    expect(first.args).toEqual(plain.args);
    expect(() => new AcpDriver({ bin: "agent", permission_policy: { read: ["src"] }, decidePermission: () => ({ cancelled: true }) })).toThrow(/不能同时/);
  });

  it.each([{}, { edit: [] }, { read: ["."] }, { edit: ["../src"] }, { edit: ["/src"] }, { read: [".git"] }, { read: ["src"], execute: true }, { edit: ["src//file"] }, { edit: ["src/./file"] }])("非法配置 %j 拒绝，headless 不接收策略", config => {
    expect(AcpPermissionPolicySchema.safeParse(config).success).toBe(false);
    expect(parseAgentsYaml("agents: { worker: { kind: headless, template: codex, permission_policy: {read: [src]} } }").rejected).toEqual(["worker"]);
  });

  it("工作区 registry 清单仅公开数量，旧 resolver 固定，后续修改外部对象不影响策略", () => {
    const first = createAgentRegistry(parseAgentsYaml("agents: { worker: { kind: acp, bin: agent, permission_policy: {read: [src, src], edit: [src/private]} } }").yaml);
    const second = createAgentRegistry(parseAgentsYaml("agents: { worker: { kind: acp, bin: agent, permission_policy: {read: [src], edit: [src/other]} } }").yaml);
    expect(first.resolve("worker").configuration_hash).not.toBe(second.resolve("worker").configuration_hash);
    const entry = first.list().find(item => item.name === "worker")!;
    expect(entry.permission_policy).toEqual({ read_count: 1, edit_count: 1 });
    expect(JSON.stringify(first.list())).not.toContain("private");
    entry.permission_policy!.edit_count = 999;
    expect(first.list().find(item => item.name === "worker")!.permission_policy!.edit_count).toBe(1);
  });
});
