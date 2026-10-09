/**
 * HTTP API 装配（ADR-0021）：Fastify 实例 + 路由 + 幂等键钩子 + SSE + 控制台静态托管。
 * 路由只做薄编排：参数校验 → 调 service → 统一响应/错误形状；状态变更全部经 service 落事件流。
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { ulid } from "ulid";
import { runDoctor, runInit, type WorkflowDef } from "agent-cord";
import {
  CreateRequirementInputSchema,
  DecideApprovalInputSchema,
  PublishSdlcInputSchema,
  SaveDraftInputSchema,
  SNAPSHOT_DOC_NAMES,
  StartRunInputSchema,
  RecordVerificationInputSchema,
  StartCoordinationInputSchema,
  AdoptCoordinationInputSchema,
  AnswerCoordinationInputSchema,
  RevokeCoordinationAnswerInputSchema,
  RetryGoalInputSchema,
  RecoverGoalInputSchema,
  UpdateDocInputSchema,
  ReadArtifactInputSchema,
  ValidateSdlcInputSchema,
  type DashboardView,
  type RequirementStatus,
  type SnapshotDocName,
  type VerificationContextView,
} from "./contracts.js";
import { ApiError, badRequest, conflict, notFound, parseOrThrow } from "./errors.js";
import { IndexStore } from "./services/index-store.js";
import { DEFAULT_SDLC_ID, SdlcService } from "./services/sdlc-service.js";
import { listSdlcTemplates } from "./services/sdlc-templates.js";
import { RunService } from "./services/run-service.js";
import { SessionService, toLedgerView } from "./services/session-service.js";
import { AgentService } from "./services/agent-service.js";
import { CoordinationService } from "./services/coordination-service.js";
import { installIdempotency } from "./services/idempotency.js";
import { VerificationInputError } from "./services/verification-inputs.js";

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
  runs.setGoalBlockedHandler(async (context) => {
    try { await coordination.escalateGoalBlocker(context); }
    catch (error) { app.log.error(error); }
  });

  await runInit(root);
  await sdlcs.ensureDefaults();
  await coordination.recover();
  app.addHook("onClose", async () => {
    await runs.close();
    await coordination.close();
  });
  const resumed = await runs.recover();
  await coordination.recoverGoalBlockers();
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

  installIdempotency(app, index);

  // ---- 辅助：需求绑定的工作流定义（用于完成态/时间线投影） -------------------
  const defFor = async (reqId: string): Promise<{ def: WorkflowDef; workflow_revision: string } | null> => {
    const latest = await runs.latestRun(reqId);
    try {
      const versioned = await sdlcs.get(latest?.sdlc_id ?? DEFAULT_SDLC_ID, latest?.sdlc_version);
      return { def: versioned.def, workflow_revision: versioned.workflow_revision };
    } catch {
      return null;
    }
  };

  const verificationContext = async (reqId: string, runId: string, nodeId: string): Promise<VerificationContextView> => {
    const run = await runs.getRun(runId);
    if (run.req_id !== reqId) throw notFound(`run ${runId} 不属于需求 ${reqId}`);
    if (run.status !== "running" && run.status !== "waiting_human") {
      throw conflict(`run ${runId} 当前状态为 ${run.status}，不能获取机器验证上下文`);
    }
    const versioned = await sdlcs.get(run.sdlc_id, run.sdlc_version);
    const node = versioned.def.spec.nodes.find((item) => item.id === nodeId);
    if (node === undefined) throw notFound(`workflow 中不存在节点 ${nodeId}`);
    let configuration_hash: string | null = null;
    if (node.run !== undefined) {
      try {
        configuration_hash = runs.configurationHashFor(reqId, node.run.agent);
      } catch (error) {
        throw conflict(`无法解析节点 ${nodeId} 的 agent 配置：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const session = await sessions.open(reqId);
    let identity;
    try {
      identity = await runs.readNodeInput(versioned.def, node, session, configuration_hash, versioned.workflow_revision);
    } catch (error) {
      if (error instanceof VerificationInputError) throw conflict(error.message);
      throw error;
    }
    return {
      run_id: runId,
      req_id: reqId,
      workflow_id: versioned.def.metadata.id,
      workflow_revision: versioned.workflow_revision,
      node_id: nodeId,
      ...identity,
    };
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
  app.post("/api/v1/agents/reload", { config: { idempotency: true } }, async (req) => ({ request_id: requestId(req), ...await agents.reload() }));

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
      const binding = await defFor(reqId);
      const summary = await sessions.summarize(reqId, runs.isActive(reqId), binding?.def ?? null, binding?.workflow_revision);
      byStatus[summary.status] += 1;
      if (binding !== null) approvals.push(...(await sessions.listApprovals(reqId, { workflow_id: binding.def.metadata.id, workflow_revision: binding.workflow_revision })));
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
      const binding = await defFor(reqId);
      out.push(await sessions.summarize(reqId, runs.isActive(reqId), binding?.def ?? null, binding?.workflow_revision));
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
    const binding = await defFor(reqId);
    const detail = await sessions.detail(reqId, runs.isActive(reqId), binding?.def ?? null, binding?.workflow_revision);
    detail.active_run = runs.activeRunId(reqId) !== null ? await runs.getRun(runs.activeRunId(reqId) ?? "") : null;
    const latest = await runs.latestRun(reqId);
    detail.goal_recovery = latest?.goal_retry_round_id != null ? await runs.goalRecovery(latest.run_id) : null;
    return { request_id: requestId(req), requirement: detail };
  });

  app.get("/api/v1/requirements/:req_id/ledger", async (req) => {
    const { req_id: reqId } = req.params as { req_id: string };
    const ledger = await sessions.readLedger(reqId);
    return { request_id: requestId(req), projection_version: ledger.output_hash, ledger: toLedgerView(ledger) };
  });

  app.get("/api/v1/requirements/:req_id/timeline", async (req) => {
    const { req_id: reqId } = req.params as { req_id: string };
    const binding = await defFor(reqId);
    const nodes = await sessions.timeline(reqId, binding?.def ?? null, binding?.workflow_revision);
    const latest = await runs.latestRun(reqId);
    return {
      request_id: requestId(req),
      timeline: {
        req_id: reqId,
        sdlc_id: latest?.sdlc_id ?? binding?.def.metadata.id ?? DEFAULT_SDLC_ID,
        sdlc_version: latest?.sdlc_version ?? null,
        run: latest !== null ? await runs.getRun(latest.run_id) : null,
        nodes,
      },
    };
  });

  app.get("/api/v1/requirements/:req_id/approvals", async (req) => {
    const { req_id: reqId } = req.params as { req_id: string };
    const binding = await defFor(reqId);
    return { request_id: requestId(req), approvals: binding === null ? [] : await sessions.listApprovals(reqId, { workflow_id: binding.def.metadata.id, workflow_revision: binding.workflow_revision }) };
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
  app.post("/api/v1/requirements/:req_id/coordination", { config: { idempotency: true } }, async (req, reply) => {
    const { req_id } = req.params as { req_id: string };
    const input = parseOrThrow(StartCoordinationInputSchema, req.body);
    const round = await coordination.start(req_id, input);
    reply.code(202);
    return { request_id: requestId(req), round };
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
  app.post("/api/v1/requirements/:req_id/coordination/:round_id/retry-goal", { config: { idempotency: true } }, async (req, reply) => {
    const { req_id, round_id } = req.params as { req_id: string; round_id: string };
    const input = parseOrThrow(RetryGoalInputSchema, req.body);
    const run = await coordination.retry_goal(req_id, round_id, input);
    reply.code(202);
    return { request_id: requestId(req), run };
  });
  app.post("/api/v1/requirements/:req_id/coordination/:round_id/answer", { config: { idempotency: true } }, async (req) => {
    const { req_id, round_id } = req.params as { req_id: string; round_id: string };
    const input = parseOrThrow(AnswerCoordinationInputSchema, req.body);
    return { request_id: requestId(req), round: await coordination.answer(req_id, round_id, input) };
  });
  app.post("/api/v1/requirements/:req_id/coordination/:round_id/answer/revoke", { config: { idempotency: true } }, async (req) => {
    const { req_id, round_id } = req.params as { req_id: string; round_id: string };
    const input = parseOrThrow(RevokeCoordinationAnswerInputSchema, req.body);
    return { request_id: requestId(req), round: await coordination.revoke_answer(req_id, round_id, input) };
  });

  app.get("/api/v1/runs/:run_id", async (req) => {
    const { run_id: runId } = req.params as { run_id: string };
    return { request_id: requestId(req), run: await runs.getRun(runId) };
  });

  app.get("/api/v1/runs/:run_id/goal-recovery", async req => {
    const { run_id } = req.params as { run_id: string };
    return { request_id: requestId(req), recovery: await runs.goalRecovery(run_id) };
  });
  app.post("/api/v1/runs/:run_id/goal-recovery", { config: { idempotency: true } }, async (req, reply) => {
    const { run_id } = req.params as { run_id: string };
    const input = parseOrThrow(RecoverGoalInputSchema, req.body);
    const run = await runs.recoverGoal(run_id, input.input_hash);
    reply.code(202);
    return { request_id: requestId(req), run };
  });

  // ---- 机器验证事实（ADR-0040） -------------------------------------------
  app.get("/api/v1/requirements/:req_id/runs/:run_id/nodes/:node_id/verification-context", async (req) => {
    const { req_id: reqId, run_id: runId, node_id: nodeId } = req.params as { req_id: string; run_id: string; node_id: string };
    return { request_id: requestId(req), verification: await verificationContext(reqId, runId, nodeId) };
  });
  app.post("/api/v1/requirements/:req_id/runs/:run_id/verifications", { config: { idempotency: true } }, async (req) => {
    const { req_id: reqId, run_id: runId } = req.params as { req_id: string; run_id: string };
    const input = parseOrThrow(RecordVerificationInputSchema, req.body);
    if (input.run_id !== runId) throw badRequest("请求体 run_id 必须与路径一致");
    const context = await verificationContext(reqId, runId, input.node_id);
    if (input.input_hash !== context.input_hash) {
      throw conflict("机器验证输入已变化，请重新获取 verification-context 后重跑");
    }
    const event = await sessions.recordVerification(reqId, {
      ...input,
      ...(context.source_hash === null ? {} : { source_hash: context.source_hash }),
      workflow_id: context.workflow_id,
      workflow_revision: context.workflow_revision,
    });
    await runs.recheck(runId, input.node_id, input.verification_id);
    return { request_id: requestId(req), event_id: event.event_id, verification: { ...input, source_hash: context.source_hash, workflow_id: context.workflow_id, workflow_revision: context.workflow_revision } };
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
  app.get("/api/v1/requirements/:req_id/artifacts", async req => {
    const { req_id } = req.params as { req_id: string };
    const { path: file } = parseOrThrow(ReadArtifactInputSchema, req.query);
    const binding = await defFor(req_id);
    return { request_id: requestId(req), path: file, content: await sessions.readArtifact(req_id, file, binding?.def ?? null) };
  });
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
