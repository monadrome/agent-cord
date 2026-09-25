import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CORD_DIR,
  GITATTRIBUTES_LINE,
  MERGE_DRIVER_NAME,
  renderCordToml,
  runInit,
} from "../../src/cli.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "cord-init-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function countLines(content: string, expected: string): number {
  return content.split("\n").filter((line) => line.trim() === expected).length;
}

describe("cord init", () => {
  it("建 cord/、cord/cord.toml（布局版本 + 事件 schema 版本）与 cord/knowledge/", async () => {
    const result = await runInit(root);

    expect(existsSync(path.join(root, CORD_DIR))).toBe(true);
    expect(existsSync(path.join(root, CORD_DIR, "knowledge"))).toBe(true);
    expect(result.created).toEqual(
      expect.arrayContaining(["cord", "cord/knowledge", "cord/cord.toml", ".gitattributes"]),
    );

    const toml = await readFile(path.join(root, CORD_DIR, "cord.toml"), "utf8");
    expect(toml).toMatch(/^layout_version\s*=\s*1$/m);
    expect(toml).toMatch(/^event_schema_version\s*=\s*"1"$/m);
    expect(toml).toMatch(/^apiVersion\s*=\s*"agent-cord\.dev\/v1alpha1"$/m);
  });

  it("注册 cord/**/events.jsonl 的 merge driver 属性", async () => {
    const result = await runInit(root);

    const attributes = await readFile(path.join(root, ".gitattributes"), "utf8");
    expect(countLines(attributes, GITATTRIBUTES_LINE)).toBe(1);
    expect(GITATTRIBUTES_LINE).toBe(`cord/**/events.jsonl merge=${MERGE_DRIVER_NAME}`);

    const commands = result.merge_driver_commands.join("\n");
    expect(commands).toContain(`git config merge.${MERGE_DRIVER_NAME}.name`);
    expect(commands).toContain(`git config merge.${MERGE_DRIVER_NAME}.driver "node`);
    expect(commands).toContain("%O %A %B");
  });

  it("幂等：重复执行不重复写文件、不重复注册属性", async () => {
    const first = await runInit(root);
    const toml_before = await readFile(path.join(root, CORD_DIR, "cord.toml"), "utf8");
    const attributes_before = await readFile(path.join(root, ".gitattributes"), "utf8");

    const second = await runInit(root);

    expect(second.created).toEqual([]);
    expect(second.skipped).toEqual(
      expect.arrayContaining(["cord", "cord/knowledge", "cord/cord.toml", ".gitattributes"]),
    );
    expect(await readFile(path.join(root, CORD_DIR, "cord.toml"), "utf8")).toBe(toml_before);
    expect(await readFile(path.join(root, ".gitattributes"), "utf8")).toBe(attributes_before);
    expect(countLines(attributes_before, GITATTRIBUTES_LINE)).toBe(1);
    expect(first.changed).toEqual([]);
  });

  it("已有 .gitattributes 内容被保留，只追加一行属性", async () => {
    await writeFile(path.join(root, ".gitattributes"), "*.png binary\n", "utf8");

    const result = await runInit(root);
    const attributes = await readFile(path.join(root, ".gitattributes"), "utf8");

    expect(attributes.startsWith("*.png binary\n")).toBe(true);
    expect(countLines(attributes, GITATTRIBUTES_LINE)).toBe(1);
    expect(result.changed).toContain(".gitattributes");
    expect(result.created).not.toContain(".gitattributes");
  });

  it("cord.toml 与 .gitattributes 属性行来自同一模板", () => {
    const toml = renderCordToml();
    expect(toml).toContain(`path = "cord/.index"`);
    expect(toml).toContain("[documents]");
  });
});
