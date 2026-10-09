import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "ulid";
import { initSession, parseWorkflow, type SessionHandle } from "agent-cord";
import { readCoordinationExecutionContext } from "../src/services/execution-context.js";
import type { RunService } from "../src/services/run-service.js";

const def = parseWorkflow(`apiVersion: agent-cord.dev/v1alpha1
kind: Workflow
metadata: { id: goal-observation }
spec:
  nodes:
    - id: deliver
      artifact: review.md
      run:
        agent: worker
        goal:
          inputs: [src]
          max_attempts: 3
          checks: [{ id: tests, bin: node, args: [--test] }]
      gates: []
    - id: done
      depends_on: [deliver]
      gates: []
`);
let root: string;
let session: SessionHandle;
const run_id = ulid();
const revision = "a".repeat(64);
const runs = { latestRun: vi.fn(async () => ({ run_id, req_id: "REQ-GOAL-OBS", workflow_revision: revision, status: "failed" })), activeRunId: vi.fn(() => null) };

beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "cord-goal-context-")); session = await initSession(join(root, "cord"), "REQ-GOAL-OBS"); await writeFile(join(session.dir, "prd.md"), "# Goal\n"); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function append(type: "goal.attempt.started" | "goal.attempt.completed", payload: Record<string, unknown>) {
  return session.events.append({ event_id: ulid(), session_id: session.req_id, type, schema_version: "1", actor: { kind: "system", id: "goal-runner" }, correlation_id: "deliver", payload: { workflow_id: def.metadata.id, workflow_revision: revision, run_id, node_id: "deliver", ...payload }, source: { adapter: "goal-runner" } });
}

describe("协调 Goal 事件观察", () => {
  it("未带真实 worker/验证来源的 ready 为 invalid，不携带私有正文", async () => {
    const started = await append("goal.attempt.started", { attempt: 1 });
    const failed = await append("goal.attempt.completed", { attempt: 1, max_attempts: 3, status: "retrying", failure_kind: "verification", reason: "测试失败", progress_hash: "c".repeat(64), verification_event_ids: [], text: "PRIVATE" });
    const ready = await append("goal.attempt.completed", { attempt: 2, max_attempts: 3, status: "ready", reason: "就绪", completion_event_id: ulid(), input_hash: "a".repeat(64), source_hash: "b".repeat(64), artifact_hash: "c".repeat(64), verification_event_ids: [ulid()] });
    const result = await readCoordinationExecutionContext(def, session, revision, runs as unknown as RunService);
    expect(result.goals).toEqual([{ node_id: "deliver", run_id, event_id: ready.event_id, status: "invalid", current: false, freshness_reason: "invalid_evidence", attempt: 2, max_attempts: 3,
      failure_kind: null, reason: "就绪", input_hash: "a".repeat(64), source_hash: "b".repeat(64), artifact_hash: "c".repeat(64), verification_event_ids: expect.any(Array) }]);
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    expect(started.seq).toBeLessThan(failed.seq); expect(failed.seq).toBeLessThan(ready.seq);
  });

  it("最新 Goal 的错误 actor/correlation/预算/来源不回退旧阻塞", async () => {
    await append("goal.attempt.completed", { attempt: 1, max_attempts: 3, status: "blocked", failure_kind: "no_progress", reason: "阻塞", verification_event_ids: [] });
    const started = await append("goal.attempt.started", { attempt: 2 });
    const original = session.events.readOrderedStrict!.bind(session.events);
    for (const change of [{ actor: { kind: "agent", id: "fake" } }, { source: { adapter: "foreign" } }, { correlation_id: "foreign" },
      { payload: { ...started.payload, attempt: 4 } }]) {
      const read = vi.spyOn(session.events, "readOrderedStrict").mockImplementation(async () => (await original()).map(event => event.event_id === started.event_id ? { ...event, ...change } as any : event));
      try { expect((await readCoordinationExecutionContext(def, session, revision, runs as unknown as RunService)).goals[0]).toMatchObject({ status: "invalid", current: false }); }
      finally { read.mockRestore(); }
    }
  });

  it("最新坏 Goal 事件变为 invalid，不回退前一个 ready", async () => {
    const ready = await append("goal.attempt.completed", { attempt: 1, max_attempts: 2, status: "ready", reason: "就绪", completion_event_id: ulid(), input_hash: "a".repeat(64), source_hash: "b".repeat(64), artifact_hash: "c".repeat(64), verification_event_ids: [] });
    const broken = await append("goal.attempt.completed", { attempt: 3, max_attempts: 2, status: "ready", reason: "坏事实", completion_event_id: ulid(), input_hash: "a".repeat(64), source_hash: "b".repeat(64), artifact_hash: "c".repeat(64), verification_event_ids: [] });
    const result = await readCoordinationExecutionContext(def, session, revision, runs as unknown as RunService);
    expect(result.goals[0]).toMatchObject({ status: "invalid", event_id: broken.event_id, reason: null, input_hash: null });
    expect(result.goals[0]?.event_id).not.toBe(ready.event_id);
  });
});
