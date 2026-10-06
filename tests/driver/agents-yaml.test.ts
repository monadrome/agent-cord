/**
 * agents.yaml 自定义 agent 注册测试（ADR-0023 决策 6）：
 * 三种形态（acp / headless 模板定制 / headless 自定义 args）、逐条降级、
 * 叠加层解析优先于全局 registry、{{prompt}} 占位真实可跑（fake-cli fixture）。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { ResultEventData, TextEventData } from "../../src/driver/headless.js";
import {
  loadAgentsFile,
  parseAgentsYaml,
  registerAgentsYaml,
  resolveWithAgentsYaml,
} from "../../src/driver/agents-yaml.js";
import { AcpDriver, HeadlessDriver } from "../../src/driver/index.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-cli.mjs");

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmpFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "cord-agents-"));
  tmpDirs.push(dir);
  const file = join(dir, "agents.yaml");
  writeFileSync(file, content, "utf8");
  return file;
}

describe("parseAgentsYaml", () => {
  it("合法定义解析成功", () => {
    const { yaml } = parseAgentsYaml(`
agents:
  my-acp:
    kind: acp
    bin: my-agent
  my-claude:
    kind: headless
    template: claude
    bin: /opt/claude/bin/claude
    env: { ANTHROPIC_API_KEY: sk-test }
  my-tool:
    kind: headless
    bin: my-tool
    args: ["run", "{{prompt}}", "--json"]
`);
    expect(Object.keys(yaml?.agents ?? {})).toEqual(["my-acp", "my-claude", "my-tool"]);
  });

  it("整体非法 → 抛错带字段路径", () => {
    expect(() => parseAgentsYaml("agents: { bad one: {} }")).toThrow(/agents\./);
    expect(() => parseAgentsYaml("::: not yaml")).toThrow(/解析失败|schema/);
  });

  it("agent 名必须小写 kebab", () => {
    expect(() => parseAgentsYaml(`agents: { "Bad_Name": { kind: acp, bin: x } }`)).toThrow();
  });
});

describe("registerAgentsYaml（逐条降级）", () => {
  it("未知模板 → 该条 warning 跳过，其余正常注册", () => {
    const { yaml } = parseAgentsYaml(`
agents:
  ok-one: { kind: acp, bin: ok-agent }
  bad-one: { kind: headless, template: nope, bin: x }
  no-spec: { kind: headless, bin: x }
`);
    const result = registerAgentsYaml(yaml!);
    expect(result.registered).toContain("ok-one");
    expect(result.registered).not.toContain("bad-one");
    expect(result.registered).not.toContain("no-spec");
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[0]).toContain("未知 headless 模板");
  });

  it("模板不支持的旋钮 → warning 忽略但不阻断注册", () => {
    const { yaml } = parseAgentsYaml(`
agents:
  reviewer:
    kind: headless
    template: kimi
    bin: kimi
    model: k2
    system_prompt: 你是评审
`);
    const result = registerAgentsYaml(yaml!);
    expect(result.registered).toContain("reviewer");
    // kimi 支持 model、不支持 system_prompt → 恰好一条降级 warning
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("system_prompt");
  });

  it("自定义 args 形态配旋钮 → warning 提示不支持", () => {
    const { yaml } = parseAgentsYaml(`
agents:
  raw: { kind: headless, bin: x, args: ["run", "{{prompt}}"], model: m1 }
`);
    const result = registerAgentsYaml(yaml!);
    expect(result.registered).toContain("raw");
    expect(result.warnings[0]).toContain("自定义 args 形态不支持旋钮");
  });
});

describe("resolveWithAgentsYaml（叠加层）", () => {
  it("acp 条目 → AcpDriver，参数来自 yaml", () => {
    const { yaml } = parseAgentsYaml(`agents: { mine: { kind: acp, bin: my-bin, args: [serve] } }`);
    registerAgentsYaml(yaml!);
    const driver = resolveWithAgentsYaml(yaml)("mine");
    expect(driver).toBeInstanceOf(AcpDriver);
    expect(driver.name).toBe("acp:mine");
    expect((driver as AcpDriver).bin).toBe("my-bin");
    expect((driver as AcpDriver).args).toEqual(["serve"]);
  });

  it("headless 模板定制 → HeadlessDriver，bin 覆盖生效", () => {
    const { yaml } = parseAgentsYaml(`agents: { mine: { kind: headless, template: claude, bin: /opt/claude } }`);
    registerAgentsYaml(yaml!);
    const driver = resolveWithAgentsYaml(yaml)("mine") as HeadlessDriver;
    expect(driver).toBeInstanceOf(HeadlessDriver);
    const argv = driver.buildArgv({ prompt: "hi", cwd: "/tmp" });
    expect(argv[0]).toBe("/opt/claude");
    expect(argv).toContain("-p");
  });

  it("模板形态旋钮注入 argv（角色封装 = system_prompt → --append-system-prompt）", () => {
    const { yaml } = parseAgentsYaml(`
agents:
  reviewer:
    kind: headless
    template: claude
    bin: claude
    model: sonnet
    budget_usd: 2
    system_prompt: 你是资深代码评审，只看不改
`);
    registerAgentsYaml(yaml!);
    const driver = resolveWithAgentsYaml(yaml)("reviewer") as HeadlessDriver;
    const argv = driver.buildArgv({ prompt: "review", cwd: "/tmp" });
    expect(argv).toContain("--model");
    expect(argv[argv.indexOf("--model") + 1]).toBe("sonnet");
    expect(argv).toContain("--max-budget-usd");
    expect(argv[argv.indexOf("--append-system-prompt") + 1]).toContain("资深代码评审");
  });

  it("未命中叠加层 → 退回全局 registry", () => {
    const driver = resolveWithAgentsYaml(null)("headless:claude");
    expect(driver).toBeInstanceOf(HeadlessDriver);
  });

  it("自定义 args 模板真实可跑（{{prompt}} 占位替换）", async () => {
    const { yaml } = parseAgentsYaml(`
agents:
  fake:
    kind: headless
    bin: ${process.execPath}
    args: ["${fixture}", "--mode", "claude", "{{prompt}}"]
`);
    registerAgentsYaml(yaml!);
    const driver = resolveWithAgentsYaml(yaml)("fake");
    const events = [];
    for await (const event of driver.run({ prompt: "你好占位符", cwd: tmpdir() })) {
      events.push(event);
    }
    const init = events.find((event) => event.type === "text");
    expect(JSON.stringify((init?.data as TextEventData).raw)).toContain("你好占位符");
    const result = events.find((event) => event.type === "result");
    expect((result?.data as ResultEventData).text).toBe("final answer");
  });
});

describe("loadAgentsFile", () => {
  it("文件不存在 → 空结果（agents.yaml 可选）", async () => {
    const result = await loadAgentsFile(join(tmpdir(), "definitely-missing-agents.yaml"));
    expect(result.registered).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("存在则注册并返回清单", async () => {
    const file = tmpFile(`agents: { x1: { kind: acp, bin: x1-bin } }`);
    const result = await loadAgentsFile(file);
    expect(result.registered).toEqual(["x1"]);
  });
});
