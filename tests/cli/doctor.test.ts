import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ulid } from "ulid";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CORD_DIR, GITATTRIBUTES_LINE, MERGE_DRIVER_NAME, findMergeDriver, parseEventLog, runDoctor, runInit } from "../../src/cli.js";
import { buildEventDraft } from "../../src/adapters/cli.js";
import { initSession } from "../../src/core/session.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "cord-doctor-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function envelopeLine(session_id: string, seq: number, type = "session.created"): string {
  return JSON.stringify({
    event_id: ulid(),
    session_id,
    seq,
    prev_event_hash: seq === 1 ? null : "sha256:previous",
    type,
    schema_version: "1",
    timestamp: new Date().toISOString(),
    actor: { kind: "system", id: "core" },
    correlation_id: null,
    payload: {},
    source: { adapter: "cli" },
  });
}

async function writeSessionLog(session_id: string, content: string): Promise<string> {
  const dir = path.join(root, CORD_DIR, session_id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "events.jsonl"), content, "utf8");
  return dir;
}

describe("parseEventLog", () => {
  it("合法行全部解析，行序即文件序", () => {
    const result = parseEventLog([envelopeLine("REQ-A", 1), envelopeLine("REQ-A", 2)].join("\n"));

    expect(result.ok).toBe(true);
    expect(result.line_count).toBe(2);
    expect(result.events.map((event) => event.seq)).toEqual([1, 2]);
  });

  it("非法 JSON 行报出行号", () => {
    const result = parseEventLog(`${envelopeLine("REQ-A", 1)}\n{"oops": \n`);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/第 2 行/);
  });

  it("信封缺字段报出行号与字段路径", () => {
    const broken = JSON.parse(envelopeLine("REQ-A", 1)) as Record<string, unknown>;
    delete broken.seq;

    const result = parseEventLog(JSON.stringify(broken));

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/EventEnvelope v1/);
    expect(result.error).toMatch(/seq/);
  });
});

describe("findMergeDriver", () => {
  it("识别 [merge \"cord-event-log\"] 段内的 driver", () => {
    const config = ['[core]', '\trepositoryformatversion = 0', '[merge "cord-event-log"]', '\tdriver = node /tmp/driver.js %O %A %B', ''].join(
      "\n",
    );
    expect(findMergeDriver(config)).toBe("node /tmp/driver.js %O %A %B");
  });

  it("缺少 driver 或非 git 配置时返回 null", () => {
    expect(findMergeDriver(null)).toBeNull();
    expect(findMergeDriver('[core]\n\trepositoryformatversion = 0\n')).toBeNull();
    expect(findMergeDriver('[merge "cord-event-log"]\n\tname = cord\n')).toBeNull();
  });
});

