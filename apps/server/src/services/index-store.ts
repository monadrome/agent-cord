/**
 * 派生索引（ADR-0021 决策 3）：node:sqlite，只存「不可从事件流派生的操作事实」——
 * 幂等键（Idempotency-Key → 首次响应快照）与运行登记（runs）。
 * 索引可整体删除：幂等表丢失的代价是极端重启窗口内的重放保护失效，业务事实仍在事件流。
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
}

export interface RunRow {
  run_id: string;
  req_id: string;
  sdlc_id: string;
  sdlc_version: number;
  status: RunStatus;
  started_at: string;
  finished_at: string | null;
  error: string | null;
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
    `);
    return new IndexStore(db);
  }

  close(): void {
    this.db.close();
  }

  getIdempotency(key: string): StoredIdempotency | null {
    const row = this.db
      .prepare("SELECT key, method, path, status, response, created_at FROM idempotency_keys WHERE key = ?")
      .get(key);
    return row === undefined ? null : (row as unknown as StoredIdempotency);
  }

  putIdempotency(entry: StoredIdempotency): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO idempotency_keys (key, method, path, status, response, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(entry.key, entry.method, entry.path, entry.status, entry.response, entry.created_at);
  }

  insertRun(run: RunRow): void {
    this.db
      .prepare(
        "INSERT INTO runs (run_id, req_id, sdlc_id, sdlc_version, status, started_at, finished_at, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(run.run_id, run.req_id, run.sdlc_id, run.sdlc_version, run.status, run.started_at, run.finished_at, run.error);
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
  };
}
