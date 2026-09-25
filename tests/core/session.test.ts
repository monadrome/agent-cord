import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { ulid } from "ulid";
import {
  initSession,
  openSession,
  EVENTS_FILE,
  LEDGER_FILE,
  SNAPSHOT_DOC_FILES,
} from "../../src/core/session.js";
import { LedgerSchema } from "../../src/core/schema.js";
import * as core from "../../src/core/index.js";

const REQ_ID = "REQ-2026-042";

let cordRoot: string;

beforeEach(async () => {
  cordRoot = await mkdtemp(join(tmpdir(), "cord-session-"));
});

afterEach(async () => {
  await rm(cordRoot, { recursive: true, force: true });
});

function sessionPath(...parts: string[]): string {
  return join(cordRoot, REQ_ID, ...parts);
}

function draft(entryId: string) {
  return {
    event_id: ulid(),
    session_id: REQ_ID,
    type: "ledger.entry.proposed",
    schema_version: "1" as const,
    actor: { kind: "system" as const, id: "test" },
    correlation_id: null,
    payload: {
      entry: {
        entry_id: entryId,
        title: `title ${entryId}`,
        anchors: [{ kind: "code" as const, anchor: "src/x.ts#f" }],
      },
    },
    source: { adapter: "test" },
  };
}

describe("initSession：布局", () => {
  it("创建 cord/<req-id>/ 的标准文件与初始空投影", async () => {
    const session = await initSession(cordRoot, REQ_ID);

    expect(session.req_id).toBe(REQ_ID);
    expect(session.dir).toBe(join(cordRoot, REQ_ID));
    for (const fileName of [...SNAPSHOT_DOC_FILES, EVENTS_FILE, LEDGER_FILE]) {
      const info = await stat(sessionPath(fileName));
      expect(info.isFile()).toBe(true);
    }
    expect(await readFile(sessionPath(EVENTS_FILE), "utf8")).toBe("");
    for (const fileName of SNAPSHOT_DOC_FILES) {
      const text = await readFile(sessionPath(fileName), "utf8");
      expect(text).toContain(`id: ${REQ_ID}`);
      expect(text.startsWith("---\n")).toBe(true);
    }

    const ledger = LedgerSchema.parse(YAML.parse(await readFile(sessionPath(LEDGER_FILE), "utf8")));
    expect(ledger.reducer_version).toBe(core.REDUCER_VERSION);
    expect(ledger.entries).toEqual([]);
    expect((await session.doctor()).ok).toBe(true);
  });

  it("重复 init 不覆盖人编辑过的文档与既有事件流", async () => {
    const first = await initSession(cordRoot, REQ_ID);
    await first.events.append(draft("C-001"));
    await writeFile(sessionPath("prd.md"), "# 人手改过的 PRD\n", "utf8");

    const second = await initSession(cordRoot, REQ_ID);
    expect(await readFile(sessionPath("prd.md"), "utf8")).toBe("# 人手改过的 PRD\n");
    expect(await second.events.readAll()).toHaveLength(1);
    expect(second.events).not.toBe(first.events);
  });

  it("拒绝带路径分隔符的 req_id", async () => {
    await expect(initSession(cordRoot, "../escape")).rejects.toThrow(/非法的 req_id/);
    await expect(initSession(cordRoot, "a/b")).rejects.toThrow(/非法的 req_id/);
    await expect(initSession(cordRoot, "")).rejects.toThrow(/非法的 req_id/);
  });
});

describe("openSession：读写与投影", () => {
  it("未初始化的 session 直接报错", async () => {
    await expect(openSession(cordRoot, REQ_ID)).rejects.toThrow(/不存在/);
  });

  it("readLedger 读投影、rebuildLedger 由事件流重建", async () => {
    const session = await initSession(cordRoot, REQ_ID);
    await session.events.append(draft("C-001"));
    await session.events.append(draft("C-002"));

    const reopened = await openSession(cordRoot, REQ_ID);
    // 事件已落盘但投影未刷新：readLedger 只读现状，doctor 报告漂移
    expect((await reopened.readLedger()).entries).toEqual([]);
    const drifted = await reopened.doctor();
    expect(drifted.ok).toBe(false);
    expect(drifted.checks.find((c) => c.name === "ledger_projection_matches")?.ok).toBe(false);

    const rebuilt = await reopened.rebuildLedger();
    expect(rebuilt.entries.map((entry) => entry.entry_id)).toEqual(["C-001", "C-002"]);
    expect((await reopened.readLedger()).output_hash).toBe(rebuilt.output_hash);
    expect((await reopened.doctor()).ok).toBe(true);
  });

  it("新写的状态流转事件投影后进入 ledger.yaml", async () => {
    const session = await initSession(cordRoot, REQ_ID);
    await session.events.append(draft("C-001"));
    await session.events.append({
      ...draft("C-001"),
      type: "ledger.entry.confirmed",
      payload: {
        entry_id: "C-001",
        expected_status: "provisional",
        confidence_source: "human_confirmation",
      },
    });

    const ledger = await session.rebuildLedger();
    expect(ledger.entries[0]!.status).toBe("confirmed");
    expect(ledger.entries[0]!.confidence_source).toBe("human_confirmation");
    const persisted = LedgerSchema.parse(YAML.parse(await readFile(sessionPath(LEDGER_FILE), "utf8")));
    expect(persisted.entries[0]!.status).toBe("confirmed");
    expect((await session.doctor()).ok).toBe(true);
  });

  it("rebuildLedger 只写 ledger.yaml，不触碰事件流", async () => {
    const session = await initSession(cordRoot, REQ_ID);
    await session.events.append(draft("C-001"));
    const before = await readFile(sessionPath(EVENTS_FILE), "utf8");
    await session.rebuildLedger();
    expect(await readFile(sessionPath(EVENTS_FILE), "utf8")).toBe(before);
  });
});

describe("core 公共 API", () => {
  it("index.ts 导出事件协议 + reducer + session + doctor", () => {
    expect(core.REDUCER_VERSION).toBe("1");
    expect(typeof core.createReducer).toBe("function");
    expect(typeof core.reduceEvents).toBe("function");
    expect(typeof core.runDoctor).toBe("function");
    expect(typeof core.initSession).toBe("function");
    expect(typeof core.openSession).toBe("function");
    expect(typeof core.JsonlEventStore.open).toBe("function");
    expect(typeof core.hashEvent).toBe("function");
    expect(typeof core.orderEvents).toBe("function");
    expect(core.EVENTS_FILE).toBe("events.jsonl");
    expect(core.LEDGER_FILE).toBe("ledger.yaml");
    expect(core.EVENT_TYPES).toContain("ledger.entry.proposed");
    expect(core.EventEnvelopeSchema.safeParse({}).success).toBe(false);
  });
});
