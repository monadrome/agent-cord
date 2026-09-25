import { Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";

import {
  CLI_ADAPTER,
  CLI_MESSAGE_EVENT_TYPE,
  HUMAN_DECISION_EVENT_TYPE,
  CliHumanGate,
  buildCliMessageDraft,
  buildEventDraft,
  buildHumanDecisionDraft,
  newEventId,
  normalizeCliInput,
  parseCliAnswer,
} from "../../src/adapters/cli.js";
import { ULID_RE } from "../../src/core/schema.js";

function captureOutput(): { stream: Writable; text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  return { stream, text: () => chunks.join("") };
}

function inputOf(lines: string[]): Readable {
  return Readable.from(lines.map((line) => `${line}\n`));
}

describe("parseCliAnswer", () => {
  const options = ["continue", "escalate", "stop"];

  it("接受编号（1 基）与选项原文", () => {
    expect(parseCliAnswer("2", options)).toBe(1);
    expect(parseCliAnswer(" 3 ", options)).toBe(2);
    expect(parseCliAnswer("escalate", options)).toBe(1);
    expect(parseCliAnswer("STOP", options)).toBe(2);
  });

  it("越界与无法识别返回 null", () => {
    expect(parseCliAnswer("0", options)).toBeNull();
    expect(parseCliAnswer("4", options)).toBeNull();
    expect(parseCliAnswer("随便写点什么", options)).toBeNull();
    expect(parseCliAnswer("", options)).toBeNull();
  });
});

describe("normalizeCliInput", () => {
  it("普通文本是一行消息，命令去掉 cord 前缀", () => {
    const message = normalizeCliInput("这条结论我不同意");
    expect(message.kind).toBe("message");
    expect(message.actor).toEqual({ kind: "human", id: "local-human" });
    expect(message.source.adapter).toBe(CLI_ADAPTER);
    expect(message.raw_id).toMatch(ULID_RE);

    const command = normalizeCliInput("/cord doctor --fix");
    expect(command.kind).toBe("command");
    expect(command.argv).toEqual(["doctor", "--fix"]);
  });

  it("归一化输入转成 cli.message.received 事件 Draft", () => {
    const draft = buildCliMessageDraft(normalizeCliInput("/cord new REQ-1"), "REQ-1");

    expect(draft.type).toBe(CLI_MESSAGE_EVENT_TYPE);
    expect(draft.actor.kind).toBe("human");
    expect(draft.source).toEqual({ adapter: CLI_ADAPTER });
    expect(draft.schema_version).toBe("1");
    expect(draft.session_id).toBe("REQ-1");
    expect(draft.correlation_id).toBeNull();
    expect(draft.event_id).toMatch(ULID_RE);
  });
});

describe("buildEventDraft", () => {
  it("event_id 单调递增（同一毫秒内也不重复）", () => {
    const ids = Array.from({ length: 5 }, () => newEventId());
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("默认 actor 是 human、source 是 cli；system 类事件可显式覆盖", () => {
    const human = buildEventDraft({ session_id: "REQ-1", type: "human.decision.recorded", payload: {} });
    expect(human.actor).toEqual({ kind: "human", id: "local-human" });
    expect(human.source.adapter).toBe(CLI_ADAPTER);

    const system = buildEventDraft({
      session_id: "REQ-1",
      type: "vote.completed",
      payload: {},
      actor: { kind: "system", id: "voting" },
      source_adapter: "system",
      correlation_id: "01J9Z3K7ABCDEFGHJKMNPQRSTV",
    });
    expect(system.actor).toEqual({ kind: "system", id: "voting" });
    expect(system.source.adapter).toBe("system");
    expect(system.correlation_id).toBe("01J9Z3K7ABCDEFGHJKMNPQRSTV");
  });
});

describe("CliHumanGate", () => {
  it("渲染编号选项并接受编号回答", async () => {
    const output = captureOutput();
    const gate = new CliHumanGate({ input: inputOf(["2"]), output: output.stream });

    const record = await gate.askChoice("门禁未通过，如何处置？", ["continue", "escalate", "stop"]);

    expect(record.chosen).toBe("escalate");
    expect(record.chosen_index).toBe(1);
    expect(record.fallback).toBeNull();
    expect(record.raw_input).toBe("2");
    expect(output.text()).toContain("? 门禁未通过，如何处置？");
    expect(output.text()).toContain("3) stop");
  });

  it("非法输入重新提问直到有效", async () => {
    const output = captureOutput();
    const gate = new CliHumanGate({ input: inputOf(["9", "abc", "continue"]), output: output.stream });

    const record = await gate.ask("继续吗？", ["continue", "stop"]);

    expect(record).toBe("continue");
    expect(output.text()).toContain("无效输入");
    expect(output.text().match(/继续吗？/g)).toHaveLength(1);
  });

  it("超时落到默认项", async () => {
    const output = captureOutput();
    const never = new Readable({ read() {} });
    const gate = new CliHumanGate({ input: never, output: output.stream, timeout_ms: 20, default_index: 1 });

    const record = await gate.askChoice("超时会怎样？", ["continue", "escalate"]);

    expect(record.fallback).toBe("timeout");
    expect(record.chosen).toBe("escalate");
    expect(record.default_index).toBe(1);
    expect(record.timeout_ms).toBe(20);
    expect(output.text()).toContain("超时");
  });

  it("EOF 落到默认项", async () => {
    const output = captureOutput();
    const gate = new CliHumanGate({ input: inputOf([]), output: output.stream });

    const record = await gate.askChoice("无输入？", ["continue", "stop"]);

    expect(record.fallback).toBe("eof");
    expect(record.chosen).toBe("continue");
  });

  it("空选项直接报错", async () => {
    const output = captureOutput();
    const gate = new CliHumanGate({ input: inputOf([]), output: output.stream });

    await expect(gate.ask("没有选项？", [])).rejects.toThrow(/至少需要一个选项/);
  });

  it("回答转成 human.decision.recorded 事件 Draft（actor=human 留痕）", async () => {
    const output = captureOutput();
    const gate = new CliHumanGate({ input: inputOf(["escalate"]), output: output.stream });
    const record = await gate.askChoice("如何处置？", ["continue", "escalate"]);

    const draft = buildHumanDecisionDraft(record, { session_id: "REQ-1", actor_id: "ou_123" });

    expect(draft.type).toBe(HUMAN_DECISION_EVENT_TYPE);
    expect(draft.actor).toEqual({ kind: "human", id: "ou_123" });
    expect(draft.source).toEqual({ adapter: CLI_ADAPTER });
    expect(draft.payload).toMatchObject({ chosen: "escalate", fallback: null });
  });
});
