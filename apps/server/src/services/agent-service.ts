/** 工作区 agent 配置快照（ADR-0027）：串行重载，成功才替换，在途 run 固定 resolver。 */
import { dirname, join } from "node:path";
import { AcpDriver, HeadlessDriver, createAgentRegistry, loadAgentsFile, type AgentDriver, type AgentRegistry } from "agent-cord";
import type { AgentCatalogView, AgentInspectionView } from "../contracts.js";
import { badRequest, notFound } from "../errors.js";

export class AgentService {
  private registry: AgentRegistry = createAgentRegistry(null);
  private revision = 0;
  private warnings: string[] = [];
  private reload_queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly cord_root: string) {}

  catalog(): AgentCatalogView {
    return {
      revision: this.revision,
      agents: this.registry.list().map((entry) => {
        const driver = this.registry.resolve(entry.name);
        return { ...entry, configuration_hash: driver.configuration_hash ?? null, ...(driver.capabilities === undefined ? {} : { capabilities: driver.capabilities }) };
      }),
      warnings: [...this.warnings],
      rejected: [...this.registry.rejected],
    };
  }

  /** 返回固定的配置快照闭包，重载不会修改已持有的 resolver。 */
  resolver(): (name: string) => AgentDriver {
    return this.registry.resolve;
  }

  async inspect(name: string, timeout_ms?: number): Promise<AgentInspectionView> {
    if (!this.registry.list().some(entry => entry.name === name)) throw notFound("agent 不在当前可用清单");
    const driver = this.registry.resolve(name); const revision = this.revision;
    let observation: AgentInspectionView["observation"] = null;
    let cli_observation: AgentInspectionView["cli_observation"] = null;
    if (driver instanceof AcpDriver) {
      try { observation = await driver.inspect(dirname(this.cord_root), timeout_ms); }
      catch { throw badRequest("ACP 能力协商或启动配置核验失败"); }
    }
    if (driver instanceof HeadlessDriver) cli_observation = await driver.inspect(dirname(this.cord_root), timeout_ms);
    const current_entry = this.registry.list().find(entry => entry.name === name);
    const current_hash = current_entry === undefined ? null : this.registry.resolve(name).configuration_hash ?? null;
    const configuration_hash = driver.configuration_hash ?? null;
    const current = revision === this.revision && configuration_hash !== null && current_hash === configuration_hash;
    return { revision, configuration_hash, current, capabilities: driver.capabilities ?? null, observation, cli_observation };
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
