import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ulid } from "ulid";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { buildApp, type BuiltServer } from "@agent-cord/server";

const fixture = fileURLToPath(new URL("../../../tests/driver/fixtures/fake-cli.mjs", import.meta.url));
const acp_fixture = fileURLToPath(new URL("../../../tests/driver/fixtures/fake-acp-agent.mjs", import.meta.url));
const server_fixture = fileURLToPath(new URL("../../../tests/driver/fixtures/workspace-lease-server.mjs", import.meta.url));
const workflow = stringify({
  apiVersion: "agent-cord.dev/v1alpha1", kind: "Workflow", metadata: { id: "lease-flow" }, spec: { nodes: [
    { id: "deliver", artifact: "review.md", run: { agent: "worker" }, gates: [{ id: "review", role: {}, attach: { node: "deliver", when: "post" }, checks: [{ ref: "file-nonempty", with: { path: "review.md", min_bytes: 1 } }], pass: { require: "all", human_confirm: true }, on_fail: "block" }] },
    { id: "done", depends_on: ["deliver"], gates: [] },
  ] },
});

let root: string;
let server: BuiltServer;
let request_seq = 0;

async function inject(method: "GET" | "POST", url: string, payload?: unknown) {
  const response = await server.app.inject({ method, url: "/api/v1" + url, ...(payload === undefined ? {} : { payload }), ...(method === "POST" ? { headers: { "idempotency-key": `lease-${request_seq++}` } } : {}) });
  return { status: response.statusCode, body: response.json() as Record<string, any> };
}

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("workspace lease 等待超时");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

async function prepare(target: string, app: BuiltServer): Promise<void> {
  await mkdir(join(target, "cord"), { recursive: true });
  await writeFile(join(target, "cord", "agents.yaml"), stringify({ agents: {
    worker: { kind: "headless", bin: process.execPath, args: [fixture, "--mode", "claude", "--no-tools", "{{prompt}}"] },
  } }), "utf8");
  await app.agents.reload();
  expect((await app.sdlcs.publish("lease-flow", workflow)).version).toBeGreaterThan(0);
}

async function recordInterruptedRun(req_id: string): Promise<string> {
  const versioned = await server.sdlcs.get("lease-flow", 1);
  const run_id = ulid();
  server.index.insertRun({ run_id, req_id, sdlc_id: "lease-flow", sdlc_version: 1, workflow_revision: versioned.workflow_revision,
    status: "running", started_at: new Date().toISOString(), finished_at: null, error: null });
  const session = await server.sessions.open(req_id);
  await session.events.append({ event_id: ulid(), session_id: req_id, schema_version: "1", type: "workflow.run.started",
    actor: { kind: "human", id: "local-human" }, correlation_id: run_id, source: { adapter: "console-server" },
    payload: { run_id, workflow_id: versioned.def.metadata.id, workflow_revision: versioned.workflow_revision, sdlc_id: "lease-flow", sdlc_version: 1 } });
  return run_id;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cord-workspace-lease-"));
  await mkdir(join(root, "cord"), { recursive: true });
  server = await buildApp({ root });
  await prepare(root, server);
  expect((await inject("POST", "/requirements", { req_id: "REQ-A", title: "lease A" })).status).toBe(201);
  expect((await inject("POST", "/requirements", { req_id: "REQ-B", title: "lease B" })).status).toBe(201);
});

afterEach(async () => {
  await server.app.close();
  server.index.close();
  await rm(root, { recursive: true, force: true });
});

