/** 有效启动身份：跨构造稳定、参数变化生效、env 不参与（ADR-0031）。 */
import { describe, expect, it } from "vitest";
import { AcpDriver } from "../../src/driver/acp.js";
import { HeadlessDriver } from "../../src/driver/headless.js";
import { parseAgentsYaml, resolveWithAgentsYaml } from "../../src/driver/agents-yaml.js";

describe("agent 配置身份", () => {
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
