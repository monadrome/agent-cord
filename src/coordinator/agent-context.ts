/** 只读取流程声明Agent的公开定义，不spawn、探测或保存解析错误正文。 */
import type { AgentCapabilities, AgentDriver } from "../core/ports.js";
import { CoordinationAgentsSchema, type CoordinationAgents, type WorkflowDef } from "../core/schema.js";

/** 仅检查声明的CLI参数映射，不证明工具或OS隔离。 */
export function readonly_mapping_satisfied(node: WorkflowDef["spec"]["nodes"][number], capabilities: AgentCapabilities | null | undefined): boolean {
  return node.run?.require_readonly_mapping !== true || (node.run.readonly === true && capabilities?.transport === "headless" && capabilities.readonly_launch === "mapped");
}

export function workflow_agent_names(def: WorkflowDef): string[] {
  return [...new Set(def.spec.nodes.flatMap(node => node.run === undefined ? [] : [node.run.agent, ...(node.run.goal?.supervisor_agent === undefined ? [] : [node.run.goal.supervisor_agent])]))].sort();
}
export function validate_coordination_agents(def: WorkflowDef, value: unknown): CoordinationAgents {
  const parsed = CoordinationAgentsSchema.safeParse(value);
  if (!parsed.success) throw new Error("协调流程Agent上下文不符合契约");
  const names = workflow_agent_names(def);
  if (parsed.data.length !== names.length || parsed.data.some(agent => !names.includes(agent.agent))) throw new Error("协调Agent上下文必须完整覆盖流程声明");
  for (const agent of parsed.data) { agent.capabilities?.launch_options.sort(); agent.capabilities?.mcp_configuration?.transports.sort(); }
  return parsed.data.sort((a, b) => a.agent < b.agent ? -1 : a.agent > b.agent ? 1 : 0);
}
export function read_coordination_agents(def: WorkflowDef, resolver: (name: string) => AgentDriver): CoordinationAgents {
  const names = workflow_agent_names(def);
  if (names.length > 128) throw new Error("协调流程Agent上下文超过契约128项上限");
  const agents = names.map(agent => {
    let driver: AgentDriver;
    try { driver = resolver(agent); } catch { return { agent, resolution: "unavailable" as const, configuration_hash: null, capabilities: null }; }
    return { agent, resolution: "resolved" as const, configuration_hash: driver.configuration_hash ?? null, capabilities: driver.capabilities ?? null };
  });
  return validate_coordination_agents(def, agents);
}
