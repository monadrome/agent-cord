/** 文档片段的范围、预算与省略必须可对照原文核验。 */
import { describe, expect, it } from "vitest";
import { buildCoordinationDocuments } from "../../src/coordinator/coordination-context.js";
import { sliceDocumentExcerpt, type SnapshotDoc } from "../../src/coordinator/snapshot.js";

function doc(file: string, content: string): SnapshotDoc {
  return { file, content, content_length: content.length, content_hash: "a".repeat(64), exists: true, truncated: false };
}
function index(text: string): Array<{ file: string; included_chars: number; omitted_chars: number; ranges: Array<[number, number]> }> {
  return JSON.parse(text.split("\n").find((line) => line.startsWith("document_excerpts: "))!.slice("document_excerpts: ".length));
}

describe("协调文档预算", () => {
  it("短文档的剩余额度回流，长文档保留首尾且计数与原文范围一致", () => {
    const docs = [doc("short.md", "SHORT_DOCUMENT"), doc("first.md", "FIRST_HEAD\n" + "x".repeat(10_000) + "\nFIRST_TAIL"),
      doc("second.md", "SECOND_HEAD\n" + "y".repeat(10_000) + "\nSECOND_TAIL")];
    const text = buildCoordinationDocuments(docs, 3_000);
    expect(text.length).toBeLessThanOrEqual(3_000);
    const entries = index(text);
    expect(entries[0]).toMatchObject({ included_chars: docs[0]!.content_length, omitted_chars: 0 });
    expect(entries[1]!.included_chars).toBeGreaterThan(700);
    expect(Math.abs(entries[1]!.included_chars - entries[2]!.included_chars)).toBeLessThanOrEqual(1);
    for (const entry of entries) {
      const original = docs.find((item) => item.file === entry.file)!.content;
      expect(entry.included_chars + entry.omitted_chars).toBe(original.length);
      expect(entry.ranges.reduce((sum, [start, end]) => sum + end - start, 0)).toBe(entry.included_chars);
      for (const [start, end] of entry.ranges) expect(text.includes(original.slice(start, end))).toBe(true);
    }
    for (const marker of ["SHORT_DOCUMENT", "FIRST_HEAD", "FIRST_TAIL", "SECOND_HEAD", "SECOND_TAIL"]) expect(text.includes(marker)).toBe(true);
  });

  it("空/缺失文档只有定位元信息，片段索引为空；过小预算拒绝", () => {
    const docs = [doc("empty.md", ""), { ...doc("absent.md", ""), exists: false }];
    expect(index(buildCoordinationDocuments(docs, 100))).toEqual([]);
    expect(() => buildCoordinationDocuments([doc("large.md", "x".repeat(1_000))], 10)).toThrow(/预算/);
  });

  it("采集与最终截断不拆开 Unicode 代理对，范围仍为 UTF-16 原文偏移", () => {
    const face = "\ud83d\ude00";
    const original = "aa" + face + "x".repeat(1_000) + face + "zz";
    const head = sliceDocumentExcerpt(original, 0, 3);
    const tail = sliceDocumentExcerpt(original, original.length - 3, original.length);
    expect(head).toEqual({ start: 0, end: 2, text: "aa" });
    expect(tail.text).toBe("zz");
    const text = buildCoordinationDocuments([doc("unicode.md", original)], 500);
    expect(text).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
    for (const [start, end] of index(text)[0]!.ranges) expect(text.includes(original.slice(start, end))).toBe(true);
  });
});
