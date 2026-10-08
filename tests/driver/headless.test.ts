import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import type { AgentEvent, AgentTask } from "../../src/core/ports.js";
import {
  HeadlessDriver,
  type ErrorEventData,
  type HeadlessDriverOptions,
  type ResultEventData,
  type TextEventData,
  type ToolUseEventData,
  parseHeadlessLine,
} from "../../src/driver/headless.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-cli.mjs");
// macOS 上 /var 是 /private/var 的符号链接，子进程回显的 cwd 是解析后的路径
const workdir = realpathSync(mkdtempSync(join(tmpdir(), "cord-headless-")));

function fakeDriver(
  cli: string,
  mode: string,
  extra: string[] = [],
  options: Partial<HeadlessDriverOptions> = {},
): HeadlessDriver {
  return new HeadlessDriver({
    cli,
    bin: process.execPath,
    prefixArgs: [fixture, "--mode", mode, ...extra],
    kill_grace_ms: 200,
    ...options,
  });
}

function task(overrides: Partial<AgentTask> = {}): AgentTask {
  return { prompt: "review src/core/ports.ts", cwd: workdir, ...overrides };
}

async function collect(source: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of source) events.push(event);
  return events;
}

const texts = (events: AgentEvent[]): string[] =>
  events.filter((e) => e.type === "text").map((e) => (e.data as TextEventData).text);

const textData = (event: AgentEvent | undefined): TextEventData => event?.data as TextEventData;
const resultData = (event: AgentEvent | undefined): ResultEventData => event?.data as ResultEventData;
const errorData = (event: AgentEvent | undefined): ErrorEventData => event?.data as ErrorEventData;
const toolData = (event: AgentEvent | undefined): ToolUseEventData => event?.data as ToolUseEventData;

/** fixture 在首行回显自己的 argv（作为 raw 保留），用它验证参数真的落到了子进程 */
const rawOf = (event: AgentEvent | undefined): Record<string, unknown> =>
  ((event?.data as { raw?: unknown })?.raw as Record<string, unknown>) ?? {};

const echoedArgv = (events: AgentEvent[]): string[] => (rawOf(events[0]).argv as string[]) ?? [];

/** 去掉 fixture 自己的 prefixArgs（--mode <mode>），剩下的是驱动模板拼出的参数 */
const templateArgv = (events: AgentEvent[]): string[] => echoedArgv(events).slice(2);

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function expectDead(pid: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline && isAlive(pid)) await delay(25);
  expect(isAlive(pid), `pid ${pid} should be gone`).toBe(false);
}

