import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { ulid } from "ulid";
import { initSession, openSession, EVENTS_FILE, LEDGER_FILE } from "../../src/core/session.js";
import { canonicalJson, hashEvent } from "../../src/core/hash.js";
import { LedgerSchema, type EventEnvelope } from "../../src/core/schema.js";

const REQ_ID = "REQ-TEST";

let cordRoot: string;

beforeEach(async () => {
  cordRoot = await mkdtemp(join(tmpdir(), "cord-doctor-"));
});

afterEach(async () => {
  await rm(cordRoot, { recursive: true, force: true });
});

function eventsPath(): string {
  return join(cordRoot, REQ_ID, EVENTS_FILE);
}

function ledgerPath(): string {
  return join(cordRoot, REQ_ID, LEDGER_FILE);
}

function proposePayload(entryId: string) {
  return {
    entry: {
      entry_id: entryId,
      title: `title ${entryId}`,
      anchors: [{ kind: "code" as const, anchor: "src/x.ts#f" }],
    },
  };
}

async function seedSession(count = 3) {
  const session = await initSession(cordRoot, REQ_ID);
  for (let index = 1; index <= count; index += 1) {
    await session.events.append(makeDraft(proposePayload(`C-00${index}`)));
  }
  await session.rebuildLedger();
  return session;
}

function makeDraft(payload: unknown) {
  return {
    event_id: ulid(),
    session_id: REQ_ID,
    type: "ledger.entry.proposed",
    schema_version: "1" as const,
    actor: { kind: "system" as const, id: "test" },
    correlation_id: null,
    payload,
    source: { adapter: "test" },
  };
}

async function readLines(): Promise<string[]> {
  const text = await readFile(eventsPath(), "utf8");
  return text.split("\n").filter((line) => line.length > 0);
}

async function writeLines(lines: string[]): Promise<void> {
  await writeFile(eventsPath(), lines.length === 0 ? "" : `${lines.join("\n")}\n`, "utf8");
}

function check(report: { checks: Array<{ name: string; ok: boolean; detail: string }> }, name: string) {
  const found = report.checks.find((item) => item.name === name);
  if (!found) throw new Error(`缺少检查项 ${name}`);
  return found;
}

describe("runDoctor：健康态", () => {
  it("四项校验全通过", async () => {
    const session = await seedSession(3);
    const report = await session.doctor();
    expect(report.ok).toBe(true);
    expect(report.checks.map((item) => item.name)).toEqual([
      "event_id_unique",
      "prev_event_hash_chain",
      "lineage_seq_contiguous",
      "ledger_projection_matches",
    ]);
    expect(report.checks.every((item) => item.ok)).toBe(true);
  });

  it("空事件流也是健康态", async () => {
    const session = await initSession(cordRoot, REQ_ID);
    const report = await session.doctor();
    expect(report.ok).toBe(true);
  });
});

describe("runDoctor：丢事件", () => {
  it("中间事件被删（前驱链断裂）→ 报错", async () => {
    await seedSession(4);
    const lines = await readLines();
    await writeLines([lines[0]!, lines[1]!, lines[3]!]);

    const report = await (await openSession(cordRoot, REQ_ID)).doctor();
    expect(report.ok).toBe(false);
    expect(check(report, "prev_event_hash_chain").ok).toBe(false);
    expect(check(report, "prev_event_hash_chain").detail).toContain("prev_event_hash");
  });

  it("血统内 seq 出现空洞（链仍连得上）→ 报错", async () => {
    const session = await seedSession(2);
    const events = await session.events.readAll();
    const tail = events[1]!;
    const fabricated: EventEnvelope = {
      ...tail,
      event_id: ulid(),
      seq: 5,
      prev_event_hash: hashEvent(tail),
      timestamp: "2026-09-24T00:00:05.000Z",
    };
    await writeLines([...(await readLines()), canonicalJson(fabricated)]);

    const report = await (await openSession(cordRoot, REQ_ID)).doctor();
    expect(report.ok).toBe(false);
    expect(check(report, "lineage_seq_contiguous").ok).toBe(false);
    expect(check(report, "lineage_seq_contiguous").detail).toContain("seq 不连续");
  });

  it("无法解析的整行（事件已不可读）→ 报错", async () => {
    await seedSession(2);
    await writeLines([...(await readLines()), '{"event_id":"x"}']);

    const report = await (await openSession(cordRoot, REQ_ID)).doctor();
    expect(report.ok).toBe(false);
    expect(check(report, "lineage_seq_contiguous").detail).toContain("不符合 EventEnvelope");
  });

  it("event_id 重复（union 合并未去重）→ 报错", async () => {
    const session = await seedSession(2);
    const events = await session.events.readAll();
    const duplicated = canonicalJson({
      ...events[0]!,
      seq: 3,
      prev_event_hash: null,
      timestamp: "2026-09-24T00:00:03.000Z",
    });
    await writeLines([...(await readLines()), duplicated]);

    const report = await (await openSession(cordRoot, REQ_ID)).doctor();
    expect(report.ok).toBe(false);
    expect(check(report, "event_id_unique").ok).toBe(false);
  });
});

