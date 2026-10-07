/** SQLite 旧运行登记兼容与协调采用绑定的持久化。 */
import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IndexStore } from "@agent-cord/server";

let root: string;
let index: IndexStore | null = null;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "cord-index-migration-")); });
afterEach(async () => { index?.close(); await rm(root, { recursive: true, force: true }); });

describe("协调运行登记", () => {
  it("旧 runs 表增加可空协调绑定，保留历史运行且可重复打开", async () => {
    await mkdir(join(root, ".index"));
    const legacy = new DatabaseSync(join(root, ".index", "server-index.sqlite"));
    legacy.exec("CREATE TABLE runs (run_id TEXT PRIMARY KEY, req_id TEXT NOT NULL, sdlc_id TEXT NOT NULL, sdlc_version INTEGER NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, error TEXT)");
    legacy.prepare("INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("legacy-run", "REQ-LEGACY", "simple-sdlc", 1, "failed", "2026-10-07T00:00:00.000Z", "2026-10-07T00:01:00.000Z", "旧失败原因");
    legacy.close();
    index = await IndexStore.open(root);
    expect(index.getRun("legacy-run")).toMatchObject({ req_id: "REQ-LEGACY", status: "failed", error: "旧失败原因", coordination_round_id: null });
    index.close(); index = null;
    index = await IndexStore.open(root);
    expect(index.listRuns()).toHaveLength(1);
  });

  it("协调绑定跨重启保留，普通 run 默认使用 null", async () => {
    index = await IndexStore.open(root);
    const base = { req_id: "REQ-INDEX", sdlc_id: "simple-sdlc", sdlc_version: 1, status: "running" as const, started_at: "2026-10-07T00:00:00.000Z", finished_at: null, error: null };
    index.insertRun({ ...base, run_id: "ordinary" });
    index.insertRun({ ...base, run_id: "coordinated", coordination_round_id: "bound-round" });
    index.close(); index = null;
    index = await IndexStore.open(root);
    expect(index.getRun("ordinary")?.coordination_round_id).toBeNull();
    expect(index.getRun("coordinated")?.coordination_round_id).toBe("bound-round");
  });
});
