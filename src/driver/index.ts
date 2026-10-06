/**
 * driver：AgentDriver 实现（ADR-0011 每任务 subprocess；ADR-0017 ACP 优先 + 裸 headless 降级）。
 */
export {
  AsyncQueue,
  DEFAULT_KILL_GRACE_MS,
  DEFAULT_TASK_TIMEOUT_MS,
  HeadlessDriver,
  delay,
  errorEvent,
  extractSessionId,
  extractUsage,
  getHeadlessCliTemplate,
  killProcessTree,
  listHeadlessCliTemplates,
  parseHeadlessLine,
  registerHeadlessCliTemplate,
  resultEvent,
  terminateProcessTree,
  textEvent,
  toolUseEvent,
  trackProcess,
} from "./headless.js";
export type {
  AgentKnob,
  AgentUsage,
  DriverErrorKind,
  ErrorEventData,
  HeadlessArgInput,
  HeadlessCliTemplate,
  HeadlessDriverOptions,
  HeadlessKnobs,
  KillableProcess,
  ProcessLifecycle,
  ResultEventData,
  TextEventData,
  ToolUseEventData,
} from "./headless.js";

export { AcpDriver, DEFAULT_PERMISSION_TIMEOUT_MS, mapAcpUsage, mapSessionUpdate } from "./acp.js";
export type {
  AcpDriverOptions,
  PermissionContext,
  PermissionDecider,
  PermissionDecision,
} from "./acp.js";

export {
  detectAcpSupport,
  getKnownAgent,
  listKnownAgents,
  registerKnownAgent,
  resolveDriver,
} from "./registry.js";
export type { KnownAgent, ResolveDriverOptions } from "./registry.js";

export {
  loadAgentsFile,
  parseAgentsYaml,
  registerAgentsYaml,
  resolveWithAgentsYaml,
} from "./agents-yaml.js";
export type { AgentsLoadResult, AgentsYaml } from "./agents-yaml.js";
