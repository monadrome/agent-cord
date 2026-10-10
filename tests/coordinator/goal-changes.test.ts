import { describe, expect, it } from "vitest";
import { ulid } from "ulid";
import { sha256Hex } from "../../src/core/hash.js";
import { SourceManifestSchema, type SourceManifest } from "../../src/core/schema.js";
import { goal_change_evidence, goal_changes_are_complete, render_goal_changes, source_manifest_hash } from "../../src/coordinator/goal-changes.js";

const event_id = ulid();
const baseline: SourceManifest = [
  { path: "src", kind: "directory", mode: 0o755 },
  { path: "src/a.ts", kind: "file", mode: 0o644, content_hash: sha256Hex("before") },
  { path: "src/deleted.ts", kind: "file", mode: 0o644, content_hash: sha256Hex("delete") },
];
const current: SourceManifest = [
  { path: "src", kind: "directory", mode: 0o755 },
  { path: "src/a.ts", kind: "file", mode: 0o755, content_hash: sha256Hex("after") },
  { path: "src/new.ts", kind: "file", mode: 0o644, content_hash: sha256Hex("added") },
];

describe("Goal 宿主源码变更证据", () => {
  it("按真实路径排序列出新增/修改/删除并重算被测身份", () => {
    const evidence = goal_change_evidence(event_id, baseline, current);
    expect(evidence.changes.map(change => [change.path, change.status])).toEqual([["src/a.ts", "modified"], ["src/deleted.ts", "deleted"], ["src/new.ts", "added"]]);
    expect(goal_changes_are_complete(evidence, event_id, baseline, source_manifest_hash(current))).toBe(true);
    const guide = render_goal_changes(evidence, source_manifest_hash(current));
    expect(guide).toContain("宿主源码变更"); expect(guide).toContain(event_id);
    expect(guide).toContain("新增"); expect(guide).toContain("删除"); expect(guide).not.toContain("before");
    expect(guide).toContain(sha256Hex("after").slice(0, 12)); expect(guide).not.toContain(sha256Hex("after"));
  });

  it.each(["missing", "wrong_baseline", "wrong_target", "duplicate", "forged_before", "forged_after"])("拒绝 %s 清单，不把部分清单当完整", mode => {
    const evidence = goal_change_evidence(event_id, baseline, current);
    if (mode === "missing") evidence.changes.pop();
    if (mode === "wrong_baseline") evidence.baseline_event_id = ulid();
    if (mode === "duplicate") evidence.changes.push(evidence.changes[0]!);
    if (mode === "forged_before") evidence.changes[0]!.before = null;
    if (mode === "forged_after") evidence.changes[0]!.after = baseline[1]!;
    expect(goal_changes_are_complete(evidence, event_id, baseline, mode === "wrong_target" ? "f".repeat(64) : source_manifest_hash(current))).toBe(false);
  });

  it("权限和目录/文件类型变化仍是修改，空变更只能证明相同源码", () => {
    const next = structuredClone(baseline); next[1] = { path: "src/a.ts", kind: "directory", mode: 0o755 };
    const evidence = goal_change_evidence(event_id, baseline, next);
    expect(evidence.changes).toHaveLength(1); expect(evidence.changes[0]!.status).toBe("modified");
    expect(goal_changes_are_complete(evidence, event_id, baseline, source_manifest_hash(next))).toBe(true);
    const empty = goal_change_evidence(event_id, baseline, baseline);
    expect(empty.changes).toEqual([]); expect(render_goal_changes(empty, source_manifest_hash(baseline))).toContain("无变更");
    expect(goal_changes_are_complete(empty, event_id, baseline, source_manifest_hash(current))).toBe(false);
  });

  it("清单拒绝重复/逆序/非法路径与超量元信息，不生成部分身份", () => {
    for (const entries of [[], [baseline[1]!, baseline[0]!], [baseline[0]!, baseline[0]!], [{ ...baseline[0], path: "../outside" }]]) expect(SourceManifestSchema.safeParse(entries).success).toBe(false);
    const large = Array.from({ length: 2000 }, (_, index) => ({ path: "p" + String(index).padStart(4, "0") + "a".repeat(900), kind: "directory", mode: 0o755 }));
    expect(SourceManifestSchema.safeParse(large).success).toBe(false);
  });
});
