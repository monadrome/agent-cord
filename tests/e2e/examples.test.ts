/** 用户可复用示例由真实结构化解析器校验，不调用外部模型。 */
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseAgentsYaml, createAgentRegistry } from "../../src/driver/agents-yaml.js";
import { parseWorkflow } from "../../src/workflow/loader.js";
import { topologicalOrder } from "../../src/workflow/executor.js";
import { createBuiltinRegistry, findUnknownCheckers } from "../../src/workflow/checkers.js";

describe("Agent 接入示例", () => {
  it("Codex / Claude 角色 / ACP 配置可解析，流程 agent/checker 都可解析且保留人工 gate", async () => {
    const loaded = parseAgentsYaml(await readFile(new URL("../../examples/agents.yaml", import.meta.url), "utf8"));
    const registry = createAgentRegistry(loaded.yaml);
    expect(loaded.warnings).toEqual([]); expect(registry.warnings).toEqual([]); expect(registry.rejected).toEqual([]);
    expect(registry.resolve("context-coordinator").name).toBe("headless:context-coordinator");
    expect(registry.resolve("claude-architect").name).toBe("headless:claude-architect");
    const claude = loaded.yaml.agents["claude-architect"]!;
    expect(claude.kind).toBe("headless");
    if (claude.kind !== "headless") throw new Error("示例应使用 Claude headless 角色封装");
    const roles = JSON.parse(claude.agents_json!);
    expect(roles[claude.agent!]).toMatchObject({ tools: ["Read", "Grep", "Glob"], model: "inherit" });
    expect(registry.resolve("kimi-acp").name).toBe("acp:kimi-acp");
    const def = parseWorkflow(await readFile(new URL("../../examples/agent-sdlc.yaml", import.meta.url), "utf8"));
    expect(topologicalOrder(def)).toEqual(["intake", "plan", "done"]);
    expect(findUnknownCheckers(def, createBuiltinRegistry())).toEqual([]);
    for (const node of def.spec.nodes) if (node.run !== undefined) expect(registry.resolve(node.run.agent).configuration_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(def.spec.nodes.flatMap((node) => node.gates).some((gate) => gate.pass.human_confirm)).toBe(true);
  });
  it("开发示例包含可写实现、只读文本评审和人工终审，驱动与 gate 均可解析", async () => {
    const registry = createAgentRegistry(parseAgentsYaml(await readFile(new URL("../../examples/agents.yaml", import.meta.url), "utf8")).yaml);
    const def = parseWorkflow(await readFile(new URL("../../examples/development-sdlc.yaml", import.meta.url), "utf8"));
    expect(topologicalOrder(def)).toEqual(["intake", "plan", "implement", "verify", "done"]);
    expect(findUnknownCheckers(def, createBuiltinRegistry())).toEqual([]);
    expect(def.spec.nodes.find((node) => node.id === "verify")?.run).toMatchObject({ readonly: true, output: "text" });
    expect(def.spec.nodes.find((node) => node.id === "implement")?.run?.readonly).toBe(false);
    for (const node of def.spec.nodes) if (node.run !== undefined) expect(registry.resolve(node.run.agent).configuration_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(def.spec.nodes.find((node) => node.id === "verify")?.gates.some((gate) => gate.pass.human_confirm)).toBe(true);
  });
  it("机器验证示例引用结构化 verification checker 并保留人工 intake gate", async () => {
    const def = parseWorkflow(await readFile(new URL("../../examples/machine-verification-sdlc.yaml", import.meta.url), "utf8"));
    expect(topologicalOrder(def)).toEqual(["intake", "verify"]);
    expect(findUnknownCheckers(def, createBuiltinRegistry())).toEqual([]);
    expect(def.spec.nodes.find((node) => node.id === "verify")?.gates[0]?.checks[0]).toMatchObject({
      ref: "verification-passed",
      with: { verification_id: "unit-tests" },
    });
    expect(def.spec.nodes.find((node) => node.id === "intake")?.gates[0]?.pass.human_confirm).toBe(true);
  });
});
