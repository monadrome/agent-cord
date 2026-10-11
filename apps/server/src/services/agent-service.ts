/** 工作区 agent 配置快照（ADR-0027）：串行重载，成功才替换，在途 run 固定 resolver。 */
import { dirname, join } from "node:path";
import { AcpDriver, HeadlessDriver, createAgentRegistry, loadAgentsFile, read_worktree, assert_worktree, bind_worktree_driver, type LinkedWorktree, type AgentDriver, type AgentRegistry } from "agent-cord";
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
  private worktree: LinkedWorktree | null = null;
  private resolve_snapshot: (name: string) => AgentDriver = this.registry.resolve;

  constructor(private readonly cord_root: string) {}

  catalog(): AgentCatalogView {
    return {
      revision: this.revision,
      agents: this.registry.list().map((entry) => {
        const driver = this.resolve_snapshot(entry.name);
        return { ...entry, configuration_hash: driver.configuration_hash ?? null, ...(driver.capabilities === undefined ? {} : { capabilities: driver.capabilities }) };
      }),
      warnings: [...this.warnings],
      rejected: [...this.registry.rejected],
    };
  }

  /** 返回固定的配置快照闭包，重载不会修改已持有的 resolver。 */
  resolver(): (name: string) => AgentDriver {
    return this.resolve_snapshot;
  }

  async assert_workspace(): Promise<void> {
    if (this.worktree !== null) await assert_worktree(this.worktree, dirname(this.cord_root));
  }

  async inspect(name: string, timeout_ms = 5_000, readonly = false): Promise<AgentInspectionView> {
    if (this.closing) return Promise.reject(service_closing());
    if (!this.registry.list().some(entry => entry.name === name)) return Promise.reject(notFound("agent 不在当前可用清单"));
    const driver = this.registry.resolve(name); const bound = this.resolve_snapshot(name); const worktree = this.worktree; const revision = this.revision;
    if (readonly && !(driver instanceof AcpDriver) && !(driver instanceof HeadlessDriver && driver.capabilities.inspection === "cli_help")) throw badRequest("只读任务配置查询需要ACP或明确CLI帮助profile");
    const key = JSON.stringify([revision, bound.configuration_hash ?? bound.name, timeout_ms, readonly]);
    if (this.pending_inspection !== undefined) {
      if (this.pending_inspection.key !== key) return Promise.reject(conflict("已有不同配置、任务模式或超时的能力查询在进行，请稍后重试"));
      return this.pending_inspection.promise.then(result => structuredClone(result));
    }
    const controller = new AbortController();
    const operation = Promise.resolve().then(() => this.inspect_once(name, driver, bound, worktree, revision, timeout_ms, controller.signal, readonly)).finally(() => {
      if (this.pending_inspection?.controller === controller) this.pending_inspection = undefined;
    });
    this.pending_inspection = { key, controller, promise: operation };
    return operation.then(result => structuredClone(result));
  }

  private async inspect_once(name: string, driver: AgentDriver, bound: AgentDriver, worktree: LinkedWorktree | null, revision: number, timeout_ms: number, signal: AbortSignal, readonly: boolean): Promise<AgentInspectionView> {
    if (this.closing || signal.aborted) throw service_closing();
    const deadline = Date.now() + timeout_ms;
    const remaining = () => {
      if (worktree === null) return timeout_ms;
      const budget = deadline - Date.now();
      if (budget <= 0) throw badRequest("工作树能力查询整体超时");
      return budget;
    };
    if (worktree !== null) {
      try { await assert_worktree(worktree, dirname(this.cord_root), signal, remaining()); }
      catch { if (this.closing || signal.aborted) throw service_closing(); throw conflict("工作树身份不可验证，能力查询未派发"); }
    }
    let observation: AgentInspectionView["observation"] = null;
    let cli_observation: AgentInspectionView["cli_observation"] = null;
    if (driver instanceof AcpDriver) {
      try { observation = await driver.inspect(dirname(this.cord_root), remaining(), signal, readonly); }
      catch { if (this.closing || signal.aborted) throw service_closing(); throw badRequest("ACP 能力协商或启动配置核验失败"); }
    }
    if (driver instanceof HeadlessDriver) {
      try { cli_observation = await driver.inspect(dirname(this.cord_root), remaining(), signal, readonly); }
      catch (error) { if (this.closing || signal.aborted) throw service_closing(); throw error; }
    }
    if (this.closing || signal.aborted) throw service_closing();
    if (worktree !== null) {
      try { await assert_worktree(worktree, dirname(this.cord_root), signal, remaining()); }
      catch { if (this.closing || signal.aborted) throw service_closing(); throw conflict("查询期间工作树身份已变化，结果不可用"); }
    }
    const current_entry = this.registry.list().find(entry => entry.name === name);
    const current_hash = current_entry === undefined ? null : this.resolve_snapshot(name).configuration_hash ?? null;
    const configuration_hash = bound.configuration_hash ?? null;
    const current = revision === this.revision && configuration_hash !== null && current_hash === configuration_hash;
    return { revision, configuration_hash, current, capabilities: bound.capabilities ?? null, observation, cli_observation, ...(readonly ? { readonly: true } : {}) };
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
        const worktree = await read_worktree(dirname(this.cord_root));
        if (this.worktree !== null && (worktree === null || this.worktree.root !== worktree.root
          || this.worktree.git_directory !== worktree.git_directory || this.worktree.common_directory !== worktree.common_directory || this.worktree.identity_hash !== worktree.identity_hash)) {
          throw conflict("工作树身份已变化，不能用重载替换当前绑定，请恢复原工作树");
        }
        const drivers = new WeakMap<AgentDriver, AgentDriver>();
        const resolve_snapshot = (name: string) => {
          const driver = registry.resolve(name);
          let bound = drivers.get(driver);
          if (bound === undefined) { bound = bind_worktree_driver(driver, worktree); drivers.set(driver, bound); }
          return bound;
        };
        if (this.closing) throw service_closing();
        this.registry = registry;
        this.worktree = worktree;
        this.resolve_snapshot = resolve_snapshot;
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
