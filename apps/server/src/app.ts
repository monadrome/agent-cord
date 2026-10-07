/**
 * HTTP API 装配（ADR-0021）：Fastify 实例 + 路由 + 幂等键钩子 + SSE + 控制台静态托管。
 * 路由只做薄编排：参数校验 → 调 service → 统一响应/错误形状；状态变更全部经 service 落事件流。
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { ulid } from "ulid";
import { runDoctor, runInit, type WorkflowDef } from "agent-cord";
import {
  CreateRequirementInputSchema,
  DecideApprovalInputSchema,
  PublishSdlcInputSchema,
  SaveDraftInputSchema,
  SNAPSHOT_DOC_NAMES,
  StartRunInputSchema,
  StartCoordinationInputSchema,
  AdoptCoordinationInputSchema,
  UpdateDocInputSchema,
  ValidateSdlcInputSchema,
  type AgentCatalogView,
  type DashboardView,
  type RequirementStatus,
  type SnapshotDocName,
} from "./contracts.js";
import { ApiError, badRequest, conflict, notFound, parseOrThrow } from "./errors.js";
import { IndexStore } from "./services/index-store.js";
import { DEFAULT_SDLC_ID, SdlcService } from "./services/sdlc-service.js";
import { listSdlcTemplates } from "./services/sdlc-templates.js";
import { RunService } from "./services/run-service.js";
import { SessionService, toLedgerView } from "./services/session-service.js";
import { AgentService } from "./services/agent-service.js";
import { CoordinationService } from "./services/coordination-service.js";

export interface ServerOptions {
  /** 工作区根（内含 cord/；缺省自动初始化 cord/） */
  root: string;
  logger?: boolean;
  /** 控制台构建产物目录（存在才托管；默认 apps/console/dist） */
  consoleDist?: string;
}

export interface BuiltServer {
  app: FastifyInstance;
  sessions: SessionService;
  sdlcs: SdlcService;
  runs: RunService;
  index: IndexStore;
  agents: AgentService;
  coordination: CoordinationService;
}

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const SSE_HEARTBEAT_MS = 15_000;

function isDocName(value: string): value is SnapshotDocName {
  return (SNAPSHOT_DOC_NAMES as readonly string[]).includes(value);
}

function requestId(req: FastifyRequest): string {
  return String(req.id);
}

