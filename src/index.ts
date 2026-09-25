/**
 * agent-cord 库导出入口（ADR-0016：CLI / daemon / 库导出是同一核心的三种暴露形式）。
 * 契约以 core/schema.ts 与 core/ports.ts 为唯一权威；各模块的公共 API 在此汇总。
 */
export * from "./core/index.js";
export * from "./workflow/index.js";
export * from "./voting/index.js";
export * from "./driver/index.js";

export { CORD_DIR, main, runDemo, runDoctor, runEvents, runInit, runNew } from "./cli.js";
export {
  CliHumanGate,
  buildCliMessageDraft,
  buildEventDraft,
  buildHumanDecisionDraft,
  normalizeCliInput,
  type CliChoiceRecord,
  type CliNormalizedInput,
} from "./adapters/cli.js";
