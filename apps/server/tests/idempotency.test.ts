/** 统一写入口：身份绑定、并发合并、恢复与持久化故障。 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import Fastify from "fastify";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp, type BuiltServer } from "@agent-cord/server";
import { installIdempotency, requestInputHash } from "../src/services/idempotency.js";

let root: string;
let server: BuiltServer;
const yaml = "apiVersion: agent-cord.dev/v1alpha1\nkind: Workflow\nmetadata: {id: idem-sdlc}\nspec:\n  nodes:\n    - id: review\n      gates:\n        - id: evidence\n          role: {}\n          attach: {node: review, when: post}\n          checks: [{ref: anchors-present}]\n          pass: {require: all, human_confirm: false}\n          on_fail: block\n";

async function request(method: "POST" | "PUT" | "DELETE" | "GET", url: string, body?: unknown, key?: string) {
  const response = await server.app.inject({ method, url,
    headers: { ...(key !== undefined ? { "idempotency-key": key } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}) });
  return { status: response.statusCode, body: response.json() as Record<string, any>, content_type: response.headers["content-type"] };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
async function restart() { await server.app.close(); server.index.close(); server = await buildApp({ root }); }
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "cord-idempotency-")); server = await buildApp({ root }); });
afterEach(async () => {
  vi.restoreAllMocks();
  for (const run of server.runs.listRuns()) if (server.runs.activeRunId(run.req_id) === run.run_id) await server.runs.cancel(run.run_id);
  await server.app.close(); server.index.close(); await rm(root, { recursive: true, force: true });
});

describe("统一幂等写入口", () => {
  it("同路径不同输入返回 409，不把旧响应伪装成新文档保存", async () => {
    await request("POST", "/api/v1/requirements", { req_id: "REQ-INPUT", title: "输入绑定" }, "create-input");
    const url = "/api/v1/requirements/REQ-INPUT/docs/prd";
    expect((await request("PUT", url, { content: "# FIRST_CONTENT" }, "save-once")).status).toBe(200);
    const conflict = await request("PUT", url, { content: "# SECOND_CONTENT" }, "save-once");
    expect(conflict.status).toBe(409);
    expect((await request("GET", url)).body.content).toBe("# FIRST_CONTENT");
  });

  it("对象字段顺序变化仍是同一次请求，字符串改变则不是", async () => {
    const first = await request("POST", "/api/v1/requirements", { req_id: "REQ-ORDER", title: "字段顺序", prd: "# PRD" }, "ordered-request");
    expect(first.status).toBe(201);
    const replay = await request("POST", "/api/v1/requirements", { prd: "# PRD", title: "字段顺序", req_id: "REQ-ORDER" }, "ordered-request");
    expect(replay).toEqual(first);
    expect((await request("POST", "/api/v1/requirements", { req_id: "REQ-ORDER", title: "不同标题", prd: "# PRD" }, "ordered-request")).status).toBe(409);
  });

  it("同键并发自动 ID 创建只创建一个需求，所有请求得到相同的首次响应", async () => {
    const entered = deferred(); const release = deferred();
    const create = server.sessions.create.bind(server.sessions);
    const spy = vi.spyOn(server.sessions, "create").mockImplementation(async (...args) => { entered.resolve(); await release.promise; return create(...args); });
    const first = request("POST", "/api/v1/requirements", { title: "自动 ID" }, "concurrent-create");
    await entered.promise;
    const duplicates = [request("POST", "/api/v1/requirements", { title: "自动 ID" }, "concurrent-create"), request("POST", "/api/v1/requirements", { title: "自动 ID" }, "concurrent-create")];
    release.resolve();
    const responses = await Promise.all([first, ...duplicates]);
    expect(responses.map((item) => item.status)).toEqual([201, 201, 201]);
    expect(responses[1]).toEqual(responses[0]); expect(responses[2]).toEqual(responses[0]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await server.sessions.listIds()).toHaveLength(1);
  });

  it("同键并发发布只执行一次，版本和 request_id 完全重放", async () => {
    const entered = deferred(); const release = deferred();
    const publish = server.sdlcs.publish.bind(server.sdlcs);
    const spy = vi.spyOn(server.sdlcs, "publish").mockImplementation(async (...args) => { entered.resolve(); await release.promise; return publish(...args); });
    const first = request("POST", "/api/v1/sdlcs/idem-sdlc/versions/publish", { yaml }, "concurrent-publish");
    await entered.promise;
    const duplicate = request("POST", "/api/v1/sdlcs/idem-sdlc/versions/publish", { yaml }, "concurrent-publish");
    release.resolve();
    const responses = await Promise.all([first, duplicate]);
    expect(responses[0]!.status).toBe(201); expect(responses[1]).toEqual(responses[0]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect((await server.sdlcs.list()).find((item) => item.sdlc_id === "idem-sdlc")?.versions).toHaveLength(1);
  });

  it("同键并发 run 启动共享结果，不把重复请求误判为另一条在途 run", async () => {
    await request("POST", "/api/v1/requirements", { req_id: "REQ-RUN", title: "并发启动" }, "create-run");
    const url = "/api/v1/requirements/REQ-RUN/runs";
    const responses = await Promise.all([request("POST", url, {}, "start-run"), request("POST", url, {}, "start-run")]);
    expect(responses.map((item) => item.status)).toEqual([202, 202]);
    expect(responses[1]).toEqual(responses[0]);
    expect(server.runs.listRuns("REQ-RUN")).toHaveLength(1);
    expect((await server.sessions.readEvents("REQ-RUN")).filter((event) => event.type === "workflow.run.started")).toHaveLength(1);
  });

  it("缓存重启后仍绑定输入，不同内容不会静默重放旧成功", async () => {
    const input = { req_id: "REQ-RESTART", title: "持久身份" };
    const first = await request("POST", "/api/v1/requirements", input, "persisted-key");
    await restart();
    expect(await request("POST", "/api/v1/requirements", input, "persisted-key")).toEqual(first);
    expect((await request("POST", "/api/v1/requirements", { ...input, title: "修改输入" }, "persisted-key")).status).toBe(409);
    expect((await server.sessions.readEvents("REQ-RESTART")).filter((event) => event.type === "session.created")).toHaveLength(1);
  });

  it("旧缓存没有输入指纹时明确拒绝猜测，不改写历史记录", async () => {
    const db = new DatabaseSync(join(root, "cord", ".index", "server-index.sqlite"));
    db.prepare("INSERT INTO idempotency_keys (key,method,path,status,response,created_at) VALUES (?,?,?,?,?,?)").run("legacy-key", "POST", "/api/v1/requirements", 201, '{"request_id":"legacy-response"}', "2026-10-07T00:00:00.000Z");
    db.close();
    const result = await request("POST", "/api/v1/requirements", { title: "新的输入" }, "legacy-key");
    expect(result.status).toBe(409); expect(result.body.code).toBe("idempotency_legacy");
    expect(await server.sessions.listIds()).toEqual([]);
  });

  it("在途同键跨路径/方法/输入冲突不释放原 owner，原请求仍被正确缓存", async () => {
    const entered = deferred(); const release = deferred();
    const publish = server.sdlcs.publish.bind(server.sdlcs);
    const spy = vi.spyOn(server.sdlcs, "publish").mockImplementation(async (...args) => { entered.resolve(); await release.promise; return publish(...args); });
    const url = "/api/v1/sdlcs/idem-sdlc/versions/publish";
    const first = request("POST", url, { yaml }, "owner-conflict");
    await entered.promise;
    const different_body = await request("POST", url, { yaml: yaml + "# 另一个输入\n" }, "owner-conflict");
    const different_route = await request("POST", "/api/v1/requirements", { title: "不能创建" }, "owner-conflict");
    const different_method = await request("PUT", "/api/v1/sdlcs/idem-sdlc/draft", { yaml }, "owner-conflict");
    expect([different_body.status, different_route.status, different_method.status]).toEqual([409, 409, 409]);
    expect(server.index.getIdempotency("owner-conflict")?.state).toBe("pending");
    release.resolve();
    const result = await first;
    expect(result.status).toBe(201);
    expect(await request("POST", url, { yaml }, "owner-conflict")).toEqual(result);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await server.sessions.listIds()).toEqual([]);
  });

  it("所有写入口在业务之前持久化 pending，DB 中不保留请求正文", async () => {
    const input = { title: "PRIVATE_INPUT_MARKER", prd: "PRIVATE_PRD_MARKER" };
    const create = server.sessions.create.bind(server.sessions);
    vi.spyOn(server.sessions, "create").mockImplementation(async (...args) => {
      expect(server.index.getIdempotency("durable-before-create")).toMatchObject({ state: "pending", input_hash: expect.stringMatching(/^[0-9a-f]{64}$/), status: 0, response: "" });
      expect(JSON.stringify(server.index.getIdempotency("durable-before-create"))).not.toContain("PRIVATE_");
      return create(...args);
    });
    expect((await request("POST", "/api/v1/requirements", input, "durable-before-create")).status).toBe(201);
    expect(server.index.getIdempotency("durable-before-create")?.state).toBe("completed");
  });

  it("业务前持久化失败不进入 handler，修复后同键可重试", async () => {
    const reserved = vi.spyOn(server.index, "reserveIdempotency").mockImplementationOnce(() => { throw new Error("reserve unavailable"); });
    const create = vi.spyOn(server.sessions, "create");
    expect((await request("POST", "/api/v1/requirements", { title: "占位故障" }, "reserve-failure")).status).toBe(500);
    expect(create).not.toHaveBeenCalled();
    expect(server.index.getIdempotency("reserve-failure")).toBeNull();
    reserved.mockRestore();
    expect((await request("POST", "/api/v1/requirements", { title: "占位故障" }, "reserve-failure")).status).toBe(201);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("4xx 拒绝释放占位，修正输入可复用该键；成功后新输入不能复用", async () => {
    expect((await request("POST", "/api/v1/requirements", {}, "validation-retry")).status).toBe(400);
    expect(server.index.getIdempotency("validation-retry")).toBeNull();
    expect((await request("POST", "/api/v1/requirements", { title: "修复后输入" }, "validation-retry")).status).toBe(201);
    expect((await request("POST", "/api/v1/requirements", { title: "另一条需求" }, "validation-retry")).status).toBe(409);
    expect(await server.sessions.listIds()).toHaveLength(1);
  });

  it("同键在途 4xx 请求共享首次失败响应，之后修复可重试", async () => {
    const app = Fastify();
    const entered = deferred(); const release = deferred(); const duplicate_entered = deferred();
    let incoming = 0; let calls = 0; let rejected = true;
    app.addHook("preHandler", (_req, _reply, done) => { if (++incoming === 2) duplicate_entered.resolve(); done(); });
    installIdempotency(app, server.index);
    app.post("/api/v1/test-command", { config: { idempotency: true } }, async (req, reply) => {
      calls++; entered.resolve(); await release.promise;
      reply.code(rejected ? 400 : 201);
      return { request_id: String(req.id), rejected };
    });
    const input = { method: "POST" as const, url: "/api/v1/test-command", payload: {}, headers: { "idempotency-key": "rejected-command" } };
    try {
      const first = app.inject(input).then((response) => ({ status: response.statusCode, body: response.json() })); await entered.promise;
      const duplicate = app.inject(input).then((response) => ({ status: response.statusCode, body: response.json() }));
      await duplicate_entered.promise; release.resolve();
      const results = await Promise.all([first, duplicate]);
      expect(results[0]!.status).toBe(400); expect(results[1]).toEqual(results[0]); expect(calls).toBe(1);
      expect(server.index.getIdempotency("rejected-command")).toBeNull();
      rejected = false;
      expect((await app.inject(input)).statusCode).toBe(201); expect(calls).toBe(2);
    } finally { release.resolve(); await app.close(); }
  });

  it("业务发生后 5xx 保留 pending，重启后同键返回未确认且不重复副作用", async () => {
    const publish = server.sdlcs.publish.bind(server.sdlcs);
    vi.spyOn(server.sdlcs, "publish").mockImplementation(async (...args) => { await publish(...args); throw new Error("failed after publication"); });
    const url = "/api/v1/sdlcs/idem-sdlc/versions/publish";
    expect((await request("POST", url, { yaml }, "uncertain-command")).status).toBe(500);
    expect(server.index.getIdempotency("uncertain-command")?.state).toBe("pending");
    expect((await request("POST", url, { yaml }, "uncertain-command")).body.code).toBe("idempotency_incomplete");
    await restart();
    const replay = await request("POST", url, { yaml }, "uncertain-command");
    expect(replay.status).toBe(409); expect(replay.body.code).toBe("idempotency_incomplete");
    expect((await server.sdlcs.list()).find((item) => item.sdlc_id === "idem-sdlc")?.versions).toHaveLength(1);
  });

  it("副作用已完成而响应持久化失败时返回 500，不发布假成功或重跑 handler", async () => {
    const create = vi.spyOn(server.sessions, "create");
    const complete = vi.spyOn(server.index, "completeIdempotency").mockImplementationOnce(() => { throw new Error("response cache unavailable"); });
    const input = { req_id: "REQ-CACHE-FAIL", title: "响应故障" };
    const result = await request("POST", "/api/v1/requirements", input, "cache-failure");
    expect(result.status).toBe(500); expect(result.body.code).toBe("idempotency_unconfirmed");
    expect(create).toHaveBeenCalledTimes(1);
    expect((await server.sessions.readEvents("REQ-CACHE-FAIL")).filter((event) => event.type === "session.created")).toHaveLength(1);
    complete.mockRestore();
    expect((await request("POST", "/api/v1/requirements", input, "cache-failure")).body.code).toBe("idempotency_incomplete");
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("占位已持久化但宿主中断回执时，重启后不能视为未执行", async () => {
    const reserve = server.index.reserveIdempotency.bind(server.index);
    vi.spyOn(server.index, "reserveIdempotency").mockImplementationOnce((identity) => { reserve(identity); throw new Error("lost reservation receipt"); });
    const input = { title: "持久占位故障" };
    expect((await request("POST", "/api/v1/requirements", input, "reservation-unknown")).status).toBe(500);
    expect(await server.sessions.listIds()).toEqual([]);
    await restart();
    const replay = await request("POST", "/api/v1/requirements", input, "reservation-unknown");
    expect(replay.status).toBe(409); expect(replay.body.code).toBe("idempotency_incomplete");
    expect(await server.sessions.listIds()).toEqual([]);
  });

  it("无法缓存的流式写响应落未确认错误，不挂住同键等待者或重新执行", async () => {
    const app = Fastify();
    installIdempotency(app, server.index);
    let calls = 0;
    app.post("/api/v1/stream-command", { config: { idempotency: true } }, async () => { calls++; return Readable.from(["stream result"]); });
    const input = { method: "POST" as const, url: "/api/v1/stream-command", headers: { "idempotency-key": "uncacheable-response" } };
    try {
      const results = await Promise.all([app.inject(input), app.inject(input)]);
      expect(results.every((response) => response.statusCode === 500 || response.statusCode === 409)).toBe(true);
      expect(results.some((response) => response.statusCode === 500 && response.json().code === "idempotency_unconfirmed")).toBe(true);
      expect(calls).toBe(1);
      expect(server.index.getIdempotency("uncacheable-response")?.state).toBe("pending");
    } finally { await app.close(); }
  });

  it("4xx 占位释放失败不会留下可盲重试的键", async () => {
    vi.spyOn(server.index, "releaseIdempotency").mockImplementationOnce(() => { throw new Error("release unavailable"); });
    const result = await request("POST", "/api/v1/requirements", {}, "release-failure");
    expect(result.status).toBe(500); expect(result.body.code).toBe("idempotency_unconfirmed");
    expect((await request("POST", "/api/v1/requirements", {}, "release-failure")).body.code).toBe("idempotency_incomplete");
    expect(await server.sessions.listIds()).toEqual([]);
  });

  it("连接断开不取消业务，同键 HTTP 重试仍只发布一次", async () => {
    await server.app.listen({ host: "127.0.0.1", port: 0 });
    const address = server.app.server.address();
    if (address === null || typeof address === "string") throw new Error("监听地址缺失");
    const url = `http://127.0.0.1:${address.port}/api/v1/sdlcs/idem-sdlc/versions/publish`;
    const entered = deferred(); const release = deferred();
    const publish = server.sdlcs.publish.bind(server.sdlcs);
    const spy = vi.spyOn(server.sdlcs, "publish").mockImplementation(async (...args) => { entered.resolve(); await release.promise; return publish(...args); });
    const headers = { "content-type": "application/json", "idempotency-key": "disconnected-owner" };
    const controller = new AbortController();
    const first = fetch(url, { method: "POST", headers, body: JSON.stringify({ yaml }), signal: controller.signal }).catch(() => null);
    await entered.promise; controller.abort(); await first;
    const duplicate = fetch(url, { method: "POST", headers, body: JSON.stringify({ yaml }) });
    release.resolve();
    const result = await duplicate;
    expect(result.status).toBe(201);
    const body = await result.json();
    const replay = await fetch(url, { method: "POST", headers, body: JSON.stringify({ yaml }) });
    expect(await replay.json()).toEqual(body);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(server.index.getIdempotency("disconnected-owner")?.state).toBe("completed");
  });

  it("键长度有界，空白 trim 后仍是相同身份，非法键不进入业务", async () => {
    expect((await request("POST", "/api/v1/requirements", { title: "非法键" }, " ")).status).toBe(400);
    expect((await request("POST", "/api/v1/requirements", { title: "非法键" }, "x".repeat(201))).status).toBe(400);
    const first = await request("POST", "/api/v1/requirements", { title: "合法键" }, " trimmed-key ");
    expect(first.status).toBe(201);
    expect(await request("POST", "/api/v1/requirements", { title: "合法键" }, "trimmed-key")).toEqual(first);
    expect(await server.sessions.listIds()).toHaveLength(1);
  });

  it("文档、SDLC 草稿、删除与归档入口共享首次响应，各命令只调用一次 service", async () => {
    await server.sessions.create("REQ-TOOLS", "共享写命令");
    await server.sdlcs.publish("idem-sdlc", yaml);
    const save_doc = vi.spyOn(server.sessions, "writeDoc");
    const save_draft = vi.spyOn(server.sdlcs, "saveDraft");
    const delete_draft = vi.spyOn(server.sdlcs, "deleteDraft");
    const archive = vi.spyOn(server.sdlcs, "archive");
    const unarchive = vi.spyOn(server.sdlcs, "unarchive");
    for (const [method, url, body, key] of [
      ["PUT", "/api/v1/requirements/REQ-TOOLS/docs/plan", { content: "# 最新计划" }, "write-plan"],
      ["PUT", "/api/v1/sdlcs/idem-sdlc/draft", { yaml }, "write-draft"],
      ["DELETE", "/api/v1/sdlcs/idem-sdlc/draft", undefined, "delete-draft"],
      ["POST", "/api/v1/sdlcs/idem-sdlc/versions/1/archive", undefined, "archive-version"],
      ["POST", "/api/v1/sdlcs/idem-sdlc/versions/1/unarchive", undefined, "unarchive-version"],
    ] as const) {
      const responses = await Promise.all([request(method, url, body, key), request(method, url, body, key), request(method, url, body, key)]);
      expect(responses[0]!.status).toBe(200); expect(responses[1]).toEqual(responses[0]); expect(responses[2]).toEqual(responses[0]);
    }
    for (const spy of [save_doc, save_draft, delete_draft, archive, unarchive]) expect(spy).toHaveBeenCalledTimes(1);
    expect(await server.sdlcs.getDraft("idem-sdlc")).toBeNull();
    expect(server.sdlcs.isArchived("idem-sdlc", 1)).toBe(false);
    expect(await server.sessions.readDoc("REQ-TOOLS", "plan")).toBe("# 最新计划");
  });

  it("人工审批和取消同键并发共享结果，各自只落一条操作事实", async () => {
    await server.sessions.create("REQ-APPROVE", "审批幂等");
    await server.runs.start("REQ-APPROVE");
    let approval;
    const deadline = Date.now() + 10_000;
    while (approval === undefined) {
      approval = (await server.sessions.listApprovals("REQ-APPROVE"))[0];
      if (Date.now() > deadline) throw new Error("等待审批超时");
      if (approval === undefined) await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const approval_url = `/api/v1/requirements/REQ-APPROVE/approvals/${approval.approval_id}/decide`;
    const responses = await Promise.all([request("POST", approval_url, { choice: approval.options[0] }, "human-choice"), request("POST", approval_url, { choice: approval.options[0] }, "human-choice")]);
    expect(responses[0]!.status).toBe(200); expect(responses[1]).toEqual(responses[0]);
    expect((await server.sessions.readEvents("REQ-APPROVE")).filter((event) => event.type === "human.decision.recorded")).toHaveLength(1);
    await server.sessions.create("REQ-CANCEL", "取消幂等");
    const run = await server.runs.start("REQ-CANCEL");
    const url = `/api/v1/runs/${run.run_id}/cancel`;
    const cancelled = await Promise.all([request("POST", url, { reason: "人工取消" }, "run-cancel"), request("POST", url, { reason: "人工取消" }, "run-cancel")]);
    expect(cancelled[0]!.status).toBe(200); expect(cancelled[1]).toEqual(cancelled[0]);
    expect((await server.sessions.readEvents("REQ-CANCEL")).filter((event) => event.type === "workflow.run.cancelled")).toHaveLength(1);
  });
});

describe("请求输入指纹", () => {
  it("嵌套 JSON 字段序不影响身份，数组顺序、显式 null 和 absent 互不混用", () => {
    expect(requestInputHash({ nested: { b: 2, a: 1 }, items: [1, 2] })).toBe(requestInputHash({ items: [1, 2], nested: { a: 1, b: 2 } }));
    expect(requestInputHash({ items: [1, 2] })).not.toBe(requestInputHash({ items: [2, 1] }));
    expect(requestInputHash(undefined)).not.toBe(requestInputHash(null));
    expect(requestInputHash({ content: "a\nb" })).not.toBe(requestInputHash({ content: "ab" }));
  });

  it("JSON 自有 __proto__ 字段参与身份，不能让不同输入 hash 相同", () => {
    const first = JSON.parse('{"nested":{"__proto__":{"marker":"first"},"value":1}}');
    const second = JSON.parse('{"nested":{"__proto__":{"marker":"second"},"value":1}}');
    expect(requestInputHash(first)).not.toBe(requestInputHash(second));
    expect(requestInputHash(first)).not.toBe(requestInputHash({ nested: { value: 1 } }));
  });
});
