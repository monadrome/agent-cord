/** 有效启动身份：跨构造稳定、参数变化生效、env 不参与（ADR-0031）。 */
import { describe, expect, it } from "vitest";
import { AcpDriver } from "../../src/driver/acp.js";
import { HeadlessDriver } from "../../src/driver/headless.js";
import { parseAgentsYaml, resolveWithAgentsYaml } from "../../src/driver/agents-yaml.js";

describe("agent 配置身份", () => {
  it.each(["headless", "acp"])("%s 上下文版本改变身份但环境值不进入版本身份", (kind) => {
    const make = (context_revision: number, marker: string) => kind === "acp" ? new AcpDriver({ bin: "tool", context_revision, env: { PRIVATE_TEST: marker } })
      : new HeadlessDriver({ cli: "claude", context_revision, env: { PRIVATE_TEST: marker } });
    expect(make(1, "PRIVATE_FIRST").configuration_hash).toBe(make(1, "PRIVATE_SECOND").configuration_hash);
    expect(make(2, "PRIVATE_SECOND").configuration_hash).not.toBe(make(1, "PRIVATE_FIRST").configuration_hash);
    if (kind === "headless") expect((make(1, "PRIVATE_FIRST") as HeadlessDriver).buildArgv({ cwd: "/tmp", prompt: "任务" })).toEqual((make(2, "PRIVATE_SECOND") as HeadlessDriver).buildArgv({ cwd: "/tmp", prompt: "任务" }));
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("原生上下文版本 %s 必须是正安全整数", (context_revision) => {
    expect(() => new HeadlessDriver({ cli: "claude", context_revision })).toThrow();
    expect(() => new AcpDriver({ bin: "tool", context_revision })).toThrow();
  });

  it.each(["acp", "template", "args"])("YAML %s 上下文版本可解析且参与身份，省略仍兼容", (kind) => {
    const entry = kind === "acp" ? "kind: acp, bin: tool" : kind === "template" ? "kind: headless, template: claude" : 'kind: headless, bin: tool, args: ["{{prompt}}"]';
    const load = (version: number) => parseAgentsYaml(`agents: { worker: { ${entry}, context_revision: ${version} } }`);
    expect(load(1).rejected).toEqual([]);
    const first = resolveWithAgentsYaml(load(1).yaml)("worker"); const second = resolveWithAgentsYaml(load(2).yaml)("worker");
    expect(first.configuration_hash).not.toBe(second.configuration_hash);
  });

  it("非法 YAML 上下文版本拒绝别名且不回退内置，同版本格式不改变身份", () => {
    const invalid = parseAgentsYaml("agents: { claude: { kind: headless, template: claude, context_revision: 0 } }");
    expect(invalid.rejected).toEqual(["claude"]); expect(() => resolveWithAgentsYaml(invalid.yaml)("claude")).toThrow();
    const first = resolveWithAgentsYaml(parseAgentsYaml("agents: { worker: { kind: headless, template: claude, context_revision: 2 } }").yaml)("worker");
    const second = resolveWithAgentsYaml(parseAgentsYaml("agents:\n  worker:\n    context_revision: 2\n    template: claude\n    kind: headless\n").yaml)("worker");
    expect(first.configuration_hash).toBe(second.configuration_hash);
  });

  it("有效 headless 参数相同则身份相同，env 值变化不影响身份", () => {
    const first = new HeadlessDriver({ cli: "claude", knobs: { model: "sonnet", agent: "reviewer" }, env: { TEST_VALUE: "PRIVATE_FIRST" } });
    const second = new HeadlessDriver({ cli: "claude", knobs: { agent: "reviewer", model: "sonnet" }, env: { TEST_VALUE: "PRIVATE_SECOND", EXTRA: "ignored" } });
    expect(first.configuration_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(second.configuration_hash).toBe(first.configuration_hash);
    first.buildArgv({ prompt: "不同任务输入", cwd: "/tmp" });
    expect(first.configuration_hash).toBe(second.configuration_hash);
  });

  it.each([
    { knobs: { model: "opus" } }, { knobs: { effort: "high" } },
    { knobs: { system_prompt: "不同角色" } }, { knobs: { agent: "reviewer" } },
    { knobs: { agents_json: '{"reviewer":{"prompt":"新角色"}}' } }, { bin: "custom-claude" },
  ])("model/强度/角色/启动路径变化使身份改变：%s", (options) => {
    const plain = new HeadlessDriver({ cli: "claude" });
    expect(new HeadlessDriver({ cli: "claude", ...options }).configuration_hash).not.toBe(plain.configuration_hash);
  });

  it("仅只读或 resume 参数变化，也能区分配置身份", () => {
    const template = { name: "custom", bin: "custom", args: ({ prompt }: { prompt: string }) => [prompt] };
    const plain = new HeadlessDriver({ cli: "custom", template });
    const readonly = new HeadlessDriver({ cli: "custom", template: { ...template, args: ({ prompt, readonly }) => [prompt, ...(readonly ? ["--restrict"] : [])] } });
    const resume = new HeadlessDriver({ cli: "custom", template: { ...template, args: ({ prompt, resume_session_id }) => [prompt, ...(resume_session_id ? ["--resume", resume_session_id] : [])] } });
    expect(readonly.configuration_hash).not.toBe(plain.configuration_hash);
    expect(resume.configuration_hash).not.toBe(plain.configuration_hash);
  });

  it("ACP 参数稳定，bin/args 变化生效，env 不参与", () => {
    const first = new AcpDriver({ bin: "tool", name: "same", args: ["acp"], env: { TEST_VALUE: "PRIVATE_FIRST" } });
    const second = new AcpDriver({ bin: "tool", name: "same", args: ["acp"], env: { TEST_VALUE: "PRIVATE_SECOND" } });
    expect(first.configuration_hash).toBe(second.configuration_hash);
    expect(new AcpDriver({ bin: "tool", name: "same", args: ["serve"] }).configuration_hash).not.toBe(first.configuration_hash);
    expect(new AcpDriver({ bin: "other", name: "same", args: ["acp"] }).configuration_hash).not.toBe(first.configuration_hash);
  });

  it("忽略的旋钮和 YAML 格式不改变执行身份", () => {
    const first = resolveWithAgentsYaml(parseAgentsYaml("agents: { worker: { kind: headless, template: kimi, model: k2, system_prompt: unused } }").yaml)("worker");
    const second = resolveWithAgentsYaml(parseAgentsYaml("agents:\n  worker:\n    template: kimi\n    model: k2\n    kind: headless\n").yaml)("worker");
    expect(first.configuration_hash).toBe(second.configuration_hash);
  });
});
