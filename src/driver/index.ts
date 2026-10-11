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
export { AcpPermissionPolicySchema } from "./acp-permissions.js";
export type { AcpPermissionPolicy, AcpPermissionPolicyInput } from "./acp-permissions.js";
export { AcpMcpServersSchema } from "./acp-mcp.js";
export type { AcpMcpServersInput, AcpMcpServers, AcpMcpTransportObservation } from "./acp-mcp.js";
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
  createAgentRegistry,
  loadAgentsFile,
  parseAgentsYaml,
  registerAgentsYaml,
  resolveWithAgentsYaml,
} from "./agents-yaml.js";
export type { AgentDefinitionInfo, AgentRegistry, AgentsLoadResult, AgentsYaml } from "./agents-yaml.js";
export { AgentLaunchSchema, validate_agent_launch } from "./launch.js";
export type { AgentLaunch } from "./launch.js";
export type { AcpCapabilityObservation } from "./acp-launch.js";
export type { HeadlessCapabilityObservation, HeadlessInspectionProfile } from "./headless-inspection.js";
