/**
 * voting：盲评投票执行器（ADR-0006 / ADR-0013 / docs/05）。
 * 对外只暴露平台自有类型（schema.ts / ports.ts），provider SDK 类型不出模块。
 */
export { anchorOverlap, normalizeAnchor } from "./jaccard.js";
export type { AnchorOverlap } from "./jaccard.js";

export { MockProvider, mockFailure, mockReply } from "./provider/mock.js";
export type { MockOkSpec, MockProviderOptions, MockStep, MockUsage } from "./provider/mock.js";

export { AiSdkProvider } from "./provider/ai-sdk.js";

export {
  ABSTAIN_OPTION,
  VERDICT_RESPONSE_SCHEMA,
  VerdictPayloadSchema,
  buildSystemPrompt,
  buildUserPrompt,
  canonicalOptions,
  createVoteExecutor,
  hashPrompt,
} from "./executor.js";
export type {
  BallotAudit,
  BallotStatus,
  VerdictPayload,
  VoteExecutorOptions,
} from "./executor.js";
