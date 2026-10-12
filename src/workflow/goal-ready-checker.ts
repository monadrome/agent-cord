/** ADR-0099：Goal当前完整交付是门禁证据，不是模型或报告文件的自述。 */
import { canonicalJson, sha256Hex } from "../core/hash.js";
import { GoalAttemptCompletedPayloadSchema, GoalReadinessInputSchema, GoalReadyParamsSchema, type GateResult } from "../core/schema.js";
import type { Checker } from "../core/ports.js";
import { resolveGoalReadiness } from "../coordinator/goal-evidence.js";
import { node_ancestors } from "../coordinator/node-input.js";
import { readVerificationEvents } from "./verification.js";
import { matchesWorkflowScope } from "./scope.js";

function block(reason: string): GateResult { return { result: "block", anchors: [], confidence: 1, reason }; }

export function createGoalReadyChecker(): Checker {
  return { name: "goal-ready", async check(ctx) {
    const params = GoalReadyParamsSchema.safeParse(ctx.params ?? {});
    if (!params.success) return block("goal-ready需要唯一明确的Goal节点参数");
    if (ctx.workflow_id === undefined || ctx.node_id === undefined || ctx.run_id === undefined || ctx.read_goal_input === undefined) {
      return block("缺少当前流程/run/节点或宿主Goal输入能力，不能核验就绪");
    }
    const goal_id = params.data.node_id;
    const scope = { workflow_id: ctx.workflow_id, workflow_revision: ctx.workflow_revision, run_id: ctx.run_id };
    try {
      const events = await readVerificationEvents(ctx.session_dir, ctx.session);
      const candidate = events.filter(event => ["goal.attempt.started", "goal.attempt.completed"].includes(event.type)
        && matchesWorkflowScope(event.payload, scope) && event.payload["run_id"] === scope.run_id && event.payload["node_id"] === goal_id).at(-1);
      if (candidate === undefined) return block("当前run没有目标Goal就绪事实");
      const input = GoalReadinessInputSchema.parse(await ctx.read_goal_input(goal_id));
      const def = input.workflow; const consumer = def.spec.nodes.find(node => node.id === ctx.node_id);
      const goal = def.spec.nodes.find(node => node.id === goal_id);
      if (def.metadata.id !== ctx.workflow_id || input.workflow_revision !== ctx.workflow_revision || consumer === undefined || goal?.run?.goal === undefined
        || (goal.id !== consumer.id && !node_ancestors(def, consumer).has(goal.id))) return block("Goal必须来自同版本的自身或传递上游节点");
      // 输入读取后再次严格对账，最新started/结果替换/取消不能沿用旧ready。
      const current = await readVerificationEvents(ctx.session_dir, ctx.session);
      const proof = resolveGoalReadiness(candidate, current, goal, scope);
      if (proof === null) return block("最新Goal不是来源完整的ready，不能使用历史成功放行");
      const ready = GoalAttemptCompletedPayloadSchema.parse(current.find(event => event.event_id === candidate.event_id)?.payload);
      if (input.input_hash !== proof.input_hash || input.source_hash !== proof.source_hash || input.artifact_hash !== proof.artifact_hash) {
        return block("Goal需求、源码、配置或指南已变化，当前交付证据过期");
      }
      const evidence_hash = sha256Hex(canonicalJson({ domain: "cord.goal-ready-gate.v1", ready_event_id: candidate.event_id,
        completion_event_id: proof.completion.event_id, input_hash: proof.input_hash, source_hash: proof.source_hash, artifact_hash: proof.artifact_hash,
        verification_event_ids: ready.verification_event_ids }));
      return { result: "pass", anchors: [], confidence: 1, reason: `Goal ${goal_id}当前代码、自测与指南就绪；证据 ${evidence_hash}` };
    } catch { return block("无法验证Goal来源或当前输入，请修复后重新核验"); }
  } };
}
