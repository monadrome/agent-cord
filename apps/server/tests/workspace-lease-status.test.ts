import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp, type BuiltServer } from "@agent-cord/server";
import { WorkspaceLease } from "../src/services/workspace-lease.js";

let root: string; let server: BuiltServer; let base: string;
async function api(path: string) { const response = await fetch(base + "/api/v1" + path); return { status: response.status, body: await response.json() }; }
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "cord-workspace-lease-status-")); await mkdir(join(root, "cord")); server = await buildApp({ root }); base = await server.app.listen({ host: "127.0.0.1", port: 0 }); });
afterEach(async () => { await server.app.close(); server.index.close(); await rm(root, { recursive: true, force: true }); });

describe("workspace lease runtime projection", () => {
  it("空工作区报告free，并在活动run中报告held且带owner", async () => {
    expect(await api("/workspace/lease")).toMatchObject({ status: 200, body: { workspace: { isolation: "shared_lease", state: "free", owner: null } } });
    const lease = new WorkspaceLease(root); lease.acquire("REQ-LEASE-STATUS", "RUN-LEASE-STATUS");
    expect(lease.status()).toEqual({ isolation: "shared_lease", state: "held", owner: { req_id: "REQ-LEASE-STATUS", run_id: "RUN-LEASE-STATUS" } });
    lease.release("REQ-LEASE-STATUS", "RUN-LEASE-STATUS"); expect(lease.status()).toMatchObject({ state: "free", owner: null });
  });

  it("遗留owner标记只读投影为unresolved，不自动接管", async () => {
    await mkdir(join(root, "cord", ".index"), { recursive: true });
    await writeFile(join(root, "cord", ".index", "workspace-lease-owner.json"), JSON.stringify({ lease_id: "x", req_id: "REQ-OLD", run_id: "RUN-OLD" }));
    expect(await api("/workspace/lease")).toMatchObject({ status: 200, body: { workspace: { isolation: "shared_lease", state: "unresolved", owner: { req_id: "REQ-OLD", run_id: "RUN-OLD" } } } });
  });
});