describe("parseHeadlessLine", () => {
  it("Codex file_change 的 started/completed 是工具事件，不能成为产物正文", () => {
    const changes = [{ path: "apps/server/tests/draft.test.ts", kind: "add" }];
    for (const type of ["item.started", "item.completed"]) {
      const item = { id: "change-1", type: "file_change", changes, status: type === "item.started" ? "in_progress" : "completed" };
      expect(parseHeadlessLine(JSON.stringify({ type, item }))).toMatchObject([{ type: "tool_use", data: { name: "file_change", input: changes, raw: item } }]);
    }
  });
  it("Codex 非终态 error/warning item 是辅助通知，顶层失败仍是 error", () => {
    for (const type of ["error", "warning"]) {
      const raw = { type: "item.completed", item: { id: "notice-1", type, message: "辅助配置通知" } };
      expect(parseHeadlessLine(JSON.stringify(raw))).toMatchObject([{ type: "text", data: { text: "辅助配置通知", channel: "metadata", raw: raw.item } }]);
    }
    expect(parseHeadlessLine('{"type":"turn.failed","error":{"message":"真实失败"}}')).toMatchObject([{ type: "error", data: { message: "真实失败" } }]);
  });
  it("明确空最终字符串不变成 null，也不回退另一个字段", () => {
    const [empty] = parseHeadlessLine('{"type":"result","subtype":"success","result":"","text":"unexpected fallback"}');
    expect(resultData(empty).text).toBe("");
    const [missing] = parseHeadlessLine('{"type":"turn.completed"}');
    expect(resultData(missing).text).toBeNull();
  });

  it("初始化、用户回声与思考保留 raw，但标记为辅助通道", () => {
    for (const raw of [
      { type: "system", subtype: "init", prompt: "USER_INPUT" },
      { type: "thread.started", thread_id: "s-1" },
      { type: "turn.started" },
      { role: "meta", content: "PROTOCOL_METADATA" },
      { type: "user", message: { content: [{ type: "text", text: "USER_ECHO" }] } },
      { type: "item.completed", item: { type: "reasoning", text: "THOUGHT_METADATA" } },
    ]) {
      const [event] = parseHeadlessLine(JSON.stringify(raw));
      expect((event!.data as TextEventData).channel).toBe("metadata");
      expect((event!.data as TextEventData).raw).toBeDefined();
    }
    const [empty_message] = parseHeadlessLine('{"type":"item.completed","item":{"type":"agent_message","text":""}}');
    expect((empty_message!.data as TextEventData).text).toBe("");
  });

  it("跳过空行，无法解析的行按 text 透传", () => {
    expect(parseHeadlessLine("   ")).toEqual([]);
    expect(parseHeadlessLine("plain text")).toEqual([
      { type: "text", data: { text: "plain text" } },
    ]);
    expect(parseHeadlessLine("[1,2,3]")).toEqual([{ type: "text", data: { text: "[1,2,3]" } }]);
  });

  it("识别 claude 的 assistant/tool_use/result 形状", () => {
    const [text] = parseHeadlessLine(
      '{"type":"assistant","session_id":"s1","message":{"content":[{"type":"text","text":"hi"}]}}',
    );
    expect(text).toMatchObject({ type: "text", data: { text: "hi" } });

    const [tool] = parseHeadlessLine(
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"a"}}]}}',
    );
    expect(tool).toMatchObject({ type: "tool_use", data: { name: "Read", input: { file_path: "a" } } });

    const [result] = parseHeadlessLine('{"type":"result","subtype":"success","result":"ok","session_id":"s1"}');
    expect(resultData(result)).toMatchObject({ text: "ok", session_id: "s1" });
  });

  it("错误形态映射为 error 事件", () => {
    const [failed] = parseHeadlessLine('{"type":"result","subtype":"error_max_turns","session_id":"s1"}');
    expect(errorData(failed).kind).toBe("agent");
  });

  it("claude result 事件提取规范化用量（usage + total_cost_usd + num_turns）", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "success",
      result: "ok",
      session_id: "s1",
      num_turns: 2,
      total_cost_usd: 0.0073,
      usage: { input_tokens: 10, output_tokens: 41, cache_read_input_tokens: 12713 },
    });
    const [event] = parseHeadlessLine(line);
    expect(resultData(event).usage).toEqual({
      input_tokens: 10,
      output_tokens: 41,
      cached_input_tokens: 12713,
      cost_usd: 0.0073,
      num_turns: 2,
    });
  });

  it("codex turn.completed 提取 usage（cached_input_tokens），无成本字段", () => {
    const line = JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 16713, cached_input_tokens: 13056, output_tokens: 5 },
    });
    const [event] = parseHeadlessLine(line);
    expect(resultData(event).usage).toEqual({
      input_tokens: 16713,
      output_tokens: 5,
      cached_input_tokens: 13056,
      cost_usd: undefined,
      num_turns: undefined,
    });
  });

  it("厂商没报用量时 usage 为 null（不硬造 0）", () => {
    const [event] = parseHeadlessLine('{"type":"result","subtype":"success","result":"ok"}');
    expect(resultData(event).usage).toBeNull();
  });
});

