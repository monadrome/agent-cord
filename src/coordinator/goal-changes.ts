/** ADR-0071：纯源码摘要/变更计算与 ready 重算，不读取文件或 Git。 */
import { canonicalJson, sha256Hex } from "../core/hash.js";
import { GoalChangeEvidenceSchema, GoalChangeSummarySchema, SourceManifestSchema, type GoalChangeEvidence, type GoalChangeSummary, type SourceManifest } from "../core/schema.js";

export function source_manifest_hash(manifest: SourceManifest): string {
  return sha256Hex(canonicalJson({ domain: "cord.verification-source.v1", entries: SourceManifestSchema.parse(manifest) }));
}

export function goal_change_evidence(baseline_event_id: string, baseline: SourceManifest, current: SourceManifest): GoalChangeEvidence {
  const before = new Map(SourceManifestSchema.parse(baseline).map(entry => [entry.path, entry]));
  const after = new Map(SourceManifestSchema.parse(current).map(entry => [entry.path, entry]));
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  const changes = paths.flatMap(path => {
    const previous = before.get(path) ?? null; const next = after.get(path) ?? null;
    if (canonicalJson(previous) === canonicalJson(next)) return [];
    return [{ path, status: previous === null ? "added" : next === null ? "deleted" : "modified", before: previous, after: next }];
  });
  return GoalChangeEvidenceSchema.parse({ baseline_event_id, baseline_source_hash: source_manifest_hash(baseline), changes });
}

export function goal_changes_are_complete(evidence: GoalChangeEvidence, baseline_event_id: string, baseline: SourceManifest, target_hash: string): boolean {
  try {
    const checked = GoalChangeEvidenceSchema.parse(evidence);
    if (checked.baseline_event_id !== baseline_event_id || checked.baseline_source_hash !== source_manifest_hash(baseline)) return false;
    const entries = new Map(SourceManifestSchema.parse(baseline).map(entry => [entry.path, entry]));
    for (const change of checked.changes) {
      if (canonicalJson(entries.get(change.path) ?? null) !== canonicalJson(change.before)
        || canonicalJson(change.before) === canonicalJson(change.after)) return false;
      if (change.after === null) entries.delete(change.path); else entries.set(change.path, change.after);
    }
    const current = [...entries.values()].sort((first, second) => first.path < second.path ? -1 : first.path > second.path ? 1 : 0);
    return source_manifest_hash(current) === target_hash;
  } catch { return false; }
}

/** 调用方先核验完整 ready；纯摘要不承担来源或当前新鲜度认证。 */
export function goal_change_summary(evidence: GoalChangeEvidence, source_hash: string): GoalChangeSummary {
  const checked = GoalChangeEvidenceSchema.parse(evidence);
  return GoalChangeSummarySchema.parse({
    baseline_event_id: checked.baseline_event_id, baseline_source_hash: checked.baseline_source_hash, source_hash,
    evidence_hash: sha256Hex(canonicalJson({ domain: "cord.goal-change-summary.v1", evidence: checked, source_hash })),
    total_changes: checked.changes.length,
    added: checked.changes.filter(change => change.status === "added").length,
    modified: checked.changes.filter(change => change.status === "modified").length,
    deleted: checked.changes.filter(change => change.status === "deleted").length,
    sample: checked.changes.slice(0, 16).map(({ path, status }) => ({ path, status })),
    omitted_changes: Math.max(0, checked.changes.length - 16),
  });
}

export function render_goal_changes(evidence: GoalChangeEvidence, source_hash: string): string {
  const checked = GoalChangeEvidenceSchema.parse(evidence);
  const labels = { added: "新增", modified: "修改", deleted: "删除" } as const;
  const escape = (path: string) => path.replace(/[\\|`*_\[\]<>]/gu, character => "\\" + character);
  const identity = (entry: GoalChangeEvidence["changes"][number]["before"]) => entry === null ? "不存在"
    : `${entry.kind === "file" ? entry.content_hash.slice(0, 12) : "目录"}; mode=${entry.mode.toString(8)}`;
  return `\n\n## 宿主源码变更\n\n- 基线事件：${checked.baseline_event_id}\n- 基线 source_hash：${checked.baseline_source_hash}\n- 被测 source_hash：${source_hash}\n- 仅比较声明的验证源码范围；原有代码属于基线，不推断范围外变更或作者归属。\n\n`
    + (checked.changes.length === 0 ? "声明范围内源码相对基线无变更。\n" : "表内文件摘要为前 12 位；完整元信息保存在基线和 ready 事件中。\n\n| 路径 | 状态 | 基线摘要 | 被测摘要 |\n|---|---|---|---|\n"
      + checked.changes.map(change => `| ${escape(change.path)} | ${labels[change.status]} | ${identity(change.before)} | ${identity(change.after)} |`).join("\n") + "\n");
}