describe("cord doctor", () => {
  it("cord/ 缺失时报 layout 失败并提示 init", async () => {
    const report = await runDoctor(root);

    expect(report.ok).toBe(false);
    expect(report.checks).toHaveLength(1);
    expect(report.checks[0]?.name).toBe("layout");
    expect(report.checks[0]?.detail).toContain("cord init");
  });

  it("init 后布局与 .gitattributes 检查通过", async () => {
    await runInit(root);

    const report = await runDoctor(root);
    const layout = report.checks.find((check) => check.name === "layout");
    const toml = report.checks.find((check) => check.name === `cord/cord.toml`);

    expect(layout?.ok).toBe(true);
    expect(toml?.ok).toBe(true);
    expect(toml?.detail).toContain("layout_version=1");
  });

  it("损坏的 events.jsonl 报错并给出行号", async () => {
    await runInit(root);
    await writeSessionLog("REQ-BROKEN", `${envelopeLine("REQ-BROKEN", 1)}\n{"event_id": "not-a-ulid"}\n`);

    const report = await runDoctor(root);
    const check = report.checks.find((entry) => entry.name === "session(REQ-BROKEN).events");

    expect(report.ok).toBe(false);
    expect(check?.ok).toBe(false);
    expect(check?.detail).toMatch(/第 2 行/);
    expect(check?.detail).toMatch(/EventEnvelope v1/);
  });

  it("非 git 仓库时跳过 merge driver 检查，git 仓库缺 driver 时报错", async () => {
    await runInit(root);
    const skipped = (await runDoctor(root)).checks.find((check) => check.name === "merge_driver");
    expect(skipped?.ok).toBe(true);
    expect(skipped?.detail).toContain("非 git 仓库");

    await mkdir(path.join(root, ".git"), { recursive: true });
    await writeFile(path.join(root, ".git", "config"), "[core]\n\trepositoryformatversion = 0\n", "utf8");

    const report = await runDoctor(root);
    const failed = report.checks.find((check) => check.name === "merge_driver");

    expect(failed?.ok).toBe(false);
    expect(failed?.detail).toContain("driver");
    expect(report.ok).toBe(false);
  });

  it("git 仓库已挂上 driver 时通过", async () => {
    await runInit(root);
    await mkdir(path.join(root, ".git"), { recursive: true });
    await writeFile(
      path.join(root, ".git", "config"),
      `[core]\n\trepositoryformatversion = 0\n[merge "cord-event-log"]\n\tname = cord\n\tdriver = node /tmp/driver.js %O %A %B\n`,
      "utf8",
    );

    const report = await runDoctor(root);
    const check = report.checks.find((entry) => entry.name === "merge_driver");

    expect(check?.ok).toBe(true);
    expect(check?.detail).toContain("/tmp/driver.js");
  });

  it("安装 merge driver 提示给出了可照抄的命令，装上后 doctor 转绿", async () => {
    await runInit(root);
    await mkdir(path.join(root, ".git"), { recursive: true });
    await writeFile(path.join(root, ".git", "config"), "[core]\n\trepositoryformatversion = 0\n", "utf8");

    const broken = await runDoctor(root);
    const detail = broken.checks.find((check) => check.name === "merge_driver")?.detail ?? "";
    expect(detail).toContain(`git config merge.cord-event-log.driver`);
    expect(detail).toContain(`merge.${MERGE_DRIVER_NAME}.driver`);

    // 属性行也被删掉时，提示必须同时指出两处缺失
    await rm(path.join(root, ".gitattributes"));
    const both_missing = (await runDoctor(root)).checks.find((check) => check.name === "merge_driver")?.detail ?? "";
    expect(both_missing).toContain(GITATTRIBUTES_LINE);

    await writeFile(path.join(root, ".gitattributes"), `${GITATTRIBUTES_LINE}\n`, "utf8");
    await writeFile(
      path.join(root, ".git", "config"),
      `[core]\n\trepositoryformatversion = 0\n[merge "cord-event-log"]\n\tname = cord events.jsonl union merge\n\tdriver = node /tmp/driver.js %O %A %B\n`,
      "utf8",
    );

    expect((await runDoctor(root)).ok).toBe(true);
  });

  it("尚未写入事件的 session 只报 events 检查，不误报损坏", async () => {
    await runInit(root);
    await mkdir(path.join(root, CORD_DIR, "REQ-EMPTY"), { recursive: true });

    const report = await runDoctor(root);
    const check = report.checks.find((entry) => entry.name === "session(REQ-EMPTY).events");

    expect(check?.ok).toBe(true);
    expect(check?.detail).toContain("无 events.jsonl");
    expect(report.sessions).toEqual(["REQ-EMPTY"]);
  });

  it("合法事件流的 session 通过 events 检查", async () => {
    await runInit(root);
    await writeSessionLog("REQ-OK", [envelopeLine("REQ-OK", 1), envelopeLine("REQ-OK", 2)].join("\n"));

    const report = await runDoctor(root);
    const check = report.checks.find((entry) => entry.name === "session(REQ-OK).events");

    expect(check?.ok).toBe(true);
    expect(check?.detail).toContain("2 条事件");
    expect(report.sessions).toEqual(["REQ-OK"]);
  });

  it("真实 session：core doctor 的四项检查按 session 前缀汇总，重建后全绿", async () => {
    await runInit(root);
    const session = await initSession(path.join(root, CORD_DIR), "REQ-LIVE");
    await session.events.append(
      buildEventDraft({
        session_id: "REQ-LIVE",
        type: "session.created",
        payload: {},
        actor: { kind: "system", id: "core" },
        source_adapter: "system",
      }),
    );

    // append 后未重建账本 → 投影漂移（ADR-0020 决策 4：doctor 重放比对，不一致即重建）
    const drift = await runDoctor(root);
    expect(drift.checks.map((check) => check.name)).toEqual(
      expect.arrayContaining([
        "session(REQ-LIVE).event_id_unique",
        "session(REQ-LIVE).prev_event_hash_chain",
        "session(REQ-LIVE).lineage_seq_contiguous",
        "session(REQ-LIVE).ledger_projection_matches",
      ]),
    );
    expect(
      drift.checks.find((check) => check.name === "session(REQ-LIVE).ledger_projection_matches")?.ok,
    ).toBe(false);

    await session.rebuildLedger();

    const healed = await runDoctor(root);
    expect(healed.ok).toBe(true);
  });

  it("--fix 重建漂移的 ledger.yaml", async () => {
    await runInit(root);
    const session = await initSession(path.join(root, CORD_DIR), "REQ-DRIFT");
    await session.events.append(
      buildEventDraft({
        session_id: "REQ-DRIFT",
        type: "ledger.entry.proposed",
        actor: { kind: "agent", id: "explore-agent" },
        payload: { entry_id: "C-1", title: "被手工改坏的账本", anchors: [{ kind: "doc", anchor: "README.md" }] },
      }),
    );
    await writeFile(
      path.join(root, CORD_DIR, "REQ-DRIFT", "ledger.yaml"),
      "reducer_version: '1'\ninput_hash: bogus\noutput_hash: bogus\nentries: []\n",
      "utf8",
    );

    const broken = await runDoctor(root);
    expect(broken.ok).toBe(false);
    expect(broken.fixed).toEqual([]);
    expect(broken.checks.find((check) => check.name === "session(REQ-DRIFT).ledger_projection_matches")?.ok).toBe(false);

    const repaired = await runDoctor(root, { fix: true });
    const rebuilt = await session.readLedger();

    expect(repaired.fixed).toEqual(["REQ-DRIFT"]);
    expect(repaired.ok).toBe(true);
    expect(rebuilt.entries.map((entry) => entry.entry_id)).toEqual(["C-1"]);
    expect(rebuilt.input_hash).not.toBe("bogus");
  });

  it("--fix 不改变损坏事件流的判定（无法重建）", async () => {
    await runInit(root);
    const dir = await writeSessionLog("REQ-BROKEN", "not json\n");

    const report = await runDoctor(root, { fix: true });

    expect(report.ok).toBe(false);
    expect(report.fixed).toEqual([]);
    expect(report.checks.find((entry) => entry.name === "session(REQ-BROKEN).events")?.ok).toBe(false);
    expect(existsSync(path.join(dir, "ledger.yaml"))).toBe(false);
  });
});
