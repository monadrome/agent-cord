import { describe, expect, it } from "vitest";
import { parseMarkdown } from "../src/markdown.js";

describe("Markdown 预览解析", () => {
  it("解析标题、列表、引用和代码块", () => {
    expect(parseMarkdown("# 标题\n\n- 一\n- 二\n\n> 引用\n\n```ts\nconst ok = true;\n```")).toEqual([
      { kind: "heading", level: 1, content: "标题" },
      { kind: "unordered-list", items: ["一", "二"] },
      { kind: "blockquote", lines: ["引用"] },
      { kind: "code", language: "ts", content: "const ok = true;" },
    ]);
  });

  it("解析 GFM 表格并保留段落换行", () => {
    expect(parseMarkdown("说明第一行\n说明第二行\n\n| 项目 | 状态 |\n| --- | :---: |\n| 控制台 | 完成 |")) .toEqual([
      { kind: "paragraph", content: "说明第一行\n说明第二行" },
      { kind: "table", headers: ["项目", "状态"], rows: [["控制台", "完成"]] },
    ]);
  });
});
