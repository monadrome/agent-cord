import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createAnchorVerifier, runDemo, runEvents, splitAnchor } from "../../src/cli.js";

describe("锚点机验（demo 依赖的锚点解析）", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "cord-anchor-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("splitAnchor 拆出文件路径与符号", () => {
    expect(splitAnchor("src/a.ts#Foo.bar")).toEqual({ file_path: "src/a.ts", symbol: "Foo.bar" });
    expect(splitAnchor("docs/x.md")).toEqual({ file_path: "docs/x.md", symbol: null });
  });

  it("只承认临时目录里真实存在的文件与符号", async () => {
    await mkdir(path.join(root, "src", "demo"), { recursive: true });
    await writeFile(
      path.join(root, "src", "demo", "target.ts"),
      'export function resolveDemoTarget(): string {\n  return "demo";\n}\n',
      "utf8",
    );
    const verify = createAnchorVerifier(root);

    expect(await verify({ kind: "code", anchor: "src/demo/target.ts#resolveDemoTarget" })).toBe(true);
    expect(await verify({ kind: "code", anchor: "src/demo/target.ts" })).toBe(true);
    expect(await verify({ kind: "code", anchor: "src/demo/target.ts#missingSymbol" })).toBe(false);
    expect(await verify({ kind: "code", anchor: "src/demo/absent.ts#resolveDemoTarget" })).toBe(false);
    expect(await verify({ kind: "code", anchor: "src/demo" })).toBe(false);
    expect(await verify({ kind: "doc", anchor: "../../../etc/passwd" })).toBe(false);
  });
});

describe("cord demo · M2 最小闭环", () => {
  it("init → new → propose → k=2 盲评 → 内置 gate → ledger 一致 → doctor 全绿", async () => {
    const summary = await runDemo({ keep: true });
    try {
      expect(summary.session_id).toBe("REQ-DEMO");
      expect(summary.entry_id).toBe("C-1");
      expect(summary.ballots).toBe(2);
      expect(summary.verdict).toBe("confirmed");
      expect(summary.raw_agreement).toBe(1);
      expect(summary.anchor_overlap).toBe(0);
      expect(summary.gates).toEqual([
        { gate_id: "anchors-present", result: "pass", action: "continue" },
        { gate_id: "vote-confirmed", result: "pass", action: "continue" },
      ]);
      expect(summary.ledger_entries).toBe(1);
      expect(summary.ledger_consistent).toBe(true);
      expect(summary.doctor_ok).toBe(true);
    } finally {
      await rm(summary.root, { recursive: true, force: true });
    }
  });

  it("事件流按因果序落盘，ledger.yaml 与其投影一致", async () => {
    const summary = await runDemo({ keep: true });
    try {
      const log_path = path.join(summary.session_dir, "events.jsonl");
      const ledger_path = path.join(summary.session_dir, "ledger.yaml");
      expect(existsSync(log_path)).toBe(true);
      expect(existsSync(ledger_path)).toBe(true);

      const envelopes = (await readFile(log_path, "utf8"))
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as { type: string; seq: number; session_id: string });

      expect(envelopes.map((event) => event.type)).toEqual([
        "ledger.entry.proposed",
        "vote.completed",
        "gate.resolved",
        "gate.resolved",
        "ledger.entry.confirmed",
      ]);
      expect(envelopes.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5]);
      expect(envelopes.every((event) => event.session_id === "REQ-DEMO")).toBe(true);

      const ledger = await readFile(ledger_path, "utf8");
      expect(ledger).toContain("status: confirmed");
      expect(ledger).toContain("vote_agreement");
    } finally {
      await rm(summary.root, { recursive: true, force: true });
    }
  });

  it("cord events 按因果序打印事件流摘要", async () => {
    const summary = await runDemo({ keep: true });
    try {
      const result = await runEvents(path.dirname(path.dirname(summary.session_dir)), "REQ-DEMO");

      expect(result.count).toBe(5);
      expect(result.lines[0]).toContain("ledger.entry.proposed");
      expect(result.lines.at(-1)).toContain("ledger.entry.confirmed");
      expect(result.warning).toBeNull();
    } finally {
      await rm(summary.root, { recursive: true, force: true });
    }
  });

  it("事件流有坏行时 cord events 仍出可读事件，但给出告警而非静默当空流", async () => {
    const summary = await runDemo({ keep: true });
    try {
      await writeFile(
        path.join(summary.session_dir, "events.jsonl"),
        `${await readFile(path.join(summary.session_dir, "events.jsonl"), "utf8")}{"event_id":"not-a-ulid"}\n`,
        "utf8",
      );

      const result = await runEvents(path.dirname(path.dirname(summary.session_dir)), "REQ-DEMO");

      expect(result.count).toBe(5);
      expect(result.warning).toContain("无法解析的行");
      expect(result.warning).toContain("第 6 行");
    } finally {
      await rm(summary.root, { recursive: true, force: true });
    }
  });

  it("纯离线：demo 期间任何 fetch 调用都会失败（禁止网络调用）", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error("cord demo 不得发起网络调用");
    }) as typeof fetch;
    try {
      const summary = await runDemo({ keep: true });
      try {
        expect(summary.verdict).toBe("confirmed");
        expect(summary.doctor_ok).toBe(true);
      } finally {
        await rm(summary.root, { recursive: true, force: true });
      }
    } finally {
      globalThis.fetch = original;
    }
  });

  it("不清理临时目录时留痕（keep=true）", async () => {
    const summary = await runDemo({ keep: true });
    try {
      expect(existsSync(summary.root)).toBe(true);
      expect(existsSync(path.join(summary.root, "cord", "cord.toml"))).toBe(true);
      expect(existsSync(path.join(summary.root, "cord", "knowledge"))).toBe(true);
    } finally {
      await rm(summary.root, { recursive: true, force: true });
    }
  });
});
