/** 所有 REST 写命令共享请求身份、执行权与首次响应（ADR-0035）。 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { canonicalJson, sha256Hex } from "agent-cord";
import { ApiError, badRequest, conflict } from "../errors.js";
import type { IdempotencyIdentity, IndexStore, StoredIdempotency } from "./index-store.js";

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
interface ResponseSnapshot { status: number; body: string; content_type: string }
interface Operation {
  identity: IdempotencyIdentity;
  response: Promise<ResponseSnapshot>;
  resolve: (response: ResponseSnapshot) => void;
  finalized: boolean;
}

/** 规范化 JSON 输入；区分未提供 body 与显式 null，只存 hash。 */
export function requestInputHash(body: unknown): string {
  // 保留 JSON 的所有自有字段，包括 __proto__；不改变历史事件的规范化协议。
  const body_json = JSON.stringify(body, (_key, value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([first], [second]) => first < second ? -1 : first > second ? 1 : 0)) : value);
  return sha256Hex(canonicalJson({ domain: "cord.rest-input.v1", body_present: body !== undefined, body_json: body_json ?? null }));
}

function sameRequest(first: IdempotencyIdentity, second: IdempotencyIdentity): boolean {
  return first.method === second.method && first.path === second.path && first.input_hash === second.input_hash;
}

function completedResponse(hit: StoredIdempotency, identity: IdempotencyIdentity): ResponseSnapshot {
  if (hit.input_hash === null) throw new ApiError(409, "idempotency_legacy", "该幂等键没有请求身份记录，请核验历史结果并使用新键提交新操作");
  if (!sameRequest({ ...hit, input_hash: hit.input_hash }, identity)) throw conflict("同一 Idempotency-Key 不能用于不同的命令或输入");
  if (hit.state !== "completed") throw new ApiError(409, "idempotency_incomplete", "该请求的执行结果尚未确认，请查看实际状态；核验后使用新键提交新操作");
  if (hit.status < 200 || hit.status >= 300) throw new ApiError(409, "idempotency_incomplete", "该请求没有可验证的成功响应，请核验实际状态");
  return { status: hit.status, body: hit.response, content_type: hit.content_type ?? JSON_CONTENT_TYPE };
}

export function installIdempotency(app: FastifyInstance, index: IndexStore): void {
  const active = new Map<string, Operation>();
  const owners = new WeakMap<FastifyRequest, Operation>();

  app.addHook("preHandler", async (req, reply) => {
    if (!WRITE_METHODS.has(req.method) || !req.url.startsWith("/api/") ||
      (req.routeOptions.config as { idempotency?: boolean }).idempotency !== true) return;
    const key = req.headers["idempotency-key"];
    if (typeof key !== "string" || key.trim().length === 0 || key.trim().length > 200) throw badRequest("写命令必须携带 1-200 字符的 Idempotency-Key 头");
    const identity = { key: key.trim(), method: req.method, path: req.url, input_hash: requestInputHash(req.body) };
    const prior = active.get(identity.key);
    if (prior !== undefined) {
      if (!sameRequest(prior.identity, identity)) throw conflict("同一 Idempotency-Key 不能用于不同的命令或输入");
      const response = await prior.response;
      await reply.code(response.status).header("content-type", response.content_type).send(response.body);
      return;
    }
    const hit = index.getIdempotency(identity.key);
    if (hit !== null) {
      const response = completedResponse(hit, identity);
      await reply.code(response.status).header("content-type", response.content_type).send(response.body);
      return;
    }
    if (!index.reserveIdempotency(identity)) {
      const current = index.getIdempotency(identity.key);
      if (current === null) throw new Error("幂等请求占位失败");
      const response = completedResponse(current, identity);
      await reply.code(response.status).header("content-type", response.content_type).send(response.body);
      return;
    }
    let resolve!: Operation["resolve"];
    const response = new Promise<ResponseSnapshot>((done) => { resolve = done; });
    const operation = { identity, response, resolve, finalized: false };
    active.set(identity.key, operation);
    owners.set(req, operation);
  });

  app.addHook("onSend", async (req, reply, payload) => {
    const operation = owners.get(req);
    if (operation === undefined || operation.finalized) return payload;
    operation.finalized = true;
    const response: ResponseSnapshot = { status: reply.statusCode, body: "", content_type: JSON_CONTENT_TYPE };
    try {
      if (payload !== null && typeof payload !== "string" && !Buffer.isBuffer(payload)) throw new Error("幂等写命令不能缓存流式响应");
      response.body = payload === null ? "" : typeof payload === "string" ? payload : payload.toString("utf8");
      response.content_type = String(reply.getHeader("content-type") ?? JSON_CONTENT_TYPE);
      if (response.status >= 200 && response.status < 300) index.completeIdempotency({ ...operation.identity, status: response.status, response: response.body, content_type: response.content_type });
      else if (response.status >= 400 && response.status < 500) index.releaseIdempotency(operation.identity);
    } catch (error) {
      app.log.error(error);
      response.status = 500;
      response.content_type = JSON_CONTENT_TYPE;
      response.body = JSON.stringify({ request_id: String(req.id), code: "idempotency_unconfirmed", message: "无法持久化请求结果，请查看实际状态；同键请求不会重新执行", details: null });
      reply.code(response.status).header("content-type", response.content_type);
    }
    operation.resolve(response);
    if (active.get(operation.identity.key) === operation) active.delete(operation.identity.key);
    owners.delete(req);
    return response.body;
  });

  app.addHook("onResponse", async (req) => {
    const operation = owners.get(req);
    if (operation === undefined) return;
    if (!operation.finalized) {
      operation.finalized = true;
      operation.resolve({ status: 500, content_type: JSON_CONTENT_TYPE, body: JSON.stringify({ request_id: String(req.id), code: "idempotency_unconfirmed", message: "请求未产生可确认响应，请核验实际状态", details: null }) });
    }
    if (active.get(operation.identity.key) === operation) active.delete(operation.identity.key);
    owners.delete(req);
  });
}
