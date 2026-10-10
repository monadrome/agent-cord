/** 工作区 agent 配置快照（ADR-0027）：串行重载，成功才替换，在途 run 固定 resolver。 */
import { dirname, join } from "node:path";
import { AcpDriver, HeadlessDriver, createAgentRegistry, loadAgentsFile, type AgentDriver, type AgentRegistry } from "agent-cord";
import type { AgentCatalogView, AgentInspectionView } from "../contracts.js";
import { ApiError, badRequest, conflict, notFound } from "../errors.js";

interface PendingInspection {
  key: string;
  controller: AbortController;
  promise: Promise<AgentInspectionView>;
}
function service_closing(): ApiError { return new ApiError(503, "service_closing", "服务正在关闭，能力查询已取消"); }

export class AgentService {
  private registry: AgentRegistry = createAgentRegistry(null);
  private revision = 0;
  private warnings: string[] = [];
  private reload_queue: Promise<unknown> = Promise.resolve();
  private pending_inspection: PendingInspection | undefined;
  private closing = false;

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

  async inspect(name: string, timeout_ms = 5_000): Promise<AgentInspectionView> {
    if (this.closing) return Promise.reject(service_closing());
    if (!this.registry.list().some(entry => entry.name === name)) return Promise.reject(notFound("agent 不在当前可用清单"));
    const driver = this.registry.resolve(name); const revision = this.revision;
    const key = JSON.stringify([revision, driver.configuration_hash ?? driver.name, timeout_ms]);
    if (this.pending_inspection !== undefined) {
      if (this.pending_inspection.key !== key) return Promise.reject(conflict("已有不同配置或超时的能力查询在进行，请稍后重试"));
      return this.pending_inspection.promise.then(result => structuredClone(result));
    }
    const controller = new AbortController();
    const operation = Promise.resolve().then(() => this.inspect_once(name, driver, revision, timeout_ms, controller.signal)).finally(() => {
      if (this.pending_inspection?.controller === controller) this.pending_inspection = undefined;
    });
    this.pending_inspection = { key, controller, promise: operation };
    return operation.then(result => structuredClone(result));
  }

  private async inspect_once(name: string, driver: AgentDriver, revision: number, timeout_ms: number, signal: AbortSignal): Promise<AgentInspectionView> {
    if (this.closing || signal.aborted) throw service_closing();
    let observation: AgentInspectionView["observation"] = null;
    let cli_observation: AgentInspectionView["cli_observation"] = null;
    if (driver instanceof AcpDriver) {
      try { observation = await driver.inspect(dirname(this.cord_root), timeout_ms, signal); }
      catch { if (this.closing || signal.aborted) throw service_closing(); throw badRequest("ACP 能力协商或启动配置核验失败"); }
    }
    if (driver instanceof HeadlessDriver) {
      try { cli_observation = await driver.inspect(dirname(this.cord_root), timeout_ms, signal); }
      catch (error) { if (this.closing || signal.aborted) throw service_closing(); throw error; }
    }
    if (this.closing || signal.aborted) throw service_closing();
    const current_entry = this.registry.list().find(entry => entry.name === name);
    const current_hash = current_entry === undefined ? null : this.registry.resolve(name).configuration_hash ?? null;
    const configuration_hash = driver.configuration_hash ?? null;
    const current = revision === this.revision && configuration_hash !== null && current_hash === configuration_hash;
    return { revision, configuration_hash, current, capabilities: driver.capabilities ?? null, observation, cli_observation };
  }

  async close(): Promise<void> {
    this.closing = true;
    const pending = this.pending_inspection;
    pending?.controller.abort();
    await Promise.allSettled([pending?.promise, this.reload_queue]);
  }

  reload(): Promise<AgentCatalogView> {
    if (this.closing) return Promise.reject(service_closing());
    const operation = this.reload_queue.then(async () => {
      if (this.closing) throw service_closing();
      try {
        const loaded = await loadAgentsFile(join(this.cord_root, "agents.yaml"));
        const registry = createAgentRegistry(loaded.yaml, loaded.rejected);
        if (this.closing) throw service_closing();
        this.registry = registry;
        this.warnings = loaded.warnings;
        this.revision += 1;
        return this.catalog();
      } catch (error) {
        if (this.closing) throw service_closing();
        throw badRequest(error instanceof Error ? error.message : "agent 配置重载失败");
      }
    });
    this.reload_queue = operation.catch(() => undefined);
    return operation;
  }
}
