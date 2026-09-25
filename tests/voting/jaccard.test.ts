import { describe, expect, it } from "vitest";

import type { Anchor } from "../../src/core/schema.js";
import { anchorOverlap, normalizeAnchor } from "../../src/voting/jaccard.js";

function code(path: string, extra: Partial<Anchor> = {}): Anchor {
  return { kind: "code", anchor: path, ...extra };
}

describe("normalizeAnchor", () => {
  it("只用 kind + anchor 字符串，忽略 line_hint 与 snapshot（行号会漂移、也会巧合重合）", () => {
    const a = code("src/x.ts#X.a", { line_hint: "x.ts:12", snapshot: { commit: "aaa", lines: "10-20" } });
    const b = code("src/x.ts#X.a", { line_hint: "x.ts:999", snapshot: { commit: "bbb" } });
    expect(normalizeAnchor(a)).toBe(normalizeAnchor(b));
    expect(normalizeAnchor(a)).toBe("code:src/x.ts#X.a");
  });

  it("裁剪首尾空白，但保留 kind 的区分度", () => {
    expect(normalizeAnchor(code("  src/x.ts#X.a  "))).toBe("code:src/x.ts#X.a");
    expect(normalizeAnchor(code("src/x.ts#X.a"))).not.toBe(normalizeAnchor({ kind: "test", anchor: "src/x.ts#X.a" }));
  });
});

describe("anchorOverlap", () => {
  it("集合语义：同一票里的重复锚点只算一次", () => {
    const a = [code("src/x.ts#X.a"), code("src/x.ts#X.a")];
    const b = [code("src/x.ts#X.a")];
    expect(anchorOverlap(a, b)).toEqual({ jaccard: 1, subset: true });
  });

  it("完全相同 → jaccard 1 且互为子集", () => {
    const a = [code("src/x.ts#X.a"), { kind: "test", anchor: "tests/x.test.ts#case-1" }];
    const b = [code("src/x.ts#X.a"), { kind: "test", anchor: "tests/x.test.ts#case-1" }];
    expect(anchorOverlap(a, b)).toEqual({ jaccard: 1, subset: true });
  });

  it("各自引不同证据 → jaccard 0、非子集（一致 + 锚点不同是健康信号）", () => {
    expect(anchorOverlap([code("src/a.ts#A")], [code("src/b.ts#B")])).toEqual({ jaccard: 0, subset: false });
  });

  it("子集关系：jaccard 可以低于阈值，但仍判为独立度不足", () => {
    const a = [code("src/a.ts#A")];
    const b = [code("src/a.ts#A"), code("src/b.ts#B"), code("src/c.ts#C")];
    const result = anchorOverlap(a, b);
    expect(result.jaccard).toBeCloseTo(1 / 3, 10);
    expect(result.subset).toBe(true);
  });

  it("部分重合既非子集也未达阈值", () => {
    const a = [code("src/a.ts#A"), code("src/b.ts#B")];
    const b = [code("src/a.ts#A"), code("src/c.ts#C")];
    expect(anchorOverlap(a, b)).toEqual({ jaccard: 1 / 3, subset: false });
  });

  it("忽略 line_hint/snapshot 差异（同一符号锚点算重合）", () => {
    const a = [code("src/a.ts#A", { line_hint: "a.ts:1" })];
    const b = [code("src/a.ts#A", { snapshot: { commit: "zzz" } })];
    expect(anchorOverlap(a, b).jaccard).toBe(1);
  });

  it("空集合不产生「重合」（任一方无锚点时 jaccard 0）", () => {
    expect(anchorOverlap([], [code("src/a.ts#A")])).toEqual({ jaccard: 0, subset: false });
    expect(anchorOverlap([], [])).toEqual({ jaccard: 0, subset: false });
  });
});
