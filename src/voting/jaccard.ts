/**
 * 证据锚点独立度：规范化符号锚点 + 集合 Jaccard（ADR-0006 §关键实现注意点 4、ADR-0013 §8-9）。
 *
 * 比较口径只用「kind + 规范化锚点字符串」两个字段：`line_hint`（仅显示层）与 `snapshot`
 * （commit / lines / content_hash，存档层）一律不参与——行号既会漂移，也会巧合重合。
 */
import type { Anchor } from "../core/schema.js";

/** 规范化键：`<kind>:<anchor>`（空白裁剪；同一 kind 下的同名字符串视为同一锚点）。 */
export function normalizeAnchor(anchor: Anchor): string {
  return `${anchor.kind}:${anchor.anchor.trim()}`;
}

export interface AnchorOverlap {
  /** |A ∩ B| / |A ∪ B|；任一集合为空时定义为 0（不存在可比证据）。 */
  jaccard: number;
  /** 一方集合是另一方（含相等）的子集——独立度不足的第二种触发形态。 */
  subset: boolean;
}

export function anchorOverlap(a: readonly Anchor[], b: readonly Anchor[]): AnchorOverlap {
  const set_a = new Set(a.map(normalizeAnchor));
  const set_b = new Set(b.map(normalizeAnchor));
  if (set_a.size === 0 || set_b.size === 0) return { jaccard: 0, subset: false };

  let intersection = 0;
  for (const key of set_a) if (set_b.has(key)) intersection += 1;

  const union = set_a.size + set_b.size - intersection;
  return {
    jaccard: union === 0 ? 0 : intersection / union,
    subset: intersection === set_a.size || intersection === set_b.size,
  };
}