describe("HeadlessDriver", () => {
  it("把 CLI 的 stream-json 事件流映射为 AgentEvent（claude 形态）", async () => {
    const driver = fakeDriver("claude", "claude");
    const events = await collect(driver.run(task()));

    expect(events.map((e) => e.type)).toEqual(["text", "text", "tool_use", "result"]);

    // claude 的 system/init 行没有对应事件类型 → 原文透传，raw 保留全部字段
    expect(rawOf(events[0]).cwd).toBe(workdir);
    expect(rawOf(events[0]).prompt).toBe("review src/core/ports.ts");
    expect(templateArgv(events)).toEqual([
      "-p",
      "review src/core/ports.ts",
      "--output-format",
      "stream-json",
    ]);

    expect(textData(events[1]).text).toBe("reading files");
    expect(toolData(events[2])).toMatchObject({ name: "Read", input: { file_path: "src/core/ports.ts" } });
    expect(resultData(events[3])).toMatchObject({ text: "final answer", session_id: "fake-session-1" });
  });

  it("kimi 形态：role assistant/tool → text/tool_use，且没有 result 行也不报错", async () => {
    const driver = fakeDriver("kimi", "kimi", [], { name: "kimi" });
    const events = await collect(driver.run(task()));

    expect(events.map((e) => e.type)).toEqual([
      "text",
      "text",
      "tool_use",
      "tool_use",
      "text",
    ]);
    expect(texts(events)).toContain("thinking out loud");
    expect(texts(events)).toContain("kimi final");
    expect(toolData(events[2]).name).toBe("read_file");
    expect(toolData(events[3]).input).toEqual({ tool_call_id: "call-1", content: "file content" });
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  it("codex 形态：item.* 事件映射为 text/tool_use，turn.completed 映射为 result", async () => {
    const driver = fakeDriver("codex", "codex");
    const events = await collect(driver.run(task()));

    expect(templateArgv(events).slice(0, 2)).toEqual(["exec", "--json"]);
    expect(texts(events)).toContain("codex says hi");
    const tool = events.find((e) => e.type === "tool_use");
    expect(toolData(tool)).toMatchObject({ name: "command_execution", input: "ls -la" });
    expect(events.at(-1)?.type).toBe("result");
    expect(resultData(events.at(-1))).toMatchObject({ text: null, session_id: "thread-1" });
    expect(events.at(-1)?.session_id).toBe("thread-1");
  });

  it("Codex 配置通知不能污染产物正文，完成回执保留 thread ID", async () => {
    const events = await collect(fakeDriver("codex", "codex-warning").run(task()));
    const content = events.filter((event) => event.type === "text" && textData(event).channel !== "metadata").map((event) => textData(event).text).join("");
    expect(content).toBe("codex says hi");
    expect(resultData(events.at(-1)).session_id).toBe("thread-1");
  });

  it("纯文本输出全部按 text 事件透传", async () => {
    const driver = fakeDriver("claude", "plain");
    const events = await collect(driver.run(task()));
    expect(texts(events).slice(1)).toEqual(["plain line one", "plain line two"]);
  });

  it("未知 JSON 形态与无换行残行都保留下来", async () => {
    const driver = fakeDriver("claude", "garbage");
    const events = await collect(driver.run(task()));
    const lines = texts(events).slice(1);

    expect(lines).toEqual(["not json at all", '{"weird":true}', "partial-without-newline"]);
    expect((events[2]?.data as { raw?: unknown }).raw).toEqual({ weird: true });
  });

  it("非零退出 + stderr 上抛为 error 事件", async () => {
    const driver = fakeDriver("claude", "fail");
    const events = await collect(driver.run(task()));

    const failure = events.find((e) => e.type === "error");
    expect(errorData(failure)).toMatchObject({ kind: "agent" });
    expect(errorData(failure).message).toContain("boom: model unavailable");
  });

  it("二进制不存在时给出 spawn 错误而不是抛异常", async () => {
    const driver = new HeadlessDriver({ cli: "kimi", bin: "/nonexistent/cord-cli" });
    const events = await collect(driver.run(task()));

    expect(errorData(events[0]).kind).toBe("spawn");
    expect(errorData(events[0]).message).toContain("/nonexistent/cord-cli");
  });

  it("timeout_ms 到点杀进程树并给出 timeout 事件", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cord-timeout-"));
    const childPidFile = join(dir, "grandchild.pid");
    const driver = fakeDriver("claude", "claude", [
      "--sleep",
      "60000",
      "--pid-file",
      join(dir, "cli.pid"),
      "--child-pid-file",
      childPidFile,
    ]);

    const started = Date.now();
    const events = await collect(driver.run({ prompt: "never finishes", cwd: dir, timeout_ms: 900 }));
    const elapsed = Date.now() - started;

    // 超时前已经流出的事件保留
    expect(texts(events)).toContain("reading files");
    const failure = events.find((e) => e.type === "error");
    expect(errorData(failure).kind).toBe("timeout");
    expect(errorData(failure).message).toContain("900ms");
    expect(elapsed).toBeLessThan(5_000);
    expect(events.some((e) => e.type === "result")).toBe(false);

    await expectDead(Number(readFileSync(childPidFile, "utf8")));
    await expectDead(Number(readFileSync(join(dir, "cli.pid"), "utf8")));
  });
});

describe("HeadlessDriver CLI 参数", () => {
  const claudeTools = [
    "Read",
    "Grep",
    "Glob",
    "Bash(git diff:*)",
    "Bash(git log:*)",
    "Bash(git show:*)",
  ];

  it("kimi：readonly 用 --plan，resume 用 --session", () => {
    const driver = new HeadlessDriver({ cli: "kimi" });
    expect(driver.name).toBe("headless:kimi");
    expect(driver.buildArgv({ prompt: "p", cwd: "/w" })).toEqual([
      "kimi",
      "-p",
      "p",
      "--output-format",
      "stream-json",
    ]);
    expect(driver.buildArgv({ prompt: "p", cwd: "/w", readonly: true })).toEqual([
      "kimi",
      "--plan",
      "-p",
      "p",
      "--output-format",
      "stream-json",
    ]);
    expect(driver.buildArgv({ prompt: "p", cwd: "/w" }, "sess-42")).toEqual([
      "kimi",
      "--session",
      "sess-42",
      "-p",
      "p",
      "--output-format",
      "stream-json",
    ]);
  });

  it("claude：readonly 收窄到 plan 模式 + 只读工具，--allowedTools 必须排在 prompt 之前", () => {
    const driver = new HeadlessDriver({ cli: "claude" });
    expect(driver.buildArgv({ prompt: "p", cwd: "/w", readonly: true })).toEqual([
      "claude",
      "--permission-mode",
      "plan",
      "--allowedTools",
      ...claudeTools,
      "-p",
      "p",
      "--output-format",
      "stream-json",
    ]);
    expect(driver.buildArgv({ prompt: "p", cwd: "/w" }, "s1")).toEqual([
      "claude",
      "--resume",
      "s1",
      "-p",
      "p",
      "--output-format",
      "stream-json",
    ]);
    expect(driver.buildArgv({ prompt: "p", cwd: "/w", readonly: true }, "s1")).toEqual([
      "claude",
      "--resume",
      "s1",
      "--fork-session",
      "--permission-mode",
      "plan",
      "--allowedTools",
      ...claudeTools,
      "-p",
      "p",
      "--output-format",
      "stream-json",
    ]);
  });

  it("codex：readonly 只读沙箱、非只读显式 workspace-write（exec 默认 read-only，已实证），resume 用 exec resume", () => {
    const driver = new HeadlessDriver({ cli: "codex" });
    expect(driver.buildArgv({ prompt: "p", cwd: "/w" })).toEqual([
      "codex",
      "exec",
      "--json",
      "-c",
      'sandbox_mode="workspace-write"',
      "-c",
      'approval_policy="never"',
      "p",
    ]);
    expect(driver.buildArgv({ prompt: "p", cwd: "/w", readonly: true })).toEqual([
      "codex",
      "exec",
      "--json",
      "-c",
      'sandbox_mode="read-only"',
      "-c",
      'approval_policy="never"',
      "p",
    ]);
    expect(driver.buildArgv({ prompt: "p", cwd: "/w" }, "s1")).toEqual([
      "codex",
      "exec",
      "resume",
      "s1",
      "--json",
      "-c",
      'sandbox_mode="workspace-write"',
      "-c",
      'approval_policy="never"',
      "p",
    ]);
  });

  it("readonly 与 resume 参数真的落到了子进程，resume 还能拿到 session id", async () => {
    const readonlyEvents = await collect(
      fakeDriver("kimi", "kimi").run(task({ readonly: true })),
    );
    expect(templateArgv(readonlyEvents)).toEqual([
      "--plan",
      "-p",
      "review src/core/ports.ts",
      "--output-format",
      "stream-json",
    ]);

    const resumeEvents = await collect(
      fakeDriver("claude", "claude").resume("sess-7", task()),
    );
    expect(templateArgv(resumeEvents).slice(0, 2)).toEqual(["--resume", "sess-7"]);
    expect(resultData(resumeEvents.at(-1)).session_id).toBe("fake-session-1");
  });

  it("未知模板名在构造时就报错", () => {
    expect(() => new HeadlessDriver({ cli: "nope" })).toThrow(/unknown headless CLI/);
  });

  it("claude 旋钮：model/effort/max_turns/budget_usd/system_prompt 全部落在 prompt 之前", () => {
    const driver = new HeadlessDriver({
      cli: "claude",
      knobs: {
        model: "sonnet",
        effort: "high",
        max_turns: 30,
        budget_usd: 2.5,
        system_prompt: "你是资深代码评审",
      },
    });
    expect(driver.buildArgv({ prompt: "p", cwd: "/w" })).toEqual([
      "claude",
      "--model",
      "sonnet",
      "--effort",
      "high",
      "--max-turns",
      "30",
      "--max-budget-usd",
      "2.5",
      "--append-system-prompt",
      "你是资深代码评审",
      "-p",
      "p",
      "--output-format",
      "stream-json",
    ]);
  });

  it("claude 硬封装：agent + agents_json 落在 prompt 之前", () => {
    const driver = new HeadlessDriver({
      cli: "claude",
      knobs: {
        agents_json: '{"reviewer":{"description":"评审","prompt":"你是评审"}}',
        agent: "reviewer",
      },
    });
    const argv = driver.buildArgv({ prompt: "p", cwd: "/w" });
    expect(argv[argv.indexOf("--agents") + 1]).toContain('"reviewer"');
    expect(argv[argv.indexOf("--agent") + 1]).toBe("reviewer");
    expect(argv.indexOf("--agents")).toBeLessThan(argv.indexOf("-p"));
  });

  it("codex 旋钮：model 走 -m，effort 走 -c 配置覆盖", () => {
    const driver = new HeadlessDriver({
      cli: "codex",
      knobs: { model: "gpt-5", effort: "high" },
    });
    expect(driver.buildArgv({ prompt: "p", cwd: "/w" })).toEqual([
      "codex",
      "exec",
      "--json",
      "--model",
      "gpt-5",
      "-c",
      'model_reasoning_effort="high"',
      "-c",
      'sandbox_mode="workspace-write"',
      "-c",
      'approval_policy="never"',
      "p",
    ]);
  });

  it("kimi 旋钮：仅支持 model", () => {
    const driver = new HeadlessDriver({ cli: "kimi", knobs: { model: "k2" } });
    expect(driver.buildArgv({ prompt: "p", cwd: "/w" })).toEqual([
      "kimi",
      "--model",
      "k2",
      "-p",
      "p",
      "--output-format",
      "stream-json",
    ]);
  });
});
