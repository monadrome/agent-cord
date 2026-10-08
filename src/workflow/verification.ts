/** 验证证据的共享读取/解析边界（ADR-0045），不跳过损坏事实。 */
import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { orderEvents } from "../core/hash.js";
import type { SessionHandle } from "../core/ports.js";
import { EventEnvelopeSchema, VerificationCompletedPayloadSchema, type EventEnvelope, type WorkflowScope } from "../core/schema.js";
import { matchesWorkflowScope } from "./scope.js";

export async function readVerificationEvents(session_dir: string, session?: SessionHandle): Promise<EventEnvelope[]> {
  let events: EventEnvelope[];
  if (session !== undefined) {
    events = await session.events.readOrdered();
    const store = session.events as typeof session.events & { diagnostics?: () => { notes: Array<{ kind: string }> } };
    if (store.diagnostics?.().notes.some((note) => note.kind === "unparsable_line")) {
      throw new Error("验证事件流包含无法解析的事实，请先修复事件流");
    }
  } else {
    const text = await readFile(join(session_dir, "events.jsonl"), "utf8");
    events = [];
    for (const [index, line] of text.split("\n").entries()) {
      if (line.trim().length === 0) continue;
      try { events.push(EventEnvelopeSchema.parse(JSON.parse(line))); }
      catch { throw new Error(`验证事件流第 ${index + 1} 行不符合事件契约`); }
    }
    events = orderEvents(events);
  }
  const expected_session = session?.req_id ?? basename(resolve(session_dir));
  for (const event of events) {
    if (!EventEnvelopeSchema.safeParse(event).success) throw new Error("验证事件不符合 envelope 契约");
    if (event.session_id !== expected_session) throw new Error("验证事件流包含其他 session 的事实");
  }
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
