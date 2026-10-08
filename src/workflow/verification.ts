/** 验证证据的共享读取/解析边界（ADR-0045），不跳过损坏事实。 */
import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { orderEvents } from "../core/hash.js";
import { assertSessionEvents, readSessionEvents } from "../core/session-events.js";
import type { SessionHandle } from "../core/ports.js";
import { EventEnvelopeSchema, VerificationCompletedPayloadSchema, type EventEnvelope, type WorkflowScope } from "../core/schema.js";
import { matchesWorkflowScope } from "./scope.js";

export async function readVerificationEvents(session_dir: string, session?: SessionHandle): Promise<EventEnvelope[]> {
  if (session !== undefined) return readSessionEvents(session);
  const text = await readFile(join(session_dir, "events.jsonl"), "utf8");
  let events: EventEnvelope[] = [];
  for (const [index, line] of text.split("\n").entries()) {
    if (line.trim().length === 0) continue;
    try { events.push(EventEnvelopeSchema.parse(JSON.parse(line))); }
    catch { throw new Error(`验证事件流第 ${index + 1} 行不符合事件契约`); }
  }
  events = orderEvents(events);
  assertSessionEvents(events, basename(resolve(session_dir)));
  return events;
}

/** 在选定最新事实后调用，非法 payload/correlation 返回 null，不能回退旧通过。 */
export function parseVerificationResult(event: EventEnvelope, node_id: string, within_node = true) {
  if (event.type !== "verification.completed" || (within_node && event.correlation_id !== node_id)) return null;
  const parsed = VerificationCompletedPayloadSchema.safeParse(event.payload);
  return parsed.success && parsed.data.node_id === node_id ? parsed.data : null;
}

export function isVerificationRunCancelled(events: readonly EventEnvelope[], scope: WorkflowScope & { run_id: string }): boolean {
  return events.some((event) => event.type === "workflow.run.cancelled" && matchesWorkflowScope(event.payload, scope)
    && event.payload["run_id"] === scope.run_id);
}