describe("runDoctor：篡改与漂移", () => {
  it("事件被篡改（内容哈希不再匹配后续 prev）→ 报错", async () => {
    await seedSession(3);
    const lines = await readLines();
    const tampered = JSON.parse(lines[1]!) as EventEnvelope;
    tampered.actor = { kind: "system", id: "impostor" };
    await writeLines([lines[0]!, canonicalJson(tampered), lines[2]!]);

    const report = await (await openSession(cordRoot, REQ_ID)).doctor();
    expect(report.ok).toBe(false);
    expect(check(report, "prev_event_hash_chain").ok).toBe(false);
    expect(check(report, "ledger_projection_matches").ok).toBe(false);
  });

  it("ledger.yaml 被手工改状态（漂移）→ 报错，且 rebuild 后恢复一致", async () => {
    const session = await seedSession(2);
    const ledger = LedgerSchema.parse(YAML.parse(await readFile(ledgerPath(), "utf8")));
    ledger.entries[0]!.status = "confirmed";
    await writeFile(ledgerPath(), YAML.stringify(ledger), "utf8");

    const drifted = await (await openSession(cordRoot, REQ_ID)).doctor();
    expect(drifted.ok).toBe(false);
    expect(check(drifted, "ledger_projection_matches").ok).toBe(false);
    expect(check(drifted, "ledger_projection_matches").detail).toContain("rebuildLedger");

    await session.rebuildLedger();
    const healed = await (await openSession(cordRoot, REQ_ID)).doctor();
    expect(healed.ok).toBe(true);
  });

  it("ledger.yaml 丢失 → 自动重建且 doctor 通过", async () => {
    await seedSession(2);
    await rm(ledgerPath());
    const reopened = await openSession(cordRoot, REQ_ID);
    const ledger = await reopened.readLedger();
    expect(ledger.entries).toHaveLength(2);
    expect(ledger.entries[0]!.status).toBe("provisional");
    expect((await reopened.doctor()).ok).toBe(true);
  });

  it("ledger.yaml 不合法 → doctor 报错而不是抛错", async () => {
    await seedSession(1);
    await writeFile(ledgerPath(), "entries: not-a-list\n", "utf8");
    const report = await (await openSession(cordRoot, REQ_ID)).doctor();
    expect(report.ok).toBe(false);
    expect(check(report, "ledger_projection_matches").detail).toContain("ledger.yaml 不可读");
  });
});

describe("rebuildLedger：确定性幂等", () => {
  it("重复重建产出逐字节相同的文件", async () => {
    const session = await seedSession(3);
    const first = await session.rebuildLedger();
    const firstText = await readFile(ledgerPath(), "utf8");
    const second = await session.rebuildLedger();
    expect(await readFile(ledgerPath(), "utf8")).toBe(firstText);
    expect(second.output_hash).toBe(first.output_hash);
    expect(second.input_hash).toBe(first.input_hash);
  });

  it("文件行序被打乱也不影响重建结果（读侧按逻辑时钟排序）", async () => {
    const session = await seedSession(3);
    const before = await readFile(ledgerPath(), "utf8");
    const lines = await readLines();
    await writeLines([lines[2]!, lines[1]!, lines[0]!]);

    const rebuilt = await (await openSession(cordRoot, REQ_ID)).rebuildLedger();
    expect(await readFile(ledgerPath(), "utf8")).toBe(before);
    expect(rebuilt.entries.map((entry) => entry.entry_id)).toEqual(["C-001", "C-002", "C-003"]);
  });
});
