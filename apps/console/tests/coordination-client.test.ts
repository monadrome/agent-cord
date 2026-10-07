/** typed client → 真实 HTTP server，独立协调与人工采用的完整操作链。 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp, type BuiltServer } from "@agent-cord/server";
import type { CoordinationRoundView } from "@agent-cord/server/contracts";
import { ApiClientError, createClient, type ApiClient } from "../src/api.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "../../../tests/driver/fixtures/fake-cli.mjs");
const proposal = { summary: "确认需求后推进 SDLC", next_action: { kind: "advance", node_id: "intake", reason: "需求基线已明确", evidence: [{ source: "document", id: "prd.md" }] }, risks: [] };
let root: string;
let server: BuiltServer;
let client: ApiClient;
async function wait_for(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("等待 console 协调状态超时");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
async function config(sleep_ms = 0): Promise<void> {
  await writeFile(join(root, "cord", "agents.yaml"), YAML.stringify({ agents: { local: { kind: "headless", bin: process.execPath,
    args: [fixture, "--mode", "claude", "--sleep", String(sleep_ms), "--result-text", JSON.stringify(proposal), "{{prompt}}"] } } }));
  await client.reloadAgents();
}
async function terminal(round_id: string): Promise<CoordinationRoundView> {
  let round: CoordinationRoundView | undefined;
  await wait_for(async () => {
    round = (await client.getCoordination("REQ-UI", round_id)).round;
    return !["pending", "running"].includes(round.status);
  });
  return round!;
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cord-console-coordination-"));
  server = await buildApp({ root });
  await server.app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.app.server.address();
  if (address === null || typeof address === "string") throw new Error("无法获取监听端口");
  client = createClient(`http://127.0.0.1:${address.port}`);
  await config();
  await client.createRequirement({ req_id: "REQ-UI", title: "console 协调", prd: "# PRD\n需求" });
});
afterEach(async () => {
  for (const run of server.runs.listRuns()) if (server.runs.activeRunId(run.req_id) === run.run_id) await server.runs.cancel(run.run_id);
  await server.app.close(); server.index.close();
  await rm(root, { recursive: true, force: true });
});

describe("console 协调客户端", () => {
  it("创建/幂等重放/查询 → 采用 → 人工 gate → 完成，重复采用返回原 run", async () => {
    expect((await client.listCoordination("REQ-UI")).rounds).toEqual([]);
    const input = { agent: "local", sdlc_id: "simple-sdlc", sdlc_version: 1, timeout_ms: 10_000 };
    const first = await client.startCoordination("REQ-UI", input, "coordinate-ui-action");
    expect(await client.startCoordination("REQ-UI", input, "coordinate-ui-action")).toEqual(first);
    expect(await terminal(first.round.round_id)).toMatchObject({ status: "ok", current: true, adoptable: true, agent: "local", proposal });
    expect((await client.listCoordination("REQ-UI")).rounds).toHaveLength(1);
    const adopted = await client.adoptCoordination("REQ-UI", first.round.round_id, "adopt-ui-action");
    expect(await client.adoptCoordination("REQ-UI", first.round.round_id, "adopt-ui-action")).toEqual(adopted);
    await wait_for(async () => (await client.getApprovals("REQ-UI")).approvals.length > 0);
    expect((await client.getRequirement("REQ-UI")).requirement.status).toBe("waiting_human");
    const [approval] = (await client.getApprovals("REQ-UI")).approvals;
    await client.decideApproval("REQ-UI", approval!.approval_id, "确认放行");
    await wait_for(async () => (await client.getRequirement("REQ-UI")).requirement.status === "completed" && !server.runs.isActive("REQ-UI"));
    expect((await client.adoptCoordination("REQ-UI", first.round.round_id)).run).toMatchObject({ run_id: adopted.run.run_id, status: "completed" });
    expect((await client.getCoordination("REQ-UI", first.round.round_id)).round.adopted_run_id).toBe(adopted.run.run_id);
    expect((await client.doctor()).ok).toBe(true);
  });

  it("输入变化的历史提议不可采用，API 错误保留 409，重新协调可恢复", async () => {
    const first = await client.startCoordination("REQ-UI", { agent: "local" });
    await terminal(first.round.round_id);
    await client.writeDoc("REQ-UI", "prd", "# PRD\n更新后的需求");
    expect((await client.getCoordination("REQ-UI", first.round.round_id)).round).toMatchObject({ status: "ok", current: false, adoptable: false });
    await expect(client.adoptCoordination("REQ-UI", first.round.round_id)).rejects.toMatchObject({ status: 409, code: "conflict" });
    const recovered = await client.startCoordination("REQ-UI", { agent: "local" });
    expect(await terminal(recovered.round.round_id)).toMatchObject({ status: "ok", current: true });
  });

  it("取消与超时完整透传，新轮次仍可启动，404 使用统一错误形状", async () => {
    await config(2_000);
    const first = await client.startCoordination("REQ-UI", { agent: "local" });
    expect((await client.cancelCoordination("REQ-UI", first.round.round_id)).round.status).toBe("cancelled");
    const next = await client.startCoordination("REQ-UI", { agent: "local", timeout_ms: 50 });
    expect((await terminal(next.round.round_id)).status).toBe("timeout");
    try { await client.getCoordination("REQ-UI", "missing/round"); throw new Error("应当 404"); }
    catch (error) { expect(error).toBeInstanceOf(ApiClientError); expect(error).toMatchObject({ status: 404, code: "not_found" }); }
  });
});
