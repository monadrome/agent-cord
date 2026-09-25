import type { ReactElement, ReactNode } from "react";

export type MarkdownBlock =
  | { kind: "heading"; level: number; content: string }
  | { kind: "paragraph"; content: string }
  | { kind: "unordered-list" | "ordered-list"; items: string[] }
  | { kind: "blockquote"; lines: string[] }
  | { kind: "code"; language: string; content: string }
  | { kind: "table"; headers: string[]; rows: string[][] }
  | { kind: "rule" };

type HeadingTag = "h1" | "h2" | "h3" | "h4" | "h5" | "h6";

const FENCE_RE = /^\s*```\s*([\w-]*)\s*$/;
const HEADING_RE = /^\s*(#{1,6})\s+(.+?)\s*#*\s*$/;
const UL_RE = /^\s*[-+*]\s+(.+)$/;
const OL_RE = /^\s*\d+[.)]\s+(.+)$/;
const QUOTE_RE = /^\s*>\s?(.*)$/;
const RULE_RE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;

/** 将常用 Markdown 块语法解析成安全的展示 AST；原始 HTML 会作为普通文本显示。 */
export function parseMarkdown(source: string): MarkdownBlock[] {
  const lines = source.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim() === "") {
      index += 1;
      continue;
    }

    const fence = FENCE_RE.exec(line);
    if (fence !== null) {
      const content: string[] = [];
      index += 1;
      while (index < lines.length && !FENCE_RE.test(lines[index] ?? "")) {
        content.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ kind: "code", language: fence[1] ?? "", content: content.join("\n") });
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading !== null) {
      blocks.push({ kind: "heading", level: heading[1]?.length ?? 1, content: heading[2] ?? "" });
      index += 1;
      continue;
    }

    if (RULE_RE.test(line)) {
      blocks.push({ kind: "rule" });
      index += 1;
      continue;
    }

    const quote = QUOTE_RE.exec(line);
    if (quote !== null) {
      const quoteLines: string[] = [];
      while (index < lines.length) {
        const current = QUOTE_RE.exec(lines[index] ?? "");
        if (current === null) break;
        quoteLines.push(current[1] ?? "");
        index += 1;
      }
      blocks.push({ kind: "blockquote", lines: quoteLines });
      continue;
    }

    const list = listItem(line);
    if (list !== null) {
      const items: string[] = [];
      const kind = list.kind;
      while (index < lines.length) {
        const current = listItem(lines[index] ?? "");
        if (current === null || current.kind !== kind) break;
        items.push(current.content);
        index += 1;
      }
      blocks.push({ kind, items });
      continue;
    }

    const table = parseTable(lines, index);
    if (table !== null) {
      blocks.push(table.block);
      index = table.nextIndex;
      continue;
    }

    const paragraph: string[] = [line.trim()];
    index += 1;
    while (index < lines.length) {
      const next = lines[index] ?? "";
      if (next.trim() === "" || startsBlock(next, lines[index + 1] ?? "")) break;
      paragraph.push(next.trim());
      index += 1;
    }
    blocks.push({ kind: "paragraph", content: paragraph.join("\n") });
  }

  return blocks;
}

function listItem(line: string): { kind: "unordered-list" | "ordered-list"; content: string } | null {
  const unordered = UL_RE.exec(line);
  if (unordered !== null) return { kind: "unordered-list", content: unordered[1] ?? "" };
  const ordered = OL_RE.exec(line);
  if (ordered !== null) return { kind: "ordered-list", content: ordered[1] ?? "" };
  return null;
}

function startsBlock(line: string, nextLine: string): boolean {
  return FENCE_RE.test(line) || HEADING_RE.test(line) || RULE_RE.test(line) || QUOTE_RE.test(line) || listItem(line) !== null || parseTable([line, nextLine], 0) !== null;
}

function parseTable(lines: string[], index: number): { block: MarkdownBlock; nextIndex: number } | null {
  const header = splitTableRow(lines[index] ?? "");
  const separator = splitTableRow(lines[index + 1] ?? "");
  if (header === null || separator === null || separator.length !== header.length || !separator.every((cell) => /^:?-{3,}:?$/.test(cell.trim()))) return null;

  const rows: string[][] = [];
  let nextIndex = index + 2;
  while (nextIndex < lines.length) {
    const row = splitTableRow(lines[nextIndex] ?? "");
    if (row === null || row.length !== header.length) break;
    rows.push(row);
    nextIndex += 1;
  }
  return { block: { kind: "table", headers: header, rows }, nextIndex };
}

function splitTableRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return null;
  const withoutEdges = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  const cells = withoutEdges.split("|").map((cell) => cell.trim());
  return cells.length >= 2 ? cells : null;
}

function safeHref(value: string): string | null {
  const href = value.trim();
  if (/^(https?:\/\/|mailto:|#|\.\/|\.\.\/)/i.test(href)) return href;
  if (href.startsWith("/") && !href.startsWith("//")) return href;
  return null;
}

function renderInline(value: string, keyPrefix: string): ReactNode[] {
  const token = /(`[^`]+`|\[[^\]]+\]\([^\s)]+(?:\s+[^)]+)?\)|\*\*[^*]+\*\*|__[^_]+__|~~[^~]+~~|\*[^*]+\*|_[^_]+_)/g;
  const result: ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  let tokenIndex = 0;

  while ((match = token.exec(value)) !== null) {
    if (match.index > cursor) result.push(...renderText(value.slice(cursor, match.index), `${keyPrefix}-text-${tokenIndex}`));
    const raw = match[0];
    const key = `${keyPrefix}-${tokenIndex}`;
    if (raw.startsWith("`") && raw.endsWith("`")) {
      result.push(<code key={key}>{raw.slice(1, -1)}</code>);
    } else if (raw.startsWith("[") && raw.includes("](")) {
      const link = /^\[([^\]]+)\]\(([^\s)]+)(?:\s+[^)]+)?\)$/.exec(raw);
      const href = link === null ? null : safeHref(link[2] ?? "");
      if (link !== null && href !== null) result.push(<a key={key} href={href} target="_blank" rel="noreferrer">{renderInline(link[1] ?? "", key)}</a>);
      else result.push(...renderText(raw, key));
    } else if (raw.startsWith("**") || raw.startsWith("__")) {
      result.push(<strong key={key}>{renderInline(raw.slice(2, -2), key)}</strong>);
    } else if (raw.startsWith("~~")) {
      result.push(<del key={key}>{renderInline(raw.slice(2, -2), key)}</del>);
    } else {
      result.push(<em key={key}>{renderInline(raw.slice(1, -1), key)}</em>);
    }
    cursor = match.index + raw.length;
    tokenIndex += 1;
  }
  if (cursor < value.length) result.push(...renderText(value.slice(cursor), `${keyPrefix}-tail`));
  return result;
}

