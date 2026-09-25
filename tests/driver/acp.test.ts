import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import type { AgentEvent, AgentTask } from "../../src/core/ports.js";
import { AcpDriver, mapSessionUpdate, type AcpDriverOptions } from "../../src/driver/acp.js";
import type {
  ErrorEventData,
  ResultEventData,
  TextEventData,
  ToolUseEventData,
} from "../../src/driver/headless.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-acp-agent.mjs");

interface Recorded {
  event: string;
  [key: string]: unknown;
}

function acpDriver(extra: string[], options: Partial<AcpDriverOptions> = {}): AcpDriver {
  return new AcpDriver({
    bin: process.execPath,
    args: [fixture, ...extra],
    kill_grace_ms: 300,
    ...options,
  });
}

function workspace(): string {
  return mkdtempSync(join(tmpdir(), "cord-acp-"));
}

function task(cwd: string, overrides: Partial<AgentTask> = {}): AgentTask {
  return { prompt: "review the diff", cwd, timeout_ms: 15_000, ...overrides };
}

async function collect(source: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of source) events.push(event);
  return events;
}

function recorded(path: string): Recorded[] {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Recorded);
  } catch {
    return [];
  }
}

const texts = (events: AgentEvent[]): string[] =>
  events.filter((e) => e.type === "text").map((e) => (e.data as TextEventData).text);
const resultData = (event: AgentEvent | undefined): ResultEventData => event?.data as ResultEventData;
const errorData = (event: AgentEvent | undefined): ErrorEventData => event?.data as ErrorEventData;
const toolData = (event: AgentEvent | undefined): ToolUseEventData => event?.data as ToolUseEventData;

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
  expect(isAlive(pid), `agent pid ${pid} should be gone`).toBe(false);
}

describe("mapSessionUpdate", () => {
  it("文本类更新映射为 text，工具类映射为 tool_use", () => {
    const [text] = mapSessionUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "thinking" },
    });
    expect(text).toMatchObject({ type: "text", data: { text: "thinking" } });

    const [tool] = mapSessionUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "read file",
      kind: "read",
      rawInput: { path: "a.ts" },
    });
    expect(tool).toMatchObject({ type: "tool_use", data: { name: "read file", input: { path: "a.ts" } } });
  });

  it("AgentEvent 无对应类型的更新按 text + raw 透传（不丢粒度）", () => {
    const plan = { sessionUpdate: "plan", entries: [{ content: "step", priority: "medium", status: "pending" }] };
    const [event] = mapSessionUpdate(plan as never);
    expect(event?.type).toBe("text");
    expect((event?.data as { raw?: unknown }).raw).toEqual(plan);
  });
});

