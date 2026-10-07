/** 工作区 agent 清单、重载、多工作区隔离与在途配置固定（ADR-0027）。 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp, type BuiltServer } from "@agent-cord/server";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "../../../tests/driver/fixtures/fake-cli.mjs");
const servers: BuiltServer[] = [];
const roots: string[] = [];

async function request(server: BuiltServer, method: "GET" | "POST", url: string, payload?: unknown, key?: string) {
  const headers: Record<string, string> = {};
  if (key !== undefined) headers["idempotency-key"] = key;
  if (payload !== undefined) headers["content-type"] = "application/json";
  const response = await server.app.inject({
    method,
    url,
    headers,
    ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
  });
  return { status: response.statusCode, body: response.json() as Record<string, any> };
}

async function write_config(root: string, result: string): Promise<void> {
  await mkdir(join(root, "cord"), { recursive: true });
  await writeFile(join(root, "cord", "agents.yaml"), YAML.stringify({
    agents: {
      worker: {
        kind: "headless",
        bin: process.execPath,
        args: [fixture, "--mode", "claude", "--result-text", result, "{{prompt}}"],
      },
    },
  }), "utf8");
}

async function workspace(result: string): Promise<{ root: string; server: BuiltServer }> {
  const root = await mkdtemp(join(tmpdir(), "cord-agent-registry-"));
  roots.push(root);
  await write_config(root, result);
  const server = await buildApp({ root });
  servers.push(server);
  return { root, server };
}

async function close_server(server: BuiltServer): Promise<void> {
  for (const run of server.runs.listRuns()) {
    if (server.runs.activeRunId(run.req_id) === run.run_id) await server.runs.cancel(run.run_id);
  }
  await server.app.close();
  server.index.close();
  servers.splice(servers.indexOf(server), 1);
}

afterEach(async () => {
  for (const server of [...servers]) await close_server(server);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function wait_for(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("等待 agent 测试状态超时");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function publish(server: BuiltServer, human_gate = false): Promise<void> {
  const workflow = {
    apiVersion: "agent-cord.dev/v1alpha1",
    kind: "Workflow",
    metadata: { id: "registry-test" },
    spec: {
      nodes: [
        {
          id: "plan",
          artifact: "plan.md",
          depends_on: [],
          run: { agent: "worker" },
          gates: [{
            id: "human-review",
            role: { initiators: [], approvers: [] },
            attach: { node: "plan", when: "post", triggers: [] },
            checks: [{ ref: "file-nonempty", with: { path: "plan.md" } }],
            pass: { require: "all", human_confirm: human_gate },
            on_fail: "block",
          }],
        },
        { id: "verify", artifact: "findings.md", depends_on: ["plan"], run: { agent: "worker" }, gates: [] },
      ],
    },
  };
  const response = await request(server, "POST", "/api/v1/sdlcs/registry-test/versions/publish", { yaml: YAML.stringify(workflow) }, "publish-workflow");
  expect(response.status, JSON.stringify(response.body)).toBe(201);
}

async function start(server: BuiltServer, req_id: string): Promise<string> {
  const created = await request(server, "POST", "/api/v1/requirements", { req_id, title: req_id }, `create-${req_id}`);
  expect(created.status).toBe(201);
  const run = await request(server, "POST", `/api/v1/requirements/${req_id}/runs`, { sdlc_id: "registry-test" }, `run-${req_id}`);
  expect(run.status).toBe(202);
  return run.body.run.run_id as string;
}

async function completed(server: BuiltServer, run_id: string): Promise<void> {
  await wait_for(async () => (await server.runs.getRun(run_id)).status === "completed");
  await wait_for(async () => server.runs.activeRunId((await server.runs.getRun(run_id)).req_id) === null);
}

async function approve(server: BuiltServer, req_id: string): Promise<void> {
  const [approval] = await server.sessions.listApprovals(req_id);
  expect(approval).toBeDefined();
  const response = await request(server, "POST", `/api/v1/requirements/${req_id}/approvals/${approval!.approval_id}/decide`, { choice: "确认放行" }, `approve-${req_id}`);
  expect(response.status).toBe(200);
}

describe("工作区 agent registry", () => {
  it("清单只返回公开配置元信息，单条无效配置留诊断，重载需要幂等键", async () => {
    const { root, server } = await workspace("OLD");
    await writeFile(join(root, "cord", "agents.yaml"), YAML.stringify({ agents: {
      reviewer: { kind: "headless", template: "claude", env: { TEST_VALUE: "PRIVATE_ENV_MARKER" }, system_prompt: "PRIVATE_ROLE_MARKER", agents_json: "PRIVATE_DEFINITION_MARKER" },
      codex: { kind: "headless", template: "missing" },
      malformed: { kind: "acp", bin: 42 },
    } }), "utf8");
    expect((await request(server, "POST", "/api/v1/agents/reload")).status).toBe(400);
    const reload = await request(server, "POST", "/api/v1/agents/reload", undefined, "reload-config");
    expect(reload.status).toBe(200);
    expect(reload.body.revision).toBe(2);
    expect(reload.body.agents).toContainEqual({ name: "reviewer", kind: "headless", source: "workspace", template: "claude" });
    expect(reload.body.rejected).toEqual(expect.arrayContaining(["malformed", "codex"]));
    expect(reload.body.warnings.join("\n")).toContain("agents.malformed.bin");
    expect(JSON.stringify(reload.body)).not.toContain("PRIVATE_");
    expect(() => server.agents.resolver()("codex")).toThrow(/配置无效/);
    const replay = await request(server, "POST", "/api/v1/agents/reload", undefined, "reload-config");
    expect(replay.body.revision).toBe(2);
    expect((await request(server, "GET", "/api/v1/agents")).body.revision).toBe(2);
  });

  it("文件整体错误或 IO 故障保持旧配置；修复和删除后可继续重载", async () => {
    const { root, server } = await workspace("OLD");
    const file = join(root, "cord", "agents.yaml");
    await writeFile(file, "agents: [PRIVATE_PARSE_MARKER", "utf8");
    const failed = await request(server, "POST", "/api/v1/agents/reload", undefined, "invalid-reload");
    expect(failed.status).toBe(400);
    expect(JSON.stringify(failed.body)).not.toContain("PRIVATE_PARSE_MARKER");
    expect(server.agents.catalog().revision).toBe(1);
    expect(server.agents.catalog().agents.some((entry) => entry.name === "worker")).toBe(true);
    await rm(file);
    await mkdir(file);
    expect((await request(server, "POST", "/api/v1/agents/reload", undefined, "io-reload")).status).toBe(400);
    expect(server.agents.catalog().revision).toBe(1);
    await rm(file, { recursive: true });
    await write_config(root, "NEW");
    expect((await request(server, "POST", "/api/v1/agents/reload", undefined, "invalid-reload")).status).toBe(200);
    await publish(server);
    const run_id = await start(server, "REQ-FIXED");
    await completed(server, run_id);
    expect(await readFile(join(root, "cord", "REQ-FIXED", "plan.md"), "utf8")).toContain("NEW");
    await rm(file);
    const cleared = await request(server, "POST", "/api/v1/agents/reload", undefined, "clear-reload");
    expect(cleared.body.agents.some((entry: { name: string }) => entry.name === "worker")).toBe(false);
    expect(cleared.body.agents.some((entry: { name: string }) => entry.name === "claude")).toBe(true);
  });

  it("同进程两个工作区同名 agent 通过真实子进程分别产出自己的 artifact", async () => {
    const first = await workspace("WORKSPACE_A");
    const second = await workspace("WORKSPACE_B");
    await publish(first.server);
    await publish(second.server);
    const first_run = await start(first.server, "REQ-A");
    const second_run = await start(second.server, "REQ-B");
    await completed(first.server, first_run);
    await completed(second.server, second_run);
    expect(await readFile(join(first.root, "cord", "REQ-A", "plan.md"), "utf8")).toContain("WORKSPACE_A");
    expect(await readFile(join(second.root, "cord", "REQ-B", "plan.md"), "utf8")).toContain("WORKSPACE_B");
  });

  it("并发重载串行替换配置，各响应 revision 独立且最终状态可查询", async () => {
    const { root, server } = await workspace("OLD");
    await write_config(root, "NEW");
    const responses = await Promise.all([
      request(server, "POST", "/api/v1/agents/reload", undefined, "concurrent-one"),
      request(server, "POST", "/api/v1/agents/reload", undefined, "concurrent-two"),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(responses.map((response) => response.body.revision).sort()).toEqual([2, 3]);
    expect(server.agents.catalog().revision).toBe(3);
  });

  it("并发同键重载共享一次操作，revision 只递增一次且后续重放一致", async () => {
    const { root, server } = await workspace("OLD");
    await write_config(root, "NEW");
    const responses = await Promise.all([
      request(server, "POST", "/api/v1/agents/reload", undefined, "same-concurrent-key"),
      request(server, "POST", "/api/v1/agents/reload", undefined, "same-concurrent-key"),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(responses.map((response) => response.body.revision)).toEqual([2, 2]);
    expect(responses[0]!.body).toEqual(responses[1]!.body);
    const replay = await request(server, "POST", "/api/v1/agents/reload", undefined, "same-concurrent-key");
    expect(replay.body).toEqual(responses[0]!.body);
    expect(server.agents.catalog().revision).toBe(2);
  });

  it("在途 run 后续节点继续使用旧配置，新 run 使用重载后的配置", async () => {
    const { root, server } = await workspace("OLD_CONFIG");
    await publish(server, true);
    const old_run = await start(server, "REQ-OLD");
    await wait_for(async () => (await server.sessions.listApprovals("REQ-OLD")).length === 1);
    await write_config(root, "NEW_CONFIG");
    expect((await request(server, "POST", "/api/v1/agents/reload", undefined, "while-running")).status).toBe(200);
    const new_run = await start(server, "REQ-NEW");
    await wait_for(async () => (await server.sessions.listApprovals("REQ-NEW")).length === 1);
    await approve(server, "REQ-OLD");
    await approve(server, "REQ-NEW");
    await completed(server, old_run);
    await completed(server, new_run);
    expect(await readFile(join(root, "cord", "REQ-OLD", "findings.md"), "utf8")).toContain("OLD_CONFIG");
    expect(await readFile(join(root, "cord", "REQ-NEW", "findings.md"), "utf8")).toContain("NEW_CONFIG");
  });

  it("重启后按当前文件恢复挂起 run，已经完成的 agent 任务不重复执行", async () => {
    const { root, server } = await workspace("OLD");
    await publish(server, true);
    await start(server, "REQ-RESTART");
    await wait_for(async () => (await server.sessions.listApprovals("REQ-RESTART")).length === 1);
    await server.app.close();
    server.index.close();
    servers.splice(servers.indexOf(server), 1);
    await write_config(root, "AFTER_RESTART");
    const restarted = await buildApp({ root });
    servers.push(restarted);
    expect(restarted.agents.catalog().revision).toBe(1);
    await approve(restarted, "REQ-RESTART");
    await wait_for(async () => restarted.runs.activeRunId("REQ-RESTART") === null);
    expect(restarted.runs.listRuns("REQ-RESTART")[0]?.status).toBe("completed");
    expect(await readFile(join(root, "cord", "REQ-RESTART", "plan.md"), "utf8")).toContain("OLD");
    expect(await readFile(join(root, "cord", "REQ-RESTART", "findings.md"), "utf8")).toContain("AFTER_RESTART");
    const events = await (await restarted.sessions.open("REQ-RESTART")).events.readOrdered();
    expect(events.filter((event) => event.type === "agent.task.completed")).toHaveLength(2);
  });
});
