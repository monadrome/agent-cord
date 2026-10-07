/**
 * core 公共 API（事件协议 + reducer + session + doctor）。
 * 契约以 ./schema.ts 与 ./ports.ts 为唯一权威。
 */
export {
  ActorSchema,
  AgentTaskCompletedPayloadSchema,
  AgentTaskStartedPayloadSchema,
  AnchorSchema,
  CliMessageReceivedPayloadSchema,
  ConfidenceSourceSchema,
  CoordinationProposalSchema,
  CoordinationEvidenceSchema,
  CoordinationStatusSchema,
  CoordinatorRoundStartedPayloadSchema,
  CoordinatorRoundRequestedPayloadSchema,
  CoordinatorRoundCompletedPayloadSchema,
  CoordinatorRoundCancelRequestedPayloadSchema,
  CoordinatorRoundAdoptedPayloadSchema,
  EVENT_PAYLOAD_SCHEMAS,
  EventDraftSchema,
  EventEnvelopeSchema,
  EVENT_TYPES,
  GateResolvedPayloadSchema,
  GateWaitingPayloadSchema,
  GateInvalidatedPayloadSchema,
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
  WorkflowScopeSchema,
  WorkflowRunStartedPayloadSchema,
} from "./schema.js";
export type {
  Actor,
  Anchor,
  CoordinationProposal,
  CoordinationStatus,
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
  WorkflowScope,
} from "./schema.js";

export type {
  AgentDriver,
  AgentEvent,
  AgentTask,
  Checker,
  CheckerContext,
  CheckerRegistry,
  ContextSessionAgent,
  CoordinationInput,
  CoordinationResult,
  DoctorReport,
  EventStore,
  HumanGate,
  HumanGateAnswer,
  HumanGateContext,
  NodeRunContext,
  NodeRunner,
  NodeRunStatus,
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
  isPlaceholderDoc,
  openSession,
  EVENTS_FILE,
  LEDGER_FILE,
  SNAPSHOT_DOC_FILES,
} from "./session.js";
export { readSessionDocument, statSessionDocument, writeSessionDocument, SessionFileError, SessionFileConflictError } from "./session-files.js";