describe("AcpDriver", () => {
  it("跑完整回合：initialize → session/new → session/prompt，并把 update 映射成事件", async () => {
    const dir = workspace();
    const recordFile = join(dir, "record.jsonl");
    const pidFile = join(dir, "agent.pid");
    const driver = acpDriver(["--mode", "permission", "--record", recordFile, "--pid-file", pidFile]);

    const events = await collect(
      driver.run(task(dir, { readonly: true, timeout_ms: 15_000 })),
    );

    expect(events.map((e) => e.type)).toEqual(["text", "tool_use", "text", "text", "result"]);
    expect(texts(events)[0]).toBe("hello ");
    expect(toolData(events[1])).toMatchObject({
      name: "read file",
      input: { path: "src/core/ports.ts" },
    });
    // readonly：权限请求被自动拒绝（选 agent 提供的 reject 选项），不弹人工审批
    expect(texts(events)).toContainEqual(expect.stringContaining("[permission denied: Reject] write file"));

    const result = resultData(events.at(-1));
    expect(result).toMatchObject({ text: "hello done", session_id: "acp-session-1" });
    expect((result.raw as { stop_reason?: string }).stop_reason).toBe("end_turn");

    const log = recorded(recordFile);
    expect(log.find((entry) => entry.event === "session/new")).toMatchObject({
      cwd: dir,
      mcpServers: [],
    });
    expect(log.find((entry) => entry.event === "permission_response")).toMatchObject({
      outcome: { outcome: "selected", optionId: "reject-once" },
    });
    expect(log.some((entry) => entry.event === "prompt")).toBe(true);

    // 每任务 subprocess：回合结束后 agent 进程必须被清理
    await expectDead(Number(readFileSync(pidFile, "utf8")));
  });

  it("非 readonly 且未接人工审批：取消权限请求并上抛 error 事件", async () => {
    const dir = workspace();
    const recordFile = join(dir, "record.jsonl");
    const driver = acpDriver(["--mode", "permission", "--record", recordFile]);

    const events = await collect(driver.run(task(dir)));

    const failure = events.find((e) => e.type === "error");
    expect(errorData(failure).kind).toBe("permission");
    expect(errorData(failure).message).toContain("human approval");
    expect(recorded(recordFile).find((e) => e.event === "permission_response")).toMatchObject({
      outcome: { outcome: "cancelled" },
    });
    // 请求被取消后回合照常收尾（不阻塞整体）
    expect(events.at(-1)?.type).toBe("result");
  });

  it("权限决策挂死时按防御性超时兜底，整体不卡住", async () => {
    const dir = workspace();
    const recordFile = join(dir, "record.jsonl");
    const driver = acpDriver(["--mode", "permission", "--record", recordFile], {
      permission_timeout_ms: 150,
      decidePermission: () => new Promise(() => {}),
    });

    const started = Date.now();
    const events = await collect(driver.run(task(dir)));
    const elapsed = Date.now() - started;

    const failure = events.find((e) => e.type === "error");
    expect(errorData(failure).kind).toBe("permission");
    expect(errorData(failure).message).toContain("timed out after 150ms");
    expect(recorded(recordFile).find((e) => e.event === "permission_response")).toMatchObject({
      outcome: { outcome: "cancelled" },
    });
    expect(events.at(-1)?.type).toBe("result");
    expect(elapsed).toBeLessThan(10_000);
  });

  it("prompt 挂死时先 session/cancel 再杀进程树，并给出 timeout 事件", async () => {
    const dir = workspace();
    const recordFile = join(dir, "record.jsonl");
    const pidFile = join(dir, "agent.pid");
    const driver = acpDriver(["--mode", "hang", "--record", recordFile, "--pid-file", pidFile]);

    const started = Date.now();
    const events = await collect(driver.run(task(dir, { timeout_ms: 600 })));
    const elapsed = Date.now() - started;

    expect(texts(events)).toContain("hello ");
    const failure = events.find((e) => e.type === "error");
    expect(errorData(failure).kind).toBe("timeout");
    expect(errorData(failure).message).toContain("600ms");
    expect(elapsed).toBeLessThan(8_000);

    expect(recorded(recordFile).some((entry) => entry.event === "session/cancel")).toBe(true);
    await expectDead(Number(readFileSync(pidFile, "utf8")));
  });

  it("resume 走 session/load 并沿用原 session id", async () => {
    const dir = workspace();
    const recordFile = join(dir, "record.jsonl");
    const driver = acpDriver(["--mode", "default", "--record", recordFile]);

    const events = await collect(driver.resume("acp-session-9", task(dir)));

    const log = recorded(recordFile);
    expect(log.find((entry) => entry.event === "session/load")).toMatchObject({
      sessionId: "acp-session-9",
      cwd: dir,
    });
    expect(log.some((entry) => entry.event === "session/new")).toBe(false);
    expect(resultData(events.at(-1)).session_id).toBe("acp-session-9");
  });

  it("session/load 失败时上抛 error 事件", async () => {
    const dir = workspace();
    const driver = acpDriver(["--mode", "fail-load"]);

    const events = await collect(driver.resume("acp-session-9", task(dir)));

    expect(errorData(events.at(-1)).kind).toBe("agent");
    expect(errorData(events.at(-1)).message).toContain("session/load not supported");
    expect(events.some((e) => e.type === "result")).toBe(false);
  });

  it("prompt 返回 JSON-RPC 错误时上抛 error 事件", async () => {
    const dir = workspace();
    const driver = acpDriver(["--mode", "fail-prompt"]);

    const events = await collect(driver.run(task(dir)));

    expect(errorData(events.at(-1)).kind).toBe("agent");
    expect(errorData(events.at(-1)).message).toContain("prompt rejected by agent");
  });

  it("agent 协商出不支持的协议版本时按 protocol 错误上抛", async () => {
    const dir = workspace();
    const driver = acpDriver(["--mode", "bad-version"]);

    const events = await collect(driver.run(task(dir)));

    expect(errorData(events.at(-1)).kind).toBe("protocol");
    expect(errorData(events.at(-1)).message).toContain("version 2");
  });

  it("消费方提前退出时不留下 agent 进程", async () => {
    const dir = workspace();
    const pidFile = join(dir, "agent.pid");
    const driver = acpDriver(["--mode", "hang", "--pid-file", pidFile]);

    for await (const event of driver.run(task(dir, { timeout_ms: 30_000 }))) {
      if (event.type === "text") break;
    }

    await expectDead(Number(readFileSync(pidFile, "utf8")));
  });
});
