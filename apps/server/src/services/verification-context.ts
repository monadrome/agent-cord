/** ADR-0044：当前流程声明的验证观察；不读取日志或复制 gate 状态机。 */
import { CoordinationVerificationsSchema, matchesWorkflowScope, readVerificationEvents, parseVerificationResult, isVerificationRunCancelled,
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
  const events = await readVerificationEvents(session.dir, session);
  const cancelled = run !== null && (run.status === "cancelled" || isVerificationRunCancelled(events, { ...scope, run_id: run.run_id }));
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
      const value = parseVerificationResult(candidate, node.id);
      observation.event_id = candidate.event_id;
      if (value === null) {
        observation.status = "invalid";
        observation.reason = "invalid_result";
      } else {
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