export async function buildApp(options: ServerOptions): Promise<BuiltServer> {
  const root = path.resolve(options.root);
  const app = Fastify({
    logger: options.logger ?? false,
    genReqId: () => ulid(),
    // 测试/重启路径需要 close() 不被 keep-alive 连接拖住
    forceCloseConnections: true,
  });

  const sessions = new SessionService(root);
  const agents = new AgentService(sessions.cordRoot);
  const catalog = await agents.reload();
  for (const warning of catalog.warnings) app.log.warn(`agents.yaml：${warning}`);
  const index = await IndexStore.open(sessions.cordRoot);
  const sdlcs = new SdlcService(sessions.cordRoot, index);

  const runs = new RunService(sessions, sdlcs, index, {
    driverResolverForRun: () => agents.resolver(),
    workspaceRoot: root,
  });
  const coordination = new CoordinationService(sessions, sdlcs, { workspaceRoot: root, resolver: () => agents.resolver(), runs, onError: (error) => app.log.error(error) });

  await runInit(root);
  await sdlcs.ensureDefaults();
  await coordination.recover();
  app.addHook("onClose", () => coordination.close());
  const resumed = await runs.recover();
  if (resumed.length > 0) app.log.info(`恢复未完成的 run：${resumed.join(", ")}`);

  // ---- 统一错误形状（ADR-0021 决策 7） -------------------------------------
  app.setErrorHandler((error: unknown, req, reply) => {
    if (error instanceof ApiError) {
      void reply.code(error.statusCode).send({
        code: error.code,
        message: error.message,
        details: error.details ?? null,
        request_id: requestId(req),
      });
      return;
    }
    const err = error as { statusCode?: unknown; message?: string };
    const statusCode = typeof err.statusCode === "number" ? err.statusCode : 500;
    void reply.code(statusCode).send({
      code: statusCode === 500 ? "internal_error" : "bad_request",
      message: typeof err.message === "string" ? err.message : "未知错误",
      details: null,
      request_id: requestId(req),
    });
  });

  // ---- 幂等键（ADR-0021 决策 4）：写命令必须带 Idempotency-Key，同键重放返回首次响应 ----
  app.addHook("preHandler", async (req, reply) => {
    if (!WRITE_METHODS.has(req.method) || !req.url.startsWith("/api/")) return;
    if ((req.routeOptions.config as unknown as Record<string, unknown>)["idempotency"] !== true) return;
    const key = req.headers["idempotency-key"];
    if (typeof key !== "string" || key.trim().length === 0) {
      throw badRequest("写命令必须携带 Idempotency-Key 头（重复提交不产生重复业务事件）");
    }
    const hit = index.getIdempotency(key.trim());
    if (hit !== null) {
      if (hit.method !== req.method || hit.path !== req.url) throw conflict("同一 Idempotency-Key 不能用于不同的写命令");
      await reply.code(hit.status).header("content-type", "application/json; charset=utf-8").send(hit.response);
    }
  });
  app.addHook("onSend", async (req, reply, payload) => {
    if (!WRITE_METHODS.has(req.method) || !req.url.startsWith("/api/")) return payload;
    if ((req.routeOptions.config as unknown as Record<string, unknown>)["idempotency"] !== true) return payload;
    if (reply.statusCode < 200 || reply.statusCode >= 300) return payload;
    const key = req.headers["idempotency-key"];
    if (typeof key !== "string" || key.trim().length === 0) return payload;
    index.putIdempotency({
      key: key.trim(),
      method: req.method,
      path: req.url,
      status: reply.statusCode,
      response: typeof payload === "string" ? payload : JSON.stringify(payload),
      created_at: new Date().toISOString(),
    });
    return payload;
  });

  // ---- 辅助：需求绑定的工作流定义（用于完成态/时间线投影） -------------------
  const defFor = async (reqId: string): Promise<WorkflowDef | null> => {
    const latest = index.latestRun(reqId);
    try {
      const versioned = await sdlcs.get(latest?.sdlc_id ?? DEFAULT_SDLC_ID, latest?.sdlc_version);
      return versioned.def;
    } catch {
      return null;
    }
  };

  // ---- 健康 / doctor -------------------------------------------------------
  const startedAt = Date.now();
  app.get("/api/v1/health", async (req) => ({
    request_id: requestId(req),
    ok: true,
    service: "agent-cord-server",
    version: "0.0.0",
    uptime_seconds: Math.round((Date.now() - startedAt) / 1000),
    cord_root: sessions.cordRoot,
  }));

  app.post("/api/v1/doctor", async (req) => {
    const report = await runDoctor(root);
    return { request_id: requestId(req), ...report };
  });

  // ---- Agent 配置清单与显式重载（ADR-0027） ---------------------------------
  app.get("/api/v1/agents", async (req) => ({
    request_id: requestId(req),
    ...agents.catalog(),
  }));
  type AgentReloadResponse = AgentCatalogView & { request_id: string };
  const pending_agent_reloads = new Map<string, Promise<AgentReloadResponse>>();
  const request_agent_reloads = new WeakMap<FastifyRequest, Promise<AgentReloadResponse>>();
  app.post("/api/v1/agents/reload", {
    config: { idempotency: true },
    // onSend 已持久化首次响应后才释放同键操作；失败也释放，允许修复后重试。
    onResponse: async (req) => {
      const key = String(req.headers["idempotency-key"]).trim();
      const operation = request_agent_reloads.get(req);
      if (operation !== undefined && pending_agent_reloads.get(key) === operation) {
        pending_agent_reloads.delete(key);
      }
    },
  }, async (req) => {
    const key = String(req.headers["idempotency-key"]).trim();
    let operation = pending_agent_reloads.get(key);
    if (operation === undefined) {
      operation = agents.reload().then((catalog) => ({ request_id: requestId(req), ...catalog }));
      pending_agent_reloads.set(key, operation);
    }
    request_agent_reloads.set(req, operation);
    return operation;
  });

  // ---- Dashboard -----------------------------------------------------------
  app.get("/api/v1/dashboard", async (req): Promise<DashboardView & { request_id: string }> => {
    const byStatus: Record<RequirementStatus, number> = {
      idle: 0,
      running: 0,
      waiting_human: 0,
      blocked: 0,
      completed: 0,
    };
    const approvals: DashboardView["pending_approvals"] = [];
    const ids = await sessions.listIds();
    for (const reqId of ids) {
      const summary = await sessions.summarize(reqId, runs.isActive(reqId), await defFor(reqId));
      byStatus[summary.status] += 1;
      approvals.push(...(await sessions.listApprovals(reqId)));
    }
    const failedRuns = runs.listRuns().filter((run) => run.status === "failed").slice(0, 20);
    return {
      request_id: requestId(req),
      requirements: { total: ids.length, by_status: byStatus },
      pending_approvals: approvals,
      failed_runs: failedRuns,
      doctor_ok: null,
    };
  });

  // ---- 需求 -----------------------------------------------------------------
  app.get("/api/v1/requirements", async (req) => {
    const out = [];
    for (const reqId of await sessions.listIds()) {
      out.push(await sessions.summarize(reqId, runs.isActive(reqId), await defFor(reqId)));
    }
    return { request_id: requestId(req), requirements: out };
  });

  app.post("/api/v1/requirements", { config: { idempotency: true } }, async (req, reply) => {
    const input = parseOrThrow(CreateRequirementInputSchema, req.body);
    const reqId = input.req_id ?? `REQ-${ulid().slice(-10)}`;
    const created = await sessions.create(reqId, input.title, input.prd);
    const summary = await sessions.summarize(reqId, false, null);
    reply.code(201);
    return { request_id: requestId(req), event_id: created.event_id, requirement: summary };
  });

  app.get("/api/v1/requirements/:req_id", async (req) => {
    const { req_id: reqId } = req.params as { req_id: string };
    const detail = await sessions.detail(reqId, runs.isActive(reqId), await defFor(reqId));
    detail.active_run = runs.activeRunId(reqId) !== null ? await runs.getRun(runs.activeRunId(reqId) ?? "") : null;
    return { request_id: requestId(req), requirement: detail };
  });

  app.get("/api/v1/requirements/:req_id/ledger", async (req) => {
    const { req_id: reqId } = req.params as { req_id: string };
    const ledger = await sessions.readLedger(reqId);
    return { request_id: requestId(req), projection_version: ledger.output_hash, ledger: toLedgerView(ledger) };
  });

  app.get("/api/v1/requirements/:req_id/timeline", async (req) => {
    const { req_id: reqId } = req.params as { req_id: string };
    const def = await defFor(reqId);
    const nodes = await sessions.timeline(reqId, def);
    const latest = index.latestRun(reqId);
    return {
      request_id: requestId(req),
      timeline: {
        req_id: reqId,
        sdlc_id: latest?.sdlc_id ?? def?.metadata.id ?? DEFAULT_SDLC_ID,
        sdlc_version: latest?.sdlc_version ?? null,
        run: latest !== null ? await runs.getRun(latest.run_id) : null,
        nodes,
      },
    };
  });

  app.get("/api/v1/requirements/:req_id/approvals", async (req) => {
    const { req_id: reqId } = req.params as { req_id: string };
    return { request_id: requestId(req), approvals: await sessions.listApprovals(reqId) };
  });

  app.get("/api/v1/requirements/:req_id/votes", async (req) => {
    const { req_id: reqId } = req.params as { req_id: string };
    return { request_id: requestId(req), votes: await sessions.listVotes(reqId) };
  });

  app.get("/api/v1/requirements/:req_id/runs", async (req) => {
    const { req_id: reqId } = req.params as { req_id: string };
    return { request_id: requestId(req), runs: runs.listRuns(reqId) };
  });

  // ---- 独立 Context Session Agent 协调轮次（ADR-0032） ----------------------
  app.get("/api/v1/requirements/:req_id/coordination", async (req) => {
    const { req_id } = req.params as { req_id: string };
    return { request_id: requestId(req), rounds: await coordination.list(req_id) };
  });
  app.get("/api/v1/requirements/:req_id/coordination/:round_id", async (req) => {
    const { req_id, round_id } = req.params as { req_id: string; round_id: string };
    return { request_id: requestId(req), round: await coordination.get(req_id, round_id) };
  });
  const pending_coordination_requests = new Map<string, { signature: string; promise: Promise<unknown> }>();
  const coordination_request_entries = new WeakMap<FastifyRequest, { signature: string; promise: Promise<unknown> }>();
  app.addHook("onResponse", async (req) => {
    const entry = coordination_request_entries.get(req);
    const key = String(req.headers["idempotency-key"]).trim();
    if (entry !== undefined && pending_coordination_requests.get(key) === entry) pending_coordination_requests.delete(key);
  });
  app.post("/api/v1/requirements/:req_id/coordination", { config: { idempotency: true } }, async (req, reply) => {
    const { req_id } = req.params as { req_id: string };
    const input = parseOrThrow(StartCoordinationInputSchema, req.body);
    const key = String(req.headers["idempotency-key"]).trim();
    const signature = JSON.stringify([req_id, input]);
    let pending = pending_coordination_requests.get(key);
    if (pending !== undefined && pending.signature !== signature) throw conflict("同一 Idempotency-Key 不能用于不同的协调请求");
    if (pending === undefined) {
      pending = { signature, promise: coordination.start(req_id, input).then((round) => ({ request_id: requestId(req), round })) };
      pending_coordination_requests.set(key, pending);
    }
    coordination_request_entries.set(req, pending);
    reply.code(202);
    return pending.promise;
  });
  app.post("/api/v1/requirements/:req_id/coordination/:round_id/cancel", { config: { idempotency: true } }, async (req) => {
    const { req_id, round_id } = req.params as { req_id: string; round_id: string };
    return { request_id: requestId(req), round: await coordination.cancel(req_id, round_id) };
  });
  app.post("/api/v1/requirements/:req_id/coordination/:round_id/adopt", { config: { idempotency: true } }, async (req, reply) => {
    const { req_id, round_id } = req.params as { req_id: string; round_id: string };
    parseOrThrow(AdoptCoordinationInputSchema, req.body ?? {});
    const run = await coordination.adopt(req_id, round_id);
    reply.code(202);
    return { request_id: requestId(req), run };
  });

  app.get("/api/v1/runs/:run_id", async (req) => {
    const { run_id: runId } = req.params as { run_id: string };
    return { request_id: requestId(req), run: await runs.getRun(runId) };
  });

  // ---- 命令：取消 run（ADR-0025）-------------------------------------------
  app.post("/api/v1/runs/:run_id/cancel", { config: { idempotency: true } }, async (req) => {
    const { run_id: runId } = req.params as { run_id: string };
    const body = (req.body ?? {}) as { reason?: unknown };
    const reason = typeof body.reason === "string" && body.reason.trim().length > 0 ? body.reason.trim() : undefined;
    const run = await runs.cancel(runId, reason);
    return { request_id: requestId(req), run };
  });

  // ---- 快照文档（living 文档：允许人编辑；状态机流转只经事件流） -------------
  app.get("/api/v1/requirements/:req_id/docs/:doc", async (req) => {
    const { req_id: reqId, doc } = req.params as { req_id: string; doc: string };
    if (!isDocName(doc)) throw notFound(`未知文档：${doc}（可选 ${SNAPSHOT_DOC_NAMES.join("/")}）`);
    return { request_id: requestId(req), doc, content: await sessions.readDoc(reqId, doc) };
  });

  app.put("/api/v1/requirements/:req_id/docs/:doc", { config: { idempotency: true } }, async (req) => {
    const { req_id: reqId, doc } = req.params as { req_id: string; doc: string };
    if (!isDocName(doc)) throw notFound(`未知文档：${doc}（可选 ${SNAPSHOT_DOC_NAMES.join("/")}）`);
    const input = parseOrThrow(UpdateDocInputSchema, req.body);
    await sessions.writeDoc(reqId, doc, input.content);
    return { request_id: requestId(req), doc, updated: true };
  });

  // ---- 命令：启动 run / 人工 gate 决策 --------------------------------------
  app.post("/api/v1/requirements/:req_id/runs", { config: { idempotency: true } }, async (req, reply) => {
    const { req_id: reqId } = req.params as { req_id: string };
    const input = parseOrThrow(StartRunInputSchema, req.body ?? {});
    const run = await runs.start(reqId, input.sdlc_id, input.sdlc_version);
    reply.code(202);
    return { request_id: requestId(req), run };
  });

  app.post(
    "/api/v1/requirements/:req_id/approvals/:approval_id/decide",
    { config: { idempotency: true } },
    async (req) => {
      const { req_id: reqId, approval_id: approvalId } = req.params as {
        req_id: string;
        approval_id: string;
      };
      const input = parseOrThrow(DecideApprovalInputSchema, req.body);
      const decided = await runs.decide(reqId, approvalId, input.choice);
      return { request_id: requestId(req), event_id: decided.event_id, decided: true };
    },
  );

  // ---- 事件：REST 快照 + SSE 订阅 -------------------------------------------
  app.get("/api/v1/requirements/:req_id/events", async (req) => {
    const { req_id: reqId } = req.params as { req_id: string };
    const afterSeqRaw = (req.query as { after_seq?: string }).after_seq;
    const afterSeq = afterSeqRaw === undefined ? undefined : Number.parseInt(afterSeqRaw, 10);
    if (afterSeq !== undefined && !Number.isInteger(afterSeq)) {
      throw badRequest(`after_seq 必须是整数：${afterSeqRaw}`);
    }
    const events = await sessions.readEvents(reqId, afterSeq);
    return { request_id: requestId(req), events };
  });

  /**
   * SSE（ADR-0021 决策 2）：id = 事件流 seq；Last-Event-ID 断线回放；事件先落盘后推送。
   */
  app.get("/api/v1/requirements/:req_id/events/stream", async (req, reply) => {
    const { req_id: reqId } = req.params as { req_id: string };
    const session = await sessions.open(reqId);
    const lastEventId = req.headers["last-event-id"];
    const afterSeq =
      typeof lastEventId === "string" && /^\d+$/.test(lastEventId) ? Number.parseInt(lastEventId, 10) : 0;

    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });

    const send = (event: { seq: number } & Record<string, unknown>): void => {
      reply.raw.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    for (const event of await sessions.readEvents(reqId, afterSeq)) send(event);

    const unsubscribe = session.events.subscribe((event) => send({ ...event }));
    const heartbeat = setInterval(() => reply.raw.write(`: heartbeat\n\n`), SSE_HEARTBEAT_MS);
    req.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
      reply.raw.end();
    });
  });

  // ---- SDLC -----------------------------------------------------------------
  app.get("/api/v1/sdlcs", async (req) => ({
    request_id: requestId(req),
    sdlcs: await sdlcs.list(),
  }));

  app.get("/api/v1/sdlcs/:sdlc_id/versions/:version", async (req) => {
    const { sdlc_id: sdlcId, version } = req.params as { sdlc_id: string; version: string };
    const parsed = Number.parseInt(version, 10);
    if (!Number.isInteger(parsed)) throw badRequest(`version 必须是整数：${version}`);
    const versioned = await sdlcs.get(sdlcId, parsed);
    return {
      request_id: requestId(req),
      sdlc_id: sdlcId,
      version: versioned.version,
      content_hash: versioned.content_hash,
      published_at: versioned.published_at,
      yaml: versioned.yaml,
    };
  });

  app.post("/api/v1/sdlcs/:sdlc_id/versions/validate", async (req) => {
    const input = parseOrThrow(ValidateSdlcInputSchema, req.body);
    return { request_id: requestId(req), validation: sdlcs.validate(input.yaml) };
  });

  app.post(
    "/api/v1/sdlcs/:sdlc_id/versions/publish",
    { config: { idempotency: true } },
    async (req, reply) => {
      const { sdlc_id: sdlcId } = req.params as { sdlc_id: string };
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(sdlcId)) {
        throw badRequest(`非法的 sdlc_id：${sdlcId}（小写字母数字与 -）`);
      }
      const input = parseOrThrow(PublishSdlcInputSchema, req.body);
      const published = await sdlcs.publish(sdlcId, input.yaml);
      reply.code(201);
      return { request_id: requestId(req), sdlc_id: sdlcId, ...published };
    },
  );

  // ---- SDLC 草稿（工作副本，可校验不通过；发布成功后自动清除） -------------------------
  app.get("/api/v1/sdlcs/:sdlc_id/draft", async (req) => {
    const { sdlc_id: sdlcId } = req.params as { sdlc_id: string };
    return { request_id: requestId(req), sdlc_id: sdlcId, draft: await sdlcs.getDraft(sdlcId) };
  });

  app.put("/api/v1/sdlcs/:sdlc_id/draft", { config: { idempotency: true } }, async (req) => {
    const { sdlc_id: sdlcId } = req.params as { sdlc_id: string };
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(sdlcId)) {
      throw badRequest(`非法的 sdlc_id：${sdlcId}（小写字母数字与 -）`);
    }
    const input = parseOrThrow(SaveDraftInputSchema, req.body);
    const validation = await sdlcs.saveDraft(sdlcId, input.yaml);
    return { request_id: requestId(req), sdlc_id: sdlcId, saved: true, validation };
  });

  app.delete("/api/v1/sdlcs/:sdlc_id/draft", { config: { idempotency: true } }, async (req) => {
    const { sdlc_id: sdlcId } = req.params as { sdlc_id: string };
    await sdlcs.deleteDraft(sdlcId);
    return { request_id: requestId(req), sdlc_id: sdlcId, deleted: true };
  });

  // ---- SDLC 版本归档（登记于索引；归档版本禁止启动新 run） ------------------------------
  app.post(
    "/api/v1/sdlcs/:sdlc_id/versions/:version/archive",
    { config: { idempotency: true } },
    async (req) => {
      const { sdlc_id: sdlcId, version } = req.params as { sdlc_id: string; version: string };
      const parsed = Number.parseInt(version, 10);
      if (!Number.isInteger(parsed)) throw badRequest(`version 必须是整数：${version}`);
      await sdlcs.archive(sdlcId, parsed);
      return { request_id: requestId(req), sdlc_id: sdlcId, version: parsed, status: "archived" };
    },
  );

  app.post(
    "/api/v1/sdlcs/:sdlc_id/versions/:version/unarchive",
    { config: { idempotency: true } },
    async (req) => {
      const { sdlc_id: sdlcId, version } = req.params as { sdlc_id: string; version: string };
      const parsed = Number.parseInt(version, 10);
      if (!Number.isInteger(parsed)) throw badRequest(`version 必须是整数：${version}`);
      await sdlcs.unarchive(sdlcId, parsed);
      return { request_id: requestId(req), sdlc_id: sdlcId, version: parsed, status: "published" };
    },
  );

  // ---- SDLC 模板库（ADR-0014 注意点 9：轻量/标准/严格/Agent 协作四档起点） --------------
  app.get("/api/v1/sdlc-templates", async (req) => ({
    request_id: requestId(req),
    templates: listSdlcTemplates(),
  }));

  // ---- 控制台静态托管（存在构建产物时） --------------------------------------
  const consoleDist =
    options.consoleDist ?? fileURLToPath(new URL("../../console/dist", import.meta.url));
  if (existsSync(consoleDist)) {
    await app.register(fastifyStatic, { root: consoleDist, index: ["index.html"] });
    app.setNotFoundHandler(async (req, reply) => {
      if (req.url.startsWith("/api/")) {
        await reply.code(404).send({ code: "not_found", message: `路由不存在：${req.url}`, details: null });
        return;
      }
      await reply.type("text/html; charset=utf-8").send(await readFile(path.join(consoleDist, "index.html"), "utf8"));
    });
  }

  return { app, sessions, sdlcs, runs, index, agents, coordination };
}
