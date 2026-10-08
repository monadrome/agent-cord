/** 决策侧的事件完整性边界（ADR-0047），普通诊断浏览仍可使用 readOrdered。 */
import type { SessionHandle } from "./ports.js";
import { EventEnvelopeSchema, type EventEnvelope } from "./schema.js";

export class SessionEventReadError extends Error {
  constructor(message: string) { super(message); this.name = "SessionEventReadError"; }
}

export function assertSessionEvents(events: readonly EventEnvelope[], session_id: string): void {
  for (const event of events) {
    if (!EventEnvelopeSchema.safeParse(event).success) throw new SessionEventReadError("事件流包含不符合 envelope 契约的事实");
    if (event.session_id !== session_id) throw new SessionEventReadError("事件流包含其他 session 的事实");
  }
}

export async function readSessionEvents(session: SessionHandle): Promise<EventEnvelope[]> {
  const store = session.events;
  let events: EventEnvelope[];
  if (store.readOrderedStrict !== undefined) events = await store.readOrderedStrict();
  else {
    events = await store.readOrdered();
    const legacy = store as typeof store & { diagnostics?: () => { notes: Array<{ kind: string }> } };
    if (legacy.diagnostics?.().notes.some((note) => note.kind === "unparsable_line")) {
      throw new SessionEventReadError("事件流包含无法解析的事实，请修复后重新打开");
    }
  }
  assertSessionEvents(events, session.req_id);
  return events;
}
