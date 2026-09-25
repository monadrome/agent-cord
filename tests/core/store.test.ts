import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "ulid";
import { JsonlEventStore } from "../../src/core/store.js";
import { canonicalJson, hashEvent } from "../../src/core/hash.js";
import { EventEnvelopeSchema, type EventDraft, type EventEnvelope } from "../../src/core/schema.js";

const SESSION = "REQ-TEST";

let dir: string;
let filePath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cord-store-"));
  filePath = join(dir, "events.jsonl");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function draft(overrides: Partial<EventDraft> = {}): EventDraft {
  return {
    event_id: ulid(),
    session_id: SESSION,
    type: "ledger.entry.proposed",
    schema_version: "1",
    actor: { kind: "system", id: "test" },
    correlation_id: null,
    payload: { note: "x" },
    source: { adapter: "test" },
    ...overrides,
  };
}

function openStore(options: Partial<{ sessionId: string; persistLine: (p: string, l: string) => Promise<void> }> = {}) {
  return JsonlEventStore.open({
    sessionId: SESSION,
    filePath,
    ...options,
  });
}

function rawLines(): string[] {
  return readFileSync(filePath, "utf8").split("\n").filter((line) => line.length > 0);
}

describe("JsonlEventStore：追加与顺序", () => {
  it("分配 seq 与 prev_event_hash，首事件 prev 为 null，单行 JSON 原子追加", async () => {
    const store = await openStore();
    const first = await store.append(draft({ payload: { n: 1 } }));
    const second = await store.append(draft({ payload: { n: 2 } }));

    expect(first.seq).toBe(1);
    expect(first.prev_event_hash).toBeNull();
    expect(second.seq).toBe(2);
    expect(second.prev_event_hash).toBe(hashEvent(first));

    const raw = await readFile(filePath, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    const lines = rawLines();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(canonicalJson(first));
    expect(lines[1]).toBe(canonicalJson(second));
    expect(EventEnvelopeSchema.safeParse(JSON.parse(lines[1] ?? "")).success).toBe(true);
  });

  it("readAll 按文件行序、readOrdered 按因果序", async () => {
    const store = await openStore();
    const first = await store.append(draft());
    const second = await store.append(draft());

    expect((await store.readAll()).map((e) => e.event_id)).toEqual([first.event_id, second.event_id]);
    expect((await store.readOrdered()).map((e) => e.seq)).toEqual([1, 2]);
  });

  it("readOrdered 对交错血统按因果链拓扑序输出（不依赖文件行序）", async () => {
    // 手写事件流：行序被扰动（child 在 parent 之前），且存在并行血统
    const parent = EventEnvelopeSchema.parse({
      ...draft({ payload: { n: 1 } }),
      seq: 1,
      prev_event_hash: null,
      timestamp: "2026-09-24T00:00:01.000Z",
    });
    const branchA = EventEnvelopeSchema.parse({
      ...draft({ payload: { n: 2 } }),
      seq: 2,
      prev_event_hash: hashEvent(parent),
      timestamp: "2026-09-24T00:00:09.000Z",
    });
    const branchB = EventEnvelopeSchema.parse({
      ...draft({ payload: { n: 3 } }),
      seq: 2,
      prev_event_hash: hashEvent(parent),
      timestamp: "2026-09-24T00:00:05.000Z",
    });
    await writeFile(filePath, `${[branchA, parent, branchB].map(canonicalJson).join("\n")}\n`);

    const store = await openStore();
    expect((await store.readOrdered()).map((e) => e.event_id)).toEqual([
      parent.event_id,
      branchB.event_id,
      branchA.event_id,
    ]);
  });
});

describe("JsonlEventStore：并发与订阅", () => {
  it("并发 append 被串行化：seq 连续唯一、prev 链环环相扣", async () => {
    const store = await openStore();
    const appended = await Promise.all(
      Array.from({ length: 25 }, (_, index) => store.append(draft({ payload: { index } }))),
    );

    expect(appended.map((e) => e.seq)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    expect(new Set(appended.map((e) => e.event_id)).size).toBe(25);

    const stored = await store.readAll();
    expect(stored.map((e) => e.seq)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    for (let index = 1; index < stored.length; index += 1) {
      expect(stored[index]?.prev_event_hash).toBe(hashEvent(stored[index - 1]!));
    }
    expect(rawLines()).toHaveLength(25);
  });

  it("订阅者在事件落盘之后才被派发（原子边界）", async () => {
    const store = await openStore();
    const seen: EventEnvelope[] = [];
    store.subscribe((event) => {
      // 派发时该事件必须已经在磁盘上
      expect(readFileSync(filePath, "utf8")).toContain(event.event_id);
      seen.push(event);
    });

    const appended = await store.append(draft());
    expect(seen.map((e) => e.event_id)).toEqual([appended.event_id]);
  });

  it("取消订阅后不再派发；订阅者抛错不影响落盘", async () => {
    const store = await openStore();
    let calls = 0;
    const unsubscribe = store.subscribe(() => {
      calls += 1;
      throw new Error("订阅者崩了");
    });
    await store.append(draft());
    expect(calls).toBe(1);
    unsubscribe();
    await store.append(draft());
    expect(calls).toBe(1);
    expect(rawLines()).toHaveLength(2);
  });

  it("落盘失败时 append 拒绝、不派发、状态不前进", async () => {
    const failing = await openStore({
      persistLine: async () => {
        throw new Error("disk full");
      },
    });
    let dispatched = 0;
    failing.subscribe(() => {
      dispatched += 1;
    });

    await expect(failing.append(draft())).rejects.toThrow("disk full");
    expect(dispatched).toBe(0);
    expect(await failing.readAll()).toHaveLength(0);

    const recovered = await openStore();
    expect((await recovered.append(draft())).seq).toBe(1);
  });
});

describe("JsonlEventStore：崩溃恢复与校验", () => {
  it("重开时丢弃写到一半的残行，并从链尾继续", async () => {
    const store = await openStore();
    await store.append(draft({ payload: { n: 1 } }));
    await store.append(draft({ payload: { n: 2 } }));
    const committed = await readFile(filePath, "utf8");

    writeFileSync(filePath, `${committed}{"event_id":"01J9Z3K7AA0000000000000001","seq":3`, "utf8");

    const reopened = await openStore();
    const events = await reopened.readAll();
    expect(events).toHaveLength(2);
    expect(await readFile(filePath, "utf8")).toBe(committed);
    expect(reopened.diagnostics().notes.some((note) => note.kind === "truncated_tail")).toBe(true);

    const third = await reopened.append(draft({ payload: { n: 3 } }));
    expect(third.seq).toBe(3);
    expect(third.prev_event_hash).toBe(hashEvent(events[1]!));
    expect(rawLines()).toHaveLength(3);
  });

  it("整行损坏（有换行结尾）不被静默修复，而是留下诊断（丢事件可见）", async () => {
    const store = await openStore();
    const first = await store.append(draft());
    await writeFile(filePath, `${canonicalJson(first)}\n{"broken":true}\n`);

    const reopened = await openStore();
    expect(await reopened.readAll()).toHaveLength(1);
    expect(reopened.diagnostics().notes.some((note) => note.kind === "unparsable_line")).toBe(true);
    // 残行仍在文件里（doctor 负责报错，写者不做隐式删除）
    expect(rawLines()).toHaveLength(2);
  });

  it("末行是合法事件、仅缺结尾换行时补换行而不丢事件", async () => {
    const store = await openStore();
    const first = await store.append(draft());
    const committed = await readFile(filePath, "utf8");
    await writeFile(filePath, committed.trimEnd(), "utf8");

    const reopened = await openStore();
    expect(await reopened.readAll()).toHaveLength(1);
    expect(await readFile(filePath, "utf8")).toBe(committed);
    expect(reopened.diagnostics().notes.some((note) => note.kind === "repaired_tail")).toBe(true);
    expect((await reopened.append(draft())).seq).toBe(2);
  });

  it("拒绝 session_id 不匹配、不符合 EventDraft schema 的写入", async () => {
    const store = await openStore();
    await expect(store.append(draft({ session_id: "OTHER" }))).rejects.toThrow(/session_id 不匹配/);
    await expect(store.append(draft({ type: "Ledger.Entry.Proposed" }))).rejects.toThrow();
    await expect(store.append(draft({ event_id: "not-a-ulid" }))).rejects.toThrow();
    expect(await store.readAll()).toHaveLength(0);
    expect((await store.append(draft())).seq).toBe(1);
  });

  it("注入时钟与 id 生成器（测试接缝）", async () => {
    let tick = 0;
    const store = await JsonlEventStore.open({
      sessionId: SESSION,
      filePath,
      newEventId: () => `01J9Z3K7AA${String(tick).padStart(16, "0")}`,
      now: () => new Date(Date.UTC(2026, 8, 24, 12, 0, tick++)),
    });
    const first = await store.append(draft());
    const second = await store.append(draft());
    expect(first.timestamp).toBe("2026-09-24T12:00:00.000Z");
    expect(second.timestamp).toBe("2026-09-24T12:00:01.000Z");
    expect(second.event_id).not.toBe(first.event_id);
  });
});
