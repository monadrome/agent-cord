import { describe, expect, it } from "vitest";
import { ulid } from "ulid";
import { createAgentRegistry, parseAgentsYaml, type AgentDriver, type WorkflowDef } from "../../src/index.js";
import { read_coordination_agents, validate_coordination_agents, workflow_agent_names } from "../../src/coordinator/agent-context.js";

const def = { spec: { nodes: [{ id: "first", run: { agent: "writer", goal: { supervisor_agent: "reviewer" } } }, { id: "second", run: { agent: "writer" } }] } } as WorkflowDef;
describe("流程Agent受限上下文", () => {
  it("唯一完整覆盖worker/supervisor，参数/角色/env/错误正文不进入上下文", () => {
    const registry = createAgentRegistry(parseAgentsYaml('agents: { writer: { kind: headless, template: claude, system_prompt: PRIVATE_ROLE, env: { PRIVATE_ENV: SECRET } } }').yaml);
    const result = read_coordination_agents(def, registry.resolve);
    expect(workflow_agent_names(def)).toEqual(["reviewer", "writer"]);
    expect(result[0]).toEqual({ agent: "reviewer", resolution: "unavailable", configuration_hash: null, capabilities: null });
    expect(result[1]).toMatchObject({ resolution: "resolved", configuration_hash: expect.stringMatching(/^[0-9a-f]{64}$/), capabilities: { transport: "headless", evidence: "adapter", installation: "unchecked" } });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_"); expect(JSON.stringify(result)).not.toContain("SECRET");
  });
  it.each(["missing", "duplicate", "foreign", "invalid_hash", "extra_field", "invalid_capability"])("%s 不能冒充完整宿主上下文", kind => {
    const result = read_coordination_agents(def, () => ({ name: "x", configuration_hash: "a".repeat(64) } as AgentDriver));
    if (kind === "missing") result.pop();
    if (kind === "duplicate") result.push(result[0]!);
    if (kind === "foreign") result[0]!.agent = "unknown";
    if (kind === "invalid_hash") result[0]!.configuration_hash = ulid();
    if (kind === "extra_field") Object.assign(result[0]!, { env: "PRIVATE_ENV" });
    if (kind === "invalid_capability") Object.assign(result[0]!, { capabilities: { transport: "pty" } });
    expect(() => validate_coordination_agents(def, result)).toThrow(/契约|完整/);
  });
  it("无执行体为空，超量拒绝；缺driver身份不虚构hash或能力", () => {
    const no_agents = { spec: { nodes: [] } } as unknown as WorkflowDef;
    expect(read_coordination_agents(no_agents, () => { throw new Error("不能调用"); })).toEqual([]);
    const result = read_coordination_agents(def, () => ({ name: "x" } as AgentDriver));
    expect(result[0]).toMatchObject({ resolution: "resolved", configuration_hash: null, capabilities: null });
    const large = { spec: { nodes: Array.from({ length: 129 }, (_, index) => ({ run: { agent: "a" + index } })) } } as unknown as WorkflowDef;
    expect(() => read_coordination_agents(large, () => { throw new Error("PRIVATE_ERROR"); })).toThrow(/契约/);
  });
});