function renderText(value: string, keyPrefix: string): ReactNode[] {
  const lines = value.split("\n");
  return lines.flatMap((line, index) => (index === 0 ? [line] : [<br key={`${keyPrefix}-br-${index}`} />, line]));
}

export function MarkdownPreview({ source }: { source: string }): ReactElement {
  const blocks = parseMarkdown(source);
  if (blocks.length === 0) return <div className="markdown-empty">暂无内容</div>;

  return (
    <article className="markdown-preview">
      {blocks.map((block, index) => {
        const key = `markdown-${index}`;
        switch (block.kind) {
          case "heading": {
            const Heading = `h${block.level}` as HeadingTag;
            return <Heading key={key}>{renderInline(block.content, key)}</Heading>;
          }
          case "paragraph":
            return <p key={key}>{renderInline(block.content, key)}</p>;
          case "unordered-list":
            return <ul key={key}>{block.items.map((item, itemIndex) => <li key={`${key}-${itemIndex}`}>{renderInline(item, `${key}-${itemIndex}`)}</li>)}</ul>;
          case "ordered-list":
            return <ol key={key}>{block.items.map((item, itemIndex) => <li key={`${key}-${itemIndex}`}>{renderInline(item, `${key}-${itemIndex}`)}</li>)}</ol>;
          case "blockquote":
            return <blockquote key={key}>{renderInline(block.lines.join("\n"), key)}</blockquote>;
          case "code":
            return <pre key={key}><code className={block.language === "" ? undefined : `language-${block.language}`}>{block.content}</code></pre>;
          case "table":
            return <table key={key}><thead><tr>{block.headers.map((header, itemIndex) => <th key={`${key}-h-${itemIndex}`}>{renderInline(header, `${key}-h-${itemIndex}`)}</th>)}</tr></thead><tbody>{block.rows.map((row, rowIndex) => <tr key={`${key}-r-${rowIndex}`}>{row.map((cell, cellIndex) => <td key={`${key}-r-${rowIndex}-${cellIndex}`}>{renderInline(cell, `${key}-r-${rowIndex}-${cellIndex}`)}</td>)}</tr>)}</tbody></table>;
          case "rule":
            return <hr key={key} />;
        }
      })}
    </article>
  );
}
