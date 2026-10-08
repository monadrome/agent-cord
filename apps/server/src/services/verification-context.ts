/** ADR-0044：当前流程声明的验证观察；不读取日志或复制 gate 状态机。 */
import { CoordinationVerificationsSchema, VerificationCompletedPayloadSchema, matchesWorkflowScope,
  type CoordinationVerification, type EventEnvelope, type SessionHandle, type WorkflowDef } from "agent-cord";
import type { RunService } from "./run-service.js";

export async function readCoordinationVerifications(
  def: WorkflowDef,
  session: SessionHandle,
  workflow_revision: string | undefined,
  runs: RunService,
): Promise<CoordinationVerification[]> {
  const checks = new Map<string, { node: WorkflowDef["spec"]["nodes"][number]; verification_id: string }>();
  for (const node of def.spec.nodes) for (const gate of node.gates) for (const check of gate.checks) {
    if (check.ref !== "verification-passed") continue;
    const id = check.with?.["verification_id"];
    if (typeof id !== "string" || id.length === 0 || id.length > 200) throw new Error("声明的机器验证 ID 不符合契约");
    checks.set(JSON.stringify([node.id, id]), { node, verification_id: id });
  }
  if (checks.size === 0) return [];
  if (checks.size > 128) throw new Error("协调机器验证观察超过 128 项上限");
  const scope = { workflow_id: def.metadata.id, workflow_revision };
  const latest_run = await runs.latestRun(session.req_id);
  const run = latest_run !== null && latest_run.workflow_revision === workflow_revision ? latest_run : null;
  const events = await session.events.readOrdered();
  if (events.some((event) => event.session_id !== session.req_id)) throw new Error("验证上下文包含其他需求的事实");
  const store = session.events as typeof session.events & { diagnostics?: () => { notes: Array<{ kind: string }> } };
  if (store.diagnostics?.().notes.some((note) => note.kind === "unparsable_line")) throw new Error("验证事件流包含无法解析的事实");
  const cancelled = run !== null && (run.status === "cancelled" || events.some((event) => event.type === "workflow.run.cancelled"
    && matchesWorkflowScope(event.payload, scope) && event.payload["run_id"] === run.run_id));
  const latest_results = new Map<string, EventEnvelope>();
  if (run !== null) for (const event of events) {
    if (event.type !== "verification.completed" || !matchesWorkflowScope(event.payload, scope) || event.payload["run_id"] !== run.run_id) continue;
    const key = JSON.stringify([event.payload["node_id"], event.payload["verification_id"]]);
    if (checks.has(key)) latest_results.set(key, event);
  }
  const results: CoordinationVerification[] = [];
  const identities = new Map<string, string | null>();
  for (const [key, { node, verification_id }] of [...checks].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const observation: CoordinationVerification = {
      run_id: run?.run_id ?? null, node_id: node.id, verification_id, event_id: null,
      status: "missing", current: false, reason: "missing", input_hash: null, command_hash: null, source_hash: null, exit_code: null,
    };
    const candidate = latest_results.get(key);
    if (candidate !== undefined) {
      const parsed = VerificationCompletedPayloadSchema.safeParse(candidate.payload);
      observation.event_id = candidate.event_id;
      if (!parsed.success || candidate.correlation_id !== node.id || (parsed.success && (
        ![parsed.data.input_hash, parsed.data.command_hash, ...(parsed.data.source_hash === undefined ? [] : [parsed.data.source_hash])].every((hash) => /^[0-9a-f]{64}$/.test(hash))
        || (parsed.data.status === "passed" && parsed.data.exit_code != null && parsed.data.exit_code !== 0)
      ))) {
        observation.status = "invalid";
        observation.reason = "invalid_result";
      } else {
        const value = parsed.data;
        Object.assign(observation, { status: value.status, input_hash: value.input_hash, command_hash: value.command_hash,
          source_hash: value.source_hash ?? null, exit_code: value.exit_code ?? null });
        if (cancelled) observation.reason = "run_cancelled";
        else {
          if (!identities.has(node.id)) {
            try {
              const config = node.run === undefined ? null : runs.configurationHashFor(session.req_id, node.run.agent);
              const identity = await runs.readNodeInput(def, node, session, config, workflow_revision);
              identities.set(node.id, identity.input_hash);
            } catch { identities.set(node.id, null); }
          }
          const current_hash = identities.get(node.id);
          observation.current = current_hash == null ? null : current_hash === value.input_hash;
          observation.reason = observation.current === null ? "unavailable" : observation.current ? "current" : "stale_input";
        }
      }
    }
    results.push(observation);
  }
  return CoordinationVerificationsSchema.parse(results);
}
