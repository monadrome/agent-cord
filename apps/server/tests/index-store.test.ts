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
    expect(index.getRun("legacy-run")).toMatchObject({ req_id: "REQ-LEGACY", status: "failed", error: "旧失败原因", coordination_round_id: null, workflow_revision: null });
    index.close(); index = null;
    index = await IndexStore.open(root);
    expect(index.listRuns()).toHaveLength(1);
  });

  it("协调绑定跨重启保留，普通 run 默认使用 null", async () => {
    index = await IndexStore.open(root);
    const base = { req_id: "REQ-INDEX", sdlc_id: "simple-sdlc", sdlc_version: 1, status: "running" as const, started_at: "2026-10-07T00:00:00.000Z", finished_at: null, error: null };
    index.insertRun({ ...base, run_id: "ordinary" });
    index.insertRun({ ...base, run_id: "coordinated", coordination_round_id: "bound-round", workflow_revision: "a".repeat(64) });
    index.close(); index = null;
    index = await IndexStore.open(root);
    expect(index.getRun("ordinary")?.coordination_round_id).toBeNull();
    expect(index.getRun("coordinated")?.coordination_round_id).toBe("bound-round");
    expect(index.getRun("coordinated")?.workflow_revision).toBe("a".repeat(64));
  });
});

describe("幂等执行生命周期", () => {
  it("旧缓存表迁移保留响应，输入身份为 null，重复打开不会覆盖", async () => {
    await mkdir(join(root, ".index"));
    const legacy = new DatabaseSync(join(root, ".index", "server-index.sqlite"));
    legacy.exec("CREATE TABLE idempotency_keys (key TEXT PRIMARY KEY, method TEXT NOT NULL, path TEXT NOT NULL, status INTEGER NOT NULL, response TEXT NOT NULL, created_at TEXT NOT NULL)");
    legacy.prepare("INSERT INTO idempotency_keys VALUES (?,?,?,?,?,?)").run("old-key", "POST", "/api/v1/requirements", 201, '{"created":true}', "2026-10-07T00:00:00.000Z");
    legacy.close();
    index = await IndexStore.open(root);
    expect(index.getIdempotency("old-key")).toMatchObject({ input_hash: null, state: "completed", response: '{"created":true}', status: 201, content_type: null });
    index.close(); index = null;
    index = await IndexStore.open(root);
    expect(index.getIdempotency("old-key")?.input_hash).toBeNull();
  });

  it("同键占位不能重复获得，错误身份不得完成/释放，成功响应跨重启保留", async () => {
    index = await IndexStore.open(root);
    const identity = { key: "operation", method: "PUT", path: "/api/v1/requirements/REQ-1/docs/prd", input_hash: "a".repeat(64) };
    expect(index.reserveIdempotency(identity)).toBe(true);
    expect(index.reserveIdempotency(identity)).toBe(false);
    const mismatch = { ...identity, input_hash: "b".repeat(64) };
    expect(() => index!.releaseIdempotency(mismatch)).toThrow(/不匹配/);
    expect(() => index!.completeIdempotency({ ...mismatch, status: 200, response: '{"saved":true}', content_type: "application/json" })).toThrow(/不匹配/);
    expect(index.getIdempotency(identity.key)?.state).toBe("pending");
    index.completeIdempotency({ ...identity, status: 200, response: '{"saved":true}', content_type: "application/json" });
    expect(() => index!.releaseIdempotency(identity)).toThrow(/不匹配/);
    expect(() => index!.completeIdempotency({ ...identity, status: 201, response: "replacement", content_type: "text/plain" })).toThrow(/不匹配/);
    index.close(); index = null; index = await IndexStore.open(root);
    expect(index.getIdempotency(identity.key)).toMatchObject({ ...identity, state: "completed", status: 200, response: '{"saved":true}' });
  });

  it("已知拒绝只释放匹配的 pending，修复后可以再次占位", async () => {
    index = await IndexStore.open(root);
    const identity = { key: "rejected", method: "POST", path: "/api/v1/requirements", input_hash: "a".repeat(64) };
    expect(index.reserveIdempotency(identity)).toBe(true);
    index.releaseIdempotency(identity);
    expect(index.getIdempotency(identity.key)).toBeNull();
    expect(index.reserveIdempotency({ ...identity, input_hash: "b".repeat(64) })).toBe(true);
  });

  it("两个索引句柄不能同时获得同键执行权，不覆盖原请求身份", async () => {
    index = await IndexStore.open(root);
    const another = await IndexStore.open(root);
    const identity = { key: "shared-owner", method: "POST", path: "/api/v1/requirements", input_hash: "a".repeat(64) };
    try {
      expect(index.reserveIdempotency(identity)).toBe(true);
      expect(another.reserveIdempotency({ ...identity, path: "/api/v1/agents/reload" })).toBe(false);
      expect(another.getIdempotency(identity.key)).toMatchObject({ ...identity, state: "pending" });
    } finally { another.close(); }
  });
});
