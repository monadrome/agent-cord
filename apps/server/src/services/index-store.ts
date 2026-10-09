/**
 * 派生索引（ADR-0021 决策 3）：node:sqlite，只存「不可从事件流派生的操作事实」——
 * 幂等操作（请求身份、执行占位与首次响应）与运行登记（runs）。
 * 删除索引会丢失幂等操作保护；运行绑定可从事件重建，不能把删除索引当作 pending 的恢复方法。
 */
import { DatabaseSync } from "node:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RunInfo, RunStatus } from "../contracts.js";

export const INDEX_DIR = ".index";
export const INDEX_FILE = "server-index.sqlite";

export interface StoredIdempotency {
  key: string;
  method: string;
  path: string;
  status: number;
  response: string;
  created_at: string;
  input_hash: string | null;
  state: "pending" | "completed";
  content_type: string | null;
}
export type IdempotencyIdentity = Pick<StoredIdempotency, "key" | "method" | "path"> & { input_hash: string };

export interface RunRow {
  run_id: string;
  req_id: string;
  sdlc_id: string;
  sdlc_version: number;
  status: RunStatus;
  started_at: string;
  finished_at: string | null;
  error: string | null;
  /** ADR-0033：采用启动的 run 在恢复前必须核验对应事实；普通 run 为 null。 */
  coordination_round_id?: string | null;
  goal_retry_round_id?: string | null;
  workflow_revision?: string | null;
}

