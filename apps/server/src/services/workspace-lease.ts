/**
 * ADR-0070：跨 RunService 进程的 workspace lease。
 *
 * 通过独立 SQLite 文件持有 BEGIN IMMEDIATE 事务；进程异常退出时 SQLite
 * 自动释放文件锁；落盘标记仍保留，禁止把 detached worker 自动认作已结束。
 * 执行锁不承载授权或 workflow 事实。
 */
import { DatabaseSync } from "node:sqlite";
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { ApiError, internalError } from "../errors.js";

export class WorkspaceLeaseBusy extends ApiError {
  constructor(message = "当前工作区已被其他 server 实例占用，请等待其收束") {
    super(409, "conflict", message);
  }
}

export class WorkspaceLeaseUnresolved extends ApiError {
  constructor() { super(409, "conflict", "上次工作区执行未确认释放，请先核验遗留 agent/验证进程并修复执行锁"); }
}

function checkFile(path: string): void {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("执行锁必须是单链接普通文件");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export class WorkspaceLease {
  private db: DatabaseSync | null = null;
  private owner: { req_id: string; run_id: string } | null = null;
  private marker: { path: string; content: string } | null = null;

  constructor(private readonly workspace_root?: string) {}

  acquire(req_id: string, run_id: string): void {
    if (this.workspace_root === undefined) return;
    if (this.owner !== null) {
      if (this.owner.req_id === req_id && this.owner.run_id === run_id) return;
      throw new WorkspaceLeaseBusy(`当前工作区已被需求 ${this.owner.req_id} 的 run ${this.owner.run_id} 占用，请等待其收束`);
    }
    let db: DatabaseSync | null = null;
    try {
      const root = realpathSync(resolve(this.workspace_root));
      const cord_dir = join(root, "cord");
      const index_dir = join(cord_dir, ".index");
      mkdirSync(index_dir, { recursive: true });
      for (const directory of [cord_dir, index_dir]) if (!lstatSync(directory).isDirectory()) throw new Error("执行锁目录非法");
      const file = join(index_dir, "workspace-lease.sqlite");
      for (const suffix of ["", "-journal", "-wal", "-shm"]) checkFile(file + suffix);
      db = new DatabaseSync(file);
      db.exec("PRAGMA busy_timeout=0");
      db.exec("BEGIN IMMEDIATE");
      db.exec("CREATE TABLE IF NOT EXISTS workspace_lease (id INTEGER PRIMARY KEY)");
      checkFile(file);
      const marker_path = join(index_dir, "workspace-lease-owner.json");
      checkFile(marker_path);
      const content = JSON.stringify({ lease_id: randomUUID(), req_id, run_id });
      let descriptor: number;
      try { descriptor = openSync(marker_path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new WorkspaceLeaseUnresolved();
        throw error;
      }
      this.marker = { path: marker_path, content };
      try { writeFileSync(descriptor, content); fsyncSync(descriptor); } finally { closeSync(descriptor); }
      this.db = db;
      this.owner = { req_id, run_id };
    } catch (error) {
      if (db !== null) {
        try { db.exec("ROLLBACK"); } catch { /* 未开始事务 */ }
        try { db.close(); } catch { /* 保留原始诊断类别 */ }
      }
      const sqlite = error as { code?: string; errcode?: number };
      if (sqlite.code === "ERR_SQLITE_ERROR" && sqlite.errcode !== undefined && [5, 6].includes(sqlite.errcode & 0xff)) throw new WorkspaceLeaseBusy();
      if (error instanceof WorkspaceLeaseUnresolved) throw error;
      throw internalError("工作区执行锁不可读取，请检查锁文件与访问权限");
    }
  }

  release(req_id: string, run_id: string): boolean {
    if (this.owner?.req_id !== req_id || this.owner.run_id !== run_id) return false;
    const db = this.db;
    this.db = null;
    this.owner = null;
    if (db === null) return true;
    try {
      if (this.marker === null) throw new Error("执行锁缺少持有标记");
      checkFile(this.marker.path);
      if (readFileSync(this.marker.path, "utf8") !== this.marker.content) throw new Error("执行锁持有标记已变化");
      unlinkSync(this.marker.path);
      this.marker = null;
    } catch { throw internalError("工作区执行锁无法确认释放，请核验持有标记"); }
    finally { try { db.exec("ROLLBACK"); } finally { db.close(); } }
    return true;
  }

  close(): void {
    if (this.owner !== null) this.release(this.owner.req_id, this.owner.run_id);
  }
}
