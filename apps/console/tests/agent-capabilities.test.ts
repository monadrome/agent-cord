import { describe, expect, it } from "vitest";
import type { AgentCatalogView, AgentInspectionView } from "@agent-cord/server/contracts";
import { inspection_matches_catalog, launch_option_text } from "../src/agent-capabilities.js";

const catalog: AgentCatalogView = { revision: 3, warnings: [], rejected: [], agents: [
  { name: "worker", kind: "acp", source: "workspace", template: null, configuration_hash: "a".repeat(64) },
] };
const inspection: AgentInspectionView = { revision: 3, configuration_hash: "a".repeat(64), current: true, capabilities: null, observation: null };

describe("能力查询公开身份核对", () => {
  it("未知启动选项原样展示，不误用对象继承属性", () => {
    expect(launch_option_text("effort")).toBe("推理强度");
    expect(launch_option_text("vendor-option")).toBe("vendor-option");
    expect(launch_option_text("constructor")).toBe("constructor");
  });
  it("只有本次已核验且仍存在的同 revision/hash 别名可显示当前结果", () => {
    expect(inspection_matches_catalog(catalog, "worker", inspection)).toBe(true);
    expect(inspection_matches_catalog(catalog, "other", inspection)).toBe(false);
  });
  it.each(["revision", "hash", "missing_hash", "removed", "server_stale", "old_server"])("%s 不将旧查询视为当前", mode => {
    const next = structuredClone(catalog); const result = structuredClone(inspection);
    if (mode === "revision") next.revision += 1;
    if (mode === "hash") next.agents[0]!.configuration_hash = "b".repeat(64);
    if (mode === "missing_hash") { next.agents[0]!.configuration_hash = null; result.configuration_hash = null; }
    if (mode === "removed") next.agents = [];
    if (mode === "server_stale") result.current = false;
    if (mode === "old_server") delete (result as Partial<AgentInspectionView>).current;
    expect(inspection_matches_catalog(next, "worker", result)).toBe(false);
  });
});
