/** 工作区 agent 配置快照（ADR-0027）：串行重载，成功才替换，在途 run 固定 resolver。 */
import { join } from "node:path";
import { createAgentRegistry, loadAgentsFile, type AgentDriver, type AgentRegistry } from "agent-cord";
import type { AgentCatalogView } from "../contracts.js";
import { badRequest } from "../errors.js";

export class AgentService {
  private registry: AgentRegistry = createAgentRegistry(null);
  private revision = 0;
  private warnings: string[] = [];
  private reload_queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly cord_root: string) {}

  catalog(): AgentCatalogView {
    return {
      revision: this.revision,
      agents: this.registry.list(),
      warnings: [...this.warnings],
      rejected: [...this.registry.rejected],
    };
  }

  /** 返回固定的配置快照闭包，重载不会修改已持有的 resolver。 */
  resolver(): (name: string) => AgentDriver {
    return this.registry.resolve;
  }

  reload(): Promise<AgentCatalogView> {
    const operation = this.reload_queue.then(async () => {
      try {
        const loaded = await loadAgentsFile(join(this.cord_root, "agents.yaml"));
        const registry = createAgentRegistry(loaded.yaml, loaded.rejected);
        this.registry = registry;
        this.warnings = loaded.warnings;
        this.revision += 1;
        return this.catalog();
      } catch (error) {
        throw badRequest(error instanceof Error ? error.message : "agent 配置重载失败");
      }
    });
    this.reload_queue = operation.catch(() => undefined);
    return operation;
  }
}