export class IndexStore {
  private readonly db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.db = db;
  }

  static async open(cordRoot: string): Promise<IndexStore> {
    const dir = join(cordRoot, INDEX_DIR);
    await mkdir(dir, { recursive: true });
    const db = new DatabaseSync(join(dir, INDEX_FILE));
    db.exec(`
      CREATE TABLE IF NOT EXISTS idempotency_keys (
        key TEXT PRIMARY KEY,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        status INTEGER NOT NULL,
        response TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        req_id TEXT NOT NULL,
        sdlc_id TEXT NOT NULL,
        sdlc_version INTEGER NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_runs_req ON runs(req_id);
      CREATE TABLE IF NOT EXISTS sdlc_archives (
        sdlc_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        archived_at TEXT NOT NULL,
        PRIMARY KEY (sdlc_id, version)
      );
    `);
    const columns = db.prepare("PRAGMA table_info(runs)").all();
    if (!columns.some((column) => column["name"] === "coordination_round_id")) db.exec("ALTER TABLE runs ADD COLUMN coordination_round_id TEXT");
    if (!columns.some((column) => column["name"] === "workflow_revision")) db.exec("ALTER TABLE runs ADD COLUMN workflow_revision TEXT");
    if (!columns.some((column) => column["name"] === "goal_retry_round_id")) db.exec("ALTER TABLE runs ADD COLUMN goal_retry_round_id TEXT");
    const idempotency_columns = db.prepare("PRAGMA table_info(idempotency_keys)").all();
    if (!idempotency_columns.some((column) => column["name"] === "input_hash")) db.exec("ALTER TABLE idempotency_keys ADD COLUMN input_hash TEXT");
    if (!idempotency_columns.some((column) => column["name"] === "state")) db.exec("ALTER TABLE idempotency_keys ADD COLUMN state TEXT NOT NULL DEFAULT 'completed'");
    if (!idempotency_columns.some((column) => column["name"] === "content_type")) db.exec("ALTER TABLE idempotency_keys ADD COLUMN content_type TEXT");
    return new IndexStore(db);
  }

  close(): void {
    this.db.close();
  }

  // ---- SDLC 版本归档登记（ADR-0022 决策 3：不改变文件内容，登记于索引） ----------------

  archiveSdlcVersion(sdlcId: string, version: number): void {
    this.db
      .prepare("INSERT OR IGNORE INTO sdlc_archives (sdlc_id, version, archived_at) VALUES (?, ?, ?)")
      .run(sdlcId, version, new Date().toISOString());
  }

  unarchiveSdlcVersion(sdlcId: string, version: number): void {
    this.db.prepare("DELETE FROM sdlc_archives WHERE sdlc_id = ? AND version = ?").run(sdlcId, version);
  }

  isSdlcVersionArchived(sdlcId: string, version: number): boolean {
    return (
      this.db.prepare("SELECT 1 FROM sdlc_archives WHERE sdlc_id = ? AND version = ?").get(sdlcId, version) !==
      undefined
    );
  }

  /** 全部归档登记（sdlc_id → 已归档版本集合） */
  listSdlcArchives(): Map<string, Set<number>> {
    const rows = this.db.prepare("SELECT sdlc_id, version FROM sdlc_archives").all() as unknown as Array<{
      sdlc_id: string;
      version: number;
    }>;
    const out = new Map<string, Set<number>>();
    for (const row of rows) {
      const set = out.get(row.sdlc_id) ?? new Set<number>();
      set.add(row.version);
      out.set(row.sdlc_id, set);
    }
    return out;
  }

  getIdempotency(key: string): StoredIdempotency | null {
    const row = this.db
      .prepare("SELECT key, method, path, status, response, created_at, input_hash, state, content_type FROM idempotency_keys WHERE key = ?")
      .get(key);
    return row === undefined ? null : (row as unknown as StoredIdempotency);
  }

  /** 业务执行前的持久化占位；冲突返回 false，不忽略已有 owner。 */
  reserveIdempotency(entry: IdempotencyIdentity): boolean {
    const result = this.db.prepare("INSERT INTO idempotency_keys (key,method,path,status,response,created_at,input_hash,state) VALUES (?,?,?,0,'',?,?,'pending') ON CONFLICT(key) DO NOTHING")
      .run(entry.key, entry.method, entry.path, new Date().toISOString(), entry.input_hash);
    return result.changes === 1;
  }

  completeIdempotency(entry: IdempotencyIdentity & { status: number; response: string; content_type: string }): void {
    const result = this.db.prepare("UPDATE idempotency_keys SET status=?,response=?,content_type=?,state='completed' WHERE key=? AND method=? AND path=? AND input_hash=? AND state='pending'")
      .run(entry.status, entry.response, entry.content_type, entry.key, entry.method, entry.path, entry.input_hash);
    if (result.changes !== 1) throw new Error("幂等请求占位不匹配，拒绝记录未确认响应");
  }

  releaseIdempotency(entry: IdempotencyIdentity): void {
    const result = this.db.prepare("DELETE FROM idempotency_keys WHERE key=? AND method=? AND path=? AND input_hash=? AND state='pending'")
      .run(entry.key, entry.method, entry.path, entry.input_hash);
    if (result.changes !== 1) throw new Error("幂等请求占位不匹配，无法确认拒绝请求已释放");
  }

  insertRun(run: RunRow): void {
    this.db
      .prepare(
        "INSERT INTO runs (run_id, req_id, sdlc_id, sdlc_version, status, started_at, finished_at, error, coordination_round_id, workflow_revision, goal_retry_round_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(run.run_id, run.req_id, run.sdlc_id, run.sdlc_version, run.status, run.started_at, run.finished_at, run.error, run.coordination_round_id ?? null, run.workflow_revision ?? null, run.goal_retry_round_id ?? null);
  }

  finishRun(runId: string, status: RunStatus, finishedAt: string, error: string | null): void {
    this.db
      .prepare("UPDATE runs SET status = ?, finished_at = ?, error = ? WHERE run_id = ?")
      .run(status, finishedAt, error, runId);
  }

  setRunStatus(runId: string, status: RunStatus): void {
    this.db.prepare("UPDATE runs SET status = ? WHERE run_id = ?").run(status, runId);
  }

  getRun(runId: string): RunRow | null {
    const row = this.db.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId);
    return row === undefined ? null : (row as unknown as RunRow);
  }

  /** 某需求最近一次的运行登记（无则 null） */
  latestRun(reqId: string): RunRow | null {
    const row = this.db
      .prepare("SELECT * FROM runs WHERE req_id = ? ORDER BY started_at DESC LIMIT 1")
      .get(reqId);
    return row === undefined ? null : (row as unknown as RunRow);
  }

  listRuns(reqId?: string): RunRow[] {
    const rows = reqId === undefined
      ? this.db.prepare("SELECT * FROM runs ORDER BY started_at DESC").all()
      : this.db.prepare("SELECT * FROM runs WHERE req_id = ? ORDER BY started_at DESC").all(reqId);
    return rows as unknown as RunRow[];
  }
}

export function runRowToInfo(row: RunRow): RunInfo {
  return {
    run_id: row.run_id,
    req_id: row.req_id,
    sdlc_id: row.sdlc_id,
    sdlc_version: row.sdlc_version,
    status: row.status,
    started_at: row.started_at,
    finished_at: row.finished_at,
    error: row.error,
    workflow_revision: row.workflow_revision ?? null,
    ...(row.goal_retry_round_id == null ? {} : { goal_retry_round_id: row.goal_retry_round_id }),
  };
}