describe("workspace agent lease", () => {
  it("真实双 server 进程的 HTTP 冲突无启动事实，释放后可交付 Draft", async () => {
    let child: ChildProcess | undefined;
    try {
      child = spawn(process.execPath, ["--conditions=development", "--import", "tsx", server_fixture, root], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
      let timeout: NodeJS.Timeout | undefined;
      let receipt: { base: string };
      try {
        const [message] = await Promise.race([once(child, "message"), new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("第二个 server 未就绪")), 5000);
        })]);
        receipt = message as { base: string };
      } finally { clearTimeout(timeout); }
      let seq = 0;
      const http = async (method: string, route: string, payload?: unknown) => {
        const response = await fetch(receipt.base + "/api/v1" + route, { method,
          headers: { "content-type": "application/json", "idempotency-key": "cross-http-" + seq++ },
          ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
        return { status: response.status, body: await response.json() };
      };
      const first = await inject("POST", "/requirements/REQ-A/runs", { sdlc_id: "lease-flow" });
      expect(first.status).toBe(202);
      const rejected = await http("POST", "/requirements/REQ-B/runs", { sdlc_id: "lease-flow" });
      expect(rejected.status).toBe(409);
      expect((await http("GET", "/requirements/REQ-B/events")).body.events.some((event: { type: string }) => event.type === "workflow.run.started")).toBe(false);
      await inject("POST", `/runs/${first.body.run.run_id}/cancel`, { reason: "foreign release" });
      expect((await http("POST", "/requirements/REQ-B/runs", { sdlc_id: "lease-flow" })).status).toBe(202);
      await waitFor(async () => (await http("GET", "/requirements/REQ-B/approvals")).body.approvals.length === 1);
      const facts = (await http("GET", "/requirements/REQ-B/events")).body.events as Array<{ type: string }>;
      expect(facts.filter(event => event.type === "agent.task.started")).toHaveLength(1);
      expect(facts.filter(event => event.type === "human.decision.recorded" || event.type === "workflow.node.exited")).toHaveLength(0);
    } finally {
      if (child !== undefined && child.exitCode === null && child.signalCode === null) {
        const stopped = once(child, "exit");
        child.send({ action: "close" });
        const kill = setTimeout(() => child!.kill("SIGKILL"), 5000);
        try { await stopped; } finally { clearTimeout(kill); }
      }
    }
  });

  it("关闭发生在启动校验期间，不登记或派发新 run，重启后没有遗留占位", async () => {
    let release!: () => void;
    let entered!: () => void;
    const paused = new Promise<void>(resolve => { release = resolve; });
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const starting = server.runs.start("REQ-A", "lease-flow", 1, {
      validate: async () => { entered(); await paused; }, record: async () => {},
    });
    await reached;
    await server.app.close();
    release();
    await expect(starting).rejects.toThrow(/关闭/);
    expect(server.runs.listRuns("REQ-A")).toHaveLength(0);
    expect((await (await server.sessions.open("REQ-A")).events.readOrdered()).some(event => event.type === "agent.task.started")).toBe(false);
    server.index.close();
    server = await buildApp({ root });
    expect((await inject("POST", "/requirements/REQ-B/runs", { sdlc_id: "lease-flow" })).status).toBe(202);
  });

  it.each(["headless", "acp"] as const)("%s 在途进程占用工作区，取消收束后才可再次派发", async protocol => {
    const pid_file = join(root, "worker.pid");
    await writeFile(join(root, "cord", "agents.yaml"), stringify({ agents: { worker: {
      kind: protocol, bin: process.execPath, args: protocol === "headless"
        ? [fixture, "--mode", "claude", "--no-tools", "--pid-file", pid_file, "--sleep", "60000", "{{prompt}}"]
        : [acp_fixture, "--mode", "hang", "--no-tools", "--pid-file", pid_file],
    } } }));
    await server.agents.reload();
    const first = await inject("POST", "/requirements/REQ-A/runs", { sdlc_id: "lease-flow" });
    expect(first.status).toBe(202);
    let pid = 0;
    await waitFor(async () => {
      try { pid = Number(await readFile(pid_file, "utf8")); return pid > 0; } catch { return false; }
    });
    expect((await inject("POST", "/requirements/REQ-B/runs", { sdlc_id: "lease-flow" })).status).toBe(409);
    expect(server.runs.listRuns("REQ-B")).toHaveLength(0);
    expect((await inject("POST", `/runs/${first.body.run.run_id}/cancel`, {})).status).toBe(200);
    await waitFor(async () => { try { process.kill(pid, 0); return false; } catch { return true; } });
    await prepare(root, server);
    expect((await inject("POST", "/requirements/REQ-B/runs", { sdlc_id: "lease-flow" })).status).toBe(202);
  });

  it("启动事实写失败释放占位，修复后另一需求可派发", async () => {
    const session = await server.sessions.open("REQ-A");
    const append = session.events.append.bind(session.events);
    const failed = vi.spyOn(session.events, "append").mockImplementation(async draft => {
      if (draft.type === "workflow.run.started") throw new Error("lease start fsync failure");
      return append(draft);
    });
    try { expect((await inject("POST", "/requirements/REQ-A/runs", { sdlc_id: "lease-flow" })).status).toBe(500); }
    finally { failed.mockRestore(); }
    expect((await session.events.readOrdered()).some(event => event.type === "agent.task.started")).toBe(false);
    expect((await inject("POST", "/requirements/REQ-B/runs", { sdlc_id: "lease-flow" })).status).toBe(202);
  });

  it("恢复被延后时仍可取消，释放后不会派发已取消 run", async () => {
    const first = await inject("POST", "/requirements/REQ-A/runs", { sdlc_id: "lease-flow" });
    const original = await recordInterruptedRun("REQ-B");
    expect(await server.runs.recover(original)).toEqual([]);
    await inject("POST", `/runs/${original}/cancel`, { reason: "cancel deferred" });
    await inject("POST", `/runs/${first.body.run.run_id}/cancel`, { reason: "release" });
    await server.runs.recover(original);
    expect(await server.runs.getRun(original)).toMatchObject({ status: "cancelled" });
    expect((await (await server.sessions.open("REQ-B")).events.readOrdered()).some(event => event.type === "agent.task.started")).toBe(false);
  });

  it("登记前故障释放 workspace 占位，不派发 worker", async () => {
    const failed = vi.spyOn(server.index, "insertRun").mockImplementationOnce(() => { throw new Error("lease insert failure"); });
    try {
      expect((await inject("POST", "/requirements/REQ-A/runs", { sdlc_id: "lease-flow" })).status).toBe(500);
    } finally { failed.mockRestore(); }
    expect((await (await server.sessions.open("REQ-A")).events.readOrdered()).some(event => event.type === "agent.task.started")).toBe(false);
    const next = await inject("POST", "/requirements/REQ-B/runs", { sdlc_id: "lease-flow" });
    expect(next.status).toBe(202);
  });

  it("恢复资源冲突保留原 run，lease 释放后自动恢复而不重授预算", async () => {
    const first = await inject("POST", "/requirements/REQ-A/runs", { sdlc_id: "lease-flow" });
    expect(first.status).toBe(202);
    await waitFor(async () => (await inject("GET", "/requirements/REQ-A/approvals")).body.approvals.length === 1);
    const original = await recordInterruptedRun("REQ-B");
    expect(await server.runs.recover(original)).toEqual([]);
    expect(await server.runs.getRun(original)).toMatchObject({ status: "running", error: null });
    expect((await (await server.sessions.open("REQ-B")).events.readOrdered()).some(event => event.type === "agent.task.started")).toBe(false);
    await inject("POST", `/runs/${first.body.run.run_id}/cancel`, { reason: "lease release" });
    await waitFor(async () => (await inject("GET", "/requirements/REQ-B/approvals")).body.approvals.length === 1);
    expect(await server.runs.getRun(original)).toMatchObject({ status: "running", run_id: original });
    expect((await inject("GET", "/requirements/REQ-B")).body.requirement.status).toBe("waiting_human");
    const facts = await (await server.sessions.open("REQ-B")).events.readOrdered();
    expect(facts.filter(event => event.type === "workflow.run.started")).toHaveLength(1);
    expect(facts.filter(event => event.type === "agent.task.started")).toHaveLength(1);
  });

  it("并发启动只登记一个 run，被拒绝的需求没有执行事实", async () => {
    const responses = await Promise.all(["REQ-A", "REQ-B"].map(req_id => inject("POST", `/requirements/${req_id}/runs`, { sdlc_id: "lease-flow" })));
    expect(responses.map(response => response.status).sort()).toEqual([202, 409]);
    const rejected = responses[0]!.status === 409 ? "REQ-A" : "REQ-B";
    const facts = await (await server.sessions.open(rejected)).events.readOrdered();
    expect(facts.filter(event => ["workflow.run.started", "agent.task.started", "agent.task.completed"].includes(event.type))).toHaveLength(0);
    expect(server.runs.listRuns(rejected)).toHaveLength(0);
  });

  it.each([false, true])("冷恢复多个既有 run 串行派发，索引删除=%s", async delete_index => {
    const originals = [await recordInterruptedRun("REQ-A"), await recordInterruptedRun("REQ-B")];
    await server.app.close(); server.index.close();
    if (delete_index) await rm(join(root, "cord", ".index"), { recursive: true, force: true });
    server = await buildApp({ root });
    const req_ids = ["REQ-A", "REQ-B"];
    expect(req_ids.filter(req_id => server.runs.isActive(req_id))).toHaveLength(1);
    const active = req_ids.find(req_id => server.runs.isActive(req_id))!;
    const deferred = req_ids.find(req_id => req_id !== active)!;
    const original = originals[req_ids.indexOf(deferred)]!;
    expect(await server.runs.getRun(original)).toMatchObject({ status: "running", error: null });
    expect((await (await server.sessions.open(deferred)).events.readOrdered()).some(event => event.type === "agent.task.started")).toBe(false);
    await waitFor(async () => (await inject("GET", `/requirements/${active}/approvals`)).body.approvals.length === 1);
    await inject("POST", `/runs/${server.runs.activeRunId(active)}/cancel`, { reason: "cold lease release" });
    await waitFor(async () => (await inject("GET", `/requirements/${deferred}/approvals`)).body.approvals.length === 1);
    expect(server.runs.activeRunId(deferred)).toBe(original);
    for (const req_id of req_ids) {
      const facts = await (await server.sessions.open(req_id)).events.readOrdered();
      expect(facts.filter(event => event.type === "workflow.run.started")).toHaveLength(1);
      expect(facts.filter(event => event.type === "agent.task.started")).toHaveLength(1);
    }
  });

  it("无 agent 的离线流程不占用 workspace lease", async () => {
    const first = await inject("POST", "/requirements/REQ-A/runs", { sdlc_id: "lease-flow" });
    expect(first.status).toBe(202);
    const second = await inject("POST", "/requirements/REQ-B/runs", { sdlc_id: "simple-sdlc" });
    expect(second.status).toBe(202);
    await waitFor(async () => (await inject("GET", "/requirements/REQ-B/approvals")).body.approvals.length === 1);
    expect((await (await server.sessions.open("REQ-B")).events.readOrdered()).some(event => event.type === "agent.task.started")).toBe(false);
  });

  it("同一 workspace 的 agent run 冲突 fail-closed，前一个取消后释放", async () => {
    const first = await inject("POST", "/requirements/REQ-A/runs", { sdlc_id: "lease-flow" });
    expect(first.status).toBe(202);
    await waitFor(async () => (await inject("GET", "/requirements/REQ-A/approvals")).body.approvals.length === 1);
    const blocked = await inject("POST", "/requirements/REQ-B/runs", { sdlc_id: "lease-flow" });
    expect(blocked.status).toBe(409);
    expect(blocked.body.message).toContain("工作区");
    expect((await inject("POST", `/runs/${first.body.run.run_id}/cancel`, { reason: "lease test" })).status).toBe(200);
    await waitFor(async () => !server.runs.isActive("REQ-A"));
    const second = await inject("POST", "/requirements/REQ-B/runs", { sdlc_id: "lease-flow" });
    expect(second.status).toBe(202);
    await inject("POST", `/runs/${second.body.run.run_id}/cancel`, { reason: "lease cleanup" });
  });

  it("不同 server workspace 可以并发运行 agent", async () => {
    const otherRoot = await mkdtemp(join(tmpdir(), "cord-workspace-lease-other-"));
    let other: BuiltServer | undefined;
    try {
      other = await buildApp({ root: otherRoot });
      await prepare(otherRoot, other);
      const create = await other.app.inject({ method: "POST", url: "/api/v1/requirements", payload: { req_id: "REQ-OTHER", title: "other workspace" }, headers: { "idempotency-key": "other-create" } });
      expect(create.statusCode).toBe(201);
      const first = await inject("POST", "/requirements/REQ-A/runs", { sdlc_id: "lease-flow" });
      const second = await other.app.inject({ method: "POST", url: "/api/v1/requirements/REQ-OTHER/runs", payload: { sdlc_id: "lease-flow" }, headers: { "idempotency-key": "other-start" } });
      expect(first.status).toBe(202);
      expect(second.statusCode).toBe(202);
      await inject("POST", `/runs/${first.body.run.run_id}/cancel`, { reason: "lease cleanup" });
      const otherRun = second.json().run as { run_id: string };
      await other.app.inject({ method: "POST", url: `/api/v1/runs/${otherRun.run_id}/cancel`, payload: { reason: "lease cleanup" }, headers: { "idempotency-key": "other-cancel" } });
    } finally {
      if (other !== undefined) { await other.app.close(); other.index.close(); }
      await rm(otherRoot, { recursive: true, force: true });
    }
  });

  it("同一 root 的两个 server 实例共享 SQLite lease", async () => {
    let other: BuiltServer | undefined;
    try {
      other = await buildApp({ root });
      const created = await other.app.inject({ method: "POST", url: "/api/v1/requirements", payload: { req_id: "REQ-C", title: "cross server" }, headers: { "idempotency-key": "cross-create" } });
      expect(created.statusCode).toBe(201);
      const first = await inject("POST", "/requirements/REQ-A/runs", { sdlc_id: "lease-flow" });
      expect(first.status).toBe(202);
      const conflict_response = await other.app.inject({ method: "POST", url: "/api/v1/requirements/REQ-C/runs", payload: { sdlc_id: "lease-flow" }, headers: { "idempotency-key": "cross-start-1" } });
      expect(conflict_response.statusCode).toBe(409);
      const other_facts = await (await other.sessions.open("REQ-C")).events.readOrdered();
      expect(other_facts.filter(event => event.type === "workflow.run.started")).toHaveLength(0);
      await inject("POST", `/runs/${first.body.run.run_id}/cancel`, { reason: "cross server release" });
      await waitFor(async () => !server.runs.isActive("REQ-A"));
      const second = await other.app.inject({ method: "POST", url: "/api/v1/requirements/REQ-C/runs", payload: { sdlc_id: "lease-flow" }, headers: { "idempotency-key": "cross-start-2" } });
      expect(second.statusCode).toBe(202);
      await other.app.inject({ method: "POST", url: `/api/v1/runs/${second.json().run.run_id}/cancel`, payload: {}, headers: { "idempotency-key": "cross-cancel" } });
    } finally {
      if (other !== undefined) { await other.app.close(); other.index.close(); }
    }
  });

  it("另一 server 释放锁后，原授权恢复通过定时重检自动继续", async () => {
    let other: BuiltServer | undefined;
    const first = await inject("POST", "/requirements/REQ-A/runs", { sdlc_id: "lease-flow" });
    await waitFor(async () => (await inject("GET", "/requirements/REQ-A/approvals")).body.approvals.length === 1);
    const original = await recordInterruptedRun("REQ-B");
    try {
      other = await buildApp({ root });
      expect(other.runs.isActive("REQ-B")).toBe(false);
      expect((await other.runs.getRun(original)).status).toBe("running");
      await inject("POST", `/runs/${first.body.run.run_id}/cancel`, { reason: "foreign release" });
      await waitFor(async () => other!.runs.isActive("REQ-B") && (await other!.sessions.listApprovals("REQ-B")).length === 1);
      expect(other.runs.activeRunId("REQ-B")).toBe(original);
      const facts = await (await other.sessions.open("REQ-B")).events.readOrdered();
      expect(facts.filter(event => event.type === "workflow.run.started")).toHaveLength(1);
      expect(facts.filter(event => event.type === "agent.task.started")).toHaveLength(1);
    } finally { if (other !== undefined) { await other.app.close(); other.index.close(); } }
  });

  it("锁文件损坏返回 500，不记录启动事实，修复后可用", async () => {
    const file = join(root, "cord/.index/workspace-lease.sqlite");
    await writeFile(file, "BAD_SQLITE_LOCK");
    const rejected = await inject("POST", "/requirements/REQ-A/runs", { sdlc_id: "lease-flow" });
    expect(rejected.status).toBe(500);
    expect(rejected.body.message).toContain("执行锁不可读取");
    expect((await (await server.sessions.open("REQ-A")).events.readOrdered()).some(event => event.type === "workflow.run.started")).toBe(false);
    expect(server.runs.listRuns("REQ-A")).toHaveLength(0);
    await rm(file);
    expect((await inject("POST", "/requirements/REQ-A/runs", { sdlc_id: "lease-flow" })).status).toBe(202);
  });

  it("worker 启动失败形成终态后释放 lease", async () => {
    await writeFile(join(root, "cord", "agents.yaml"), stringify({ agents: {
      worker: { kind: "headless", bin: process.execPath, args: [fixture, "--mode", "fail", "{{prompt}}"] },
    } }), "utf8");
    await server.agents.reload();
    expect((await inject("POST", "/requirements/REQ-A/runs", { sdlc_id: "lease-flow" })).status).toBe(202);
    await waitFor(async () => (await inject("GET", "/requirements/REQ-A/runs")).body.runs[0]?.status === "failed" && !server.runs.isActive("REQ-A"));
    await prepare(root, server);
    const recovered = await inject("POST", "/requirements/REQ-B/runs", { sdlc_id: "lease-flow" });
    expect(recovered.status).toBe(202);
    await inject("POST", `/runs/${recovered.body.run.run_id}/cancel`, { reason: "lease cleanup" });
  });
});
