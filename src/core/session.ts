/**
 * session：`cord/<req-id>/` 文件夹句柄（ADR-0010 决策 4 布局、04 章 §6.1 分层）。
 *
 * - initSession 只补建缺失的文件，绝不覆盖已存在内容（文档允许人编辑、事件流永不重写）；
 * - ledger.yaml 永远由事件流投影而来（reducer 纯函数），rebuildLedger 是唯一的重建路径；
 *   readLedger 只读现状（不隐式刷新），仅当 ledger.yaml 缺失时自动重建——投影可再生；
 * - 原子写：先写 .tmp 再 rename，避免半个 ledger 被读到。
 */
import { access, mkdir, open as openFile, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import type { DoctorReport, SessionHandle } from "./ports.js";
import { LedgerSchema, type Ledger } from "./schema.js";
import { JsonlEventStore } from "./store.js";
import { createReducer } from "./reducer.js";
import { runDoctor } from "./doctor.js";

export const SNAPSHOT_DOC_FILES = ["prd.md", "plan.md", "adr.md", "findings.md"] as const;
export const EVENTS_FILE = "events.jsonl";
export const LEDGER_FILE = "ledger.yaml";

const DOC_TITLES: Record<string, string> = {
  "prd.md": "PRD",
  "plan.md": "Plan",
  "adr.md": "ADR",
  "findings.md": "Findings",
};

function sessionDir(cordRoot: string, reqId: string): string {
  if (reqId.length === 0 || reqId.includes("/") || reqId.includes("\\") || reqId === "." || reqId === "..") {
    throw new Error(`非法的 req_id：${JSON.stringify(reqId)}（禁止路径分隔符与 . / ..）`);
  }
  return join(cordRoot, reqId);
}

function docPlaceholder(reqId: string, fileName: string): string {
  const title = DOC_TITLES[fileName] ?? fileName;
  return [
    "---",
    `id: ${reqId}`,
    `doc: ${fileName.replace(/\.md$/, "")}`,
    "status: draft",
    "---",
    "",
    `# ${title} — ${reqId}`,
    "",
    "<!-- 占位文档（由 cord init 生成）：人可编辑；状态机流转只经 events.jsonl -->",
    "",
  ].join("\n");
}

/** 不存在才创建（flag wx）；已存在则原样保留 */
async function createIfAbsent(filePath: string, content: string): Promise<void> {
  try {
    await writeFile(filePath, content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const temporary = `${filePath}.tmp`;
  const handle = await openFile(temporary, "w");
  try {
    await handle.write(content, null, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, filePath);
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function createHandle(cordRoot: string, reqId: string, events: JsonlEventStore): SessionHandle {
  const dir = sessionDir(cordRoot, reqId);
  const ledgerPath = join(dir, LEDGER_FILE);
  const reducer = createReducer();

  const rebuildLedger = async (): Promise<Ledger> => {
    const ledger = reducer.reduce(await events.readAll());
    await writeFileAtomic(ledgerPath, YAML.stringify(ledger));
    return ledger;
  };

  const handle: SessionHandle = {
    req_id: reqId,
    dir,
    events,
    async readLedger(): Promise<Ledger> {
      let text: string;
      try {
        text = await readFile(ledgerPath, "utf8");
      } catch (error) {
        if (isNotFound(error)) return await rebuildLedger();
        throw error;
      }
      const parsed = LedgerSchema.safeParse(YAML.parse(text));
      if (!parsed.success) {
        throw new Error(`ledger.yaml 不符合 Ledger schema（${ledgerPath}）：${parsed.error.message}`);
      }
      return parsed.data;
    },
    rebuildLedger,
    doctor(): Promise<DoctorReport> {
      return runDoctor(handle);
    },
  };
  return handle;
}

/** 创建 `cord/<req-id>/` 布局：快照文档占位 + 空事件流 + 初始空投影 */
export async function initSession(cordRoot: string, reqId: string): Promise<SessionHandle> {
  const dir = sessionDir(cordRoot, reqId);
  await mkdir(dir, { recursive: true });

  for (const fileName of SNAPSHOT_DOC_FILES) {
    await createIfAbsent(join(dir, fileName), docPlaceholder(reqId, fileName));
  }
  await createIfAbsent(join(dir, EVENTS_FILE), "");

  const events = await JsonlEventStore.open({ sessionId: reqId, filePath: join(dir, EVENTS_FILE) });
  const handle = createHandle(cordRoot, reqId, events);
  await createIfAbsent(join(dir, LEDGER_FILE), YAML.stringify(createReducer().reduce([])));
  return handle;
}

/** 打开已存在的 session（events.jsonl 必须存在；open 不会凭空创建 session） */
export async function openSession(cordRoot: string, reqId: string): Promise<SessionHandle> {
  const dir = sessionDir(cordRoot, reqId);
  const eventsPath = join(dir, EVENTS_FILE);
  try {
    await access(eventsPath);
  } catch {
    throw new Error(`session ${reqId} 不存在：缺少 ${eventsPath}（先执行 initSession）`);
  }
  const events = await JsonlEventStore.open({ sessionId: reqId, filePath: eventsPath });
  return createHandle(cordRoot, reqId, events);
}
