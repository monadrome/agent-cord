/**
 * core 公共 API（事件协议 + reducer + session + doctor）。
 * 契约以 ./schema.ts 与 ./ports.ts 为唯一权威。
 */
export {
  ActorSchema,
  AnchorSchema,
  CliMessageReceivedPayloadSchema,
  ConfidenceSourceSchema,
  EVENT_PAYLOAD_SCHEMAS,
  EventDraftSchema,
  EventEnvelopeSchema,
  EVENT_TYPES,
  GateResolvedPayloadSchema,
  GateWaitingPayloadSchema,
  HumanDecisionRecordedPayloadSchema,
  LedgerEntryAnchorDriftedPayloadSchema,
  LedgerEntryConfirmedPayloadSchema,
  LedgerEntryOverturnedPayloadSchema,
  LedgerEntryProposedPayloadSchema,
  LedgerEntrySchema,
  LedgerSchema,
  LedgerStatusSchema,
  ULID_RE,
  VoteCompletedPayloadSchema,
  WorkflowNodeEnteredPayloadSchema,
  WorkflowNodeExitedPayloadSchema,
} from "./schema.js";
export type {
  Actor,
  Anchor,
  EventDraft,
  EventEnvelope,
  EventType,
  GateAction,
  GateDef,
  GateResult,
  Ledger,
  LedgerEntry,
  LedgerStatus,
  VoteRecord,
  WorkflowDef,
} from "./schema.js";

export type {
  Checker,
  CheckerContext,
  CheckerRegistry,
  DoctorReport,
  EventStore,
  HumanGate,
  NormalizedEvent,
  Reducer,
  SessionHandle,
  WorkflowExecutor,
} from "./ports.js";

export {
  canonicalJson,
  canonicalize,
  hashChain,
  hashEvent,
  orderEvents,
  sha256Hex,
  HASH_ALGORITHM,
} from "./hash.js";

export { JsonlEventStore } from "./store.js";
export type {
  EventStoreDiagnostics,
  EventStoreNote,
  EventStoreNoteKind,
  JsonlEventStoreOptions,
} from "./store.js";

export { createReducer, reduceEvents, REDUCER_VERSION } from "./reducer.js";
export { runDoctor } from "./doctor.js";
export {
  initSession,
  openSession,
  EVENTS_FILE,
  LEDGER_FILE,
  SNAPSHOT_DOC_FILES,
} from "./session.js";
