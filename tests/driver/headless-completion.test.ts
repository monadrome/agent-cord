import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HeadlessDriver, type AgentEvent } from "../../src/index.js";
import { canonicalJson, sha256Hex } from "../../src/core/hash.js";

const fixture = fileURLToPath(new URL("./fixtures/fake-cli.mjs", import.meta.url));
let cwd: string;
beforeEach(async () => { cwd = await mkdtemp(join(tmpdir(), "cord-headless-completion-")); });
afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });
async function collect(source: AsyncIterable<AgentEvent>) { const events: AgentEvent[] = []; for await (const event of source) events.push(event); return events; }
const create = (mode: "claude" | "codex" | "plain", flags: string[] = []) => new HeadlessDriver({ cli: mode === "plain" ? "claude" : mode, bin: process.execPath,
  prefixArgs: [fixture, "--mode", mode, "--no-tools", ...flags], kill_grace_ms: 50 });

describe("Headless真实进程完成", () => {
  it.each(["claude", "codex"] as const)("%s候选result不能掩盖晚退出3，正常退出仍通过", async mode => {
    const failed = await collect(create(mode, ["--exit-code", "3"]).run({ prompt: "p", cwd }));
    expect(failed.some(event => event.type === "result")).toBe(true);
    expect(failed.at(-1)).toMatchObject({ type: "error", data: { kind: "agent", message: expect.stringContaining("code 3") } });
    const valid = await collect(create(mode).run({ prompt: "p", cwd }));
    expect(valid.at(-1)).toMatchObject({ type: "result" }); expect(valid.some(event => event.type === "error")).toBe(false);
  });

  it.each(["SIGTERM", "SIGINT"])("候选result不能掩盖%s终止", async signal => {
    const events = await collect(create("claude", ["--exit-signal", signal]).run({ prompt: "p", cwd }));
    expect(events.some(event => event.type === "result")).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "error", data: { kind: "agent", message: expect.stringContaining(`signal ${signal}`) } });
  });

  it("无result的文本仍须正常退出，失败文本不成为成功证明", async () => {
    const failed = await collect(create("plain", ["--exit-code", "3"]).run({ prompt: "p", cwd }));
    expect(failed.some(event => event.type === "result")).toBe(false); expect(failed.at(-1)).toMatchObject({ type: "error", data: { kind: "agent" } });
    expect((await collect(create("plain").run({ prompt: "p", cwd }))).some(event => event.type === "error")).toBe(false);
  });

  it("result后的静默超时保持timeout分类并收束进程", async () => {
    const pid_file = join(cwd, "pid");
    const events = await collect(create("claude", ["--post-result-sleep", "60000", "--pid-file", pid_file]).run({ prompt: "p", cwd, timeout_ms: 1000 }));
    expect(events.some(event => event.type === "result")).toBe(true);
    expect(events.filter(event => event.type === "error")).toMatchObject([{ data: { kind: "timeout" } }]);
    const pid = Number(await readFile(pid_file, "utf8")); expect(() => process.kill(pid, 0)).toThrow();
  });

  it("result后外部取消保留取消错误，进程被收束", async () => {
    const controller = new AbortController(); const pid_file = join(cwd, "pid"); const events: AgentEvent[] = [];
    for await (const event of create("claude", ["--post-result-sleep", "60000", "--pid-file", pid_file]).run({ prompt: "p", cwd, signal: controller.signal })) {
      events.push(event); if (event.type === "result") controller.abort();
    }
    expect(events.filter(event => event.type === "error")).toMatchObject([{ data: { kind: "agent" } }]);
    const pid = Number(await readFile(pid_file, "utf8")); expect(() => process.kill(pid, 0)).toThrow();
  });

  it.each([{}, { context_revision: 2 }, { readonly_launch: {} }])("完成策略使旧身份失效但有效argv不变：%j", options => {
    const agent = new HeadlessDriver({ cli: "claude", ...options }); const task = { prompt: "cord.configuration.prompt", cwd: "" };
    const definition_hash = sha256Hex(canonicalJson({ domain: "readonly_launch" in options ? "cord.agent-config.headless.v3" : "context_revision" in options ? "cord.agent-config.headless.v2" : "cord.agent-config.headless.v1",
      ...("context_revision" in options ? { context_revision: options.context_revision } : {}), name: agent.name,
      argv: agent.buildArgv(task), readonly_argv: agent.buildArgv({ ...task, readonly: true }), resume_argv: agent.buildArgv(task, "cord.configuration.session"),
      readonly_resume_argv: agent.buildArgv({ ...task, readonly: true }, "cord.configuration.session") }));
    expect(agent.configuration_hash).not.toBe(definition_hash);
    expect(agent.configuration_hash).toBe(sha256Hex(canonicalJson({ domain: "cord.agent-config.headless.v4", completion_policy: "process-exit-required.v1", launch_configuration_hash: definition_hash })));
  });
});
