/**
 * agents.yaml 自定义 agent 注册测试（ADR-0023 决策 6）：
 * 三种形态（acp / headless 模板定制 / headless 自定义 args）、逐条降级、
 * 叠加层解析优先于全局 registry、{{prompt}} 占位真实可跑（fake-cli fixture）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { ResultEventData, TextEventData } from "../../src/driver/headless.js";
import {
  loadAgentsFile,
  createAgentRegistry,
  parseAgentsYaml,
  registerAgentsYaml,
  resolveWithAgentsYaml,
} from "../../src/driver/agents-yaml.js";
import { AcpDriver, HeadlessDriver, getHeadlessCliTemplate, registerHeadlessCliTemplate, resolveDriver } from "../../src/driver/index.js";

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

  it("顶层非法或 YAML 语法错误 → 抛错", () => {
    expect(() => parseAgentsYaml("agents: []")).toThrow(/schema/);
    expect(() => parseAgentsYaml("::: not yaml")).toThrow(/解析失败|schema/);
  });

  it("单条非法配置按字段告警，其他条目仍可用，错误别名不能退回内置 driver", () => {
    const parsed = parseAgentsYaml(`
agents:
  valid: { kind: acp, bin: x }
  Bad_Name: { kind: acp, bin: x }
  claude: { kind: acp, bin: 42 }
`);
    expect(parsed.warnings).toHaveLength(2);
    expect(parsed.warnings[1]).toContain("agents.claude.bin");
    expect(parsed.rejected).toEqual(["Bad_Name", "claude"]);
    const registry = createAgentRegistry(parsed.yaml);
    expect(registry.resolve("valid")).toBeInstanceOf(AcpDriver);
    expect(() => registry.resolve("claude")).toThrow(/配置无效/);
    expect(() => registry.resolve("headless:claude")).toThrow(/配置无效/);
    expect(registry.list().some((entry) => entry.name === "claude")).toBe(false);
  });

  it("YAML 解析错误不含原文内容", () => {
    const marker = "PRIVATE_TEST_VALUE";
    let message = "";
    try {
      parseAgentsYaml(`agents: [${marker}`);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("解析失败");
    expect(message).not.toContain(marker);
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
    const argv = (resolveWithAgentsYaml(yaml)("reviewer") as HeadlessDriver).buildArgv({ prompt: "p", cwd: "/tmp" });
    expect(argv).toContain("k2");
    expect(argv).not.toContain("你是评审");
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
  it("两个工作区同名自定义 args 互不覆盖，也不修改全局模板", () => {
    const first = parseAgentsYaml(`agents: { local-only: { kind: headless, bin: bin-a, args: ["A", "{{prompt}}"] } }`);
    registerAgentsYaml(first.yaml);
    const resolve_first = resolveWithAgentsYaml(first.yaml);
    const second = parseAgentsYaml(`agents: { local-only: { kind: headless, bin: bin-b, args: ["B", "{{prompt}}"] } }`);
    registerAgentsYaml(second.yaml);
    const resolve_second = resolveWithAgentsYaml(second.yaml);
    expect((resolve_first("local-only") as HeadlessDriver).buildArgv({ prompt: "p", cwd: "/tmp" })).toEqual(["bin-a", "A", "p"]);
    expect((resolve_second("local-only") as HeadlessDriver).buildArgv({ prompt: "p", cwd: "/tmp" })).toEqual(["bin-b", "B", "p"]);
    expect(getHeadlessCliTemplate("local-only")).toBeUndefined();
    expect(() => resolveWithAgentsYaml(null)("local-only")).toThrow(/no driver/);
  });

  it("工作区覆盖内置 agent 时，内置模板与其他工作区仍独立", () => {
    const parsed = parseAgentsYaml(`agents: { claude: { kind: headless, bin: wrapped, args: ["wrapped", "{{prompt}}"] } }`);
    const local = resolveWithAgentsYaml(parsed.yaml);
    expect((local("claude") as HeadlessDriver).buildArgv({ prompt: "p", cwd: "/tmp" })).toEqual(["wrapped", "wrapped", "p"]);
    expect((local("headless:claude") as HeadlessDriver).buildArgv({ prompt: "p", cwd: "/tmp" })).toEqual(["wrapped", "wrapped", "p"]);
    expect(() => local("acp:claude")).toThrow(/不能/);
    expect((resolveDriver("claude") as HeadlessDriver).buildArgv({ prompt: "p", cwd: "/tmp" })[0]).toBe("claude");
  });

  it("已构造的 driver 固定模板与旋钮，后续全局注册不改变参数", () => {
    registerHeadlessCliTemplate({ name: "pinned-test", bin: "old", args: ({ prompt }) => ["old", prompt] });
    const driver = new HeadlessDriver({ cli: "pinned-test" });
    registerHeadlessCliTemplate({ name: "pinned-test", bin: "new", args: () => ["new"] });
    expect(driver.buildArgv({ prompt: "p", cwd: "/tmp" })).toEqual(["old", "old", "p"]);
  });

  it("模板形态可省略 bin；无效 template/args 组合不能回退到内置 agent", () => {
    const parsed = parseAgentsYaml(`agents: { wrapper: { kind: headless, template: codex }, codex: { kind: headless, template: codex, args: [x] } }`);
    const registry = createAgentRegistry(parsed.yaml);
    expect((registry.resolve("wrapper") as HeadlessDriver).buildArgv({ prompt: "p", cwd: "/tmp" })[0]).toBe("codex");
    expect(() => registry.resolve("codex")).toThrow(/配置无效/);
  });

  it("解析后的配置对象变化不会修改已经编译的 resolver", () => {
    const parsed = parseAgentsYaml(`agents: { wrapper: { kind: headless, template: claude, model: first }, raw: { kind: headless, bin: old-bin, args: [old] } }`);
    const registry = createAgentRegistry(parsed.yaml);
    const wrapper = parsed.yaml.agents.wrapper;
    const raw = parsed.yaml.agents.raw;
    if (wrapper?.kind !== "headless" || raw?.kind !== "headless") throw new Error("测试配置错误");
    wrapper.model = "changed";
    raw.args![0] = "changed";
    expect((registry.resolve("wrapper") as HeadlessDriver).buildArgv({ prompt: "p", cwd: "/tmp" })).toContain("first");
    expect((registry.resolve("raw") as HeadlessDriver).buildArgv({ prompt: "p", cwd: "/tmp" })).toEqual(["old-bin", "old"]);
  });

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

  it("IO 错误必须上报，不能把目录当作缺失配置", async () => {
    const file = tmpFile("agents: {}");
    rmSync(file);
    mkdirSync(file);
    await expect(loadAgentsFile(file)).rejects.toThrow(/读取失败/);
  });
});
