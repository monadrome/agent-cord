/**
 * CLI 适配器（ADR-0012：CLI 也是一个适配器，与 IM 适配器同一事件模型）。
 * 入站：stdin 一行输入 → 归一化输入 → EventDraft（actor.kind='human'、source.adapter='cli'）。
 * 出站：门禁选择题 → 编号选项 + 输入循环 + 超时默认项（ADR-0012 注意点 5 的结构化选择题）。
 */
import { createInterface } from "node:readline";
import { monotonicFactory } from "ulid";

import type { HumanGate, NormalizedEvent } from "../core/ports.js";
import type { Actor, EventDraft } from "../core/schema.js";

/** 单调 ULID：同一毫秒内取单调递增（ADR-0020 注意点 1） */
const nextUlid = monotonicFactory();

export const CLI_ADAPTER = "cli";
export const DEFAULT_HUMAN_ID = "local-human";

/** 入站事件类型（架构章 §2.3 口径：im.message.received / cli.message.received） */
export const CLI_MESSAGE_EVENT_TYPE = "cli.message.received";
export const HUMAN_DECISION_EVENT_TYPE = "human.decision.recorded";

export function newEventId(): string {
  return nextUlid();
}

export interface CliDraftInput {
  session_id: string;
  type: string;
  payload: unknown;
  actor?: Actor;
  correlation_id?: string | null;
  /** 默认 "cli"；system 类事件（投票、门禁）显式传 "system" */
  source_adapter?: string;
}

/** 归一化输入 → 事件 Draft。seq / prev_event_hash / timestamp 由单写者分配（ADR-0020 决策 2） */
export function buildEventDraft(input: CliDraftInput): EventDraft {
  return {
    event_id: newEventId(),
    session_id: input.session_id,
    type: input.type,
    schema_version: "1",
    actor: input.actor ?? { kind: "human", id: DEFAULT_HUMAN_ID },
    correlation_id: input.correlation_id ?? null,
    payload: input.payload,
    source: { adapter: input.source_adapter ?? CLI_ADAPTER },
  };
}

/** CLI 的归一化输入即契约里的 `NormalizedEvent`（与 IM 适配器同一形态，便于互操作） */
export type CliNormalizedInput = NormalizedEvent;

const CORD_COMMAND_RE = /^\/?cord\b\s*/;

/** stdin 一行 → 归一化输入（与 IM 适配器同一形态：actor + source + 文本 + 幂等键） */
export function normalizeCliInput(line: string, opts: { actor_id?: string } = {}): CliNormalizedInput {
  const text = line.trim();
  const is_command = CORD_COMMAND_RE.test(text);
  const argv = is_command
    ? text.replace(CORD_COMMAND_RE, "").split(/\s+/).filter((part) => part.length > 0)
    : [];
  return {
    kind: is_command ? "command" : "message",
    text,
    argv,
    actor: { kind: "human", id: opts.actor_id ?? DEFAULT_HUMAN_ID },
    source: { adapter: CLI_ADAPTER },
    raw_id: newEventId(),
  };
}

export function buildCliMessageDraft(
  input: CliNormalizedInput,
  session_id: string,
  correlation_id: string | null = null,
): EventDraft {
  return buildEventDraft({
    session_id,
    type: CLI_MESSAGE_EVENT_TYPE,
    actor: input.actor,
    correlation_id,
    payload: { kind: input.kind, text: input.text, argv: input.argv, raw_id: input.raw_id },
  });
}

/** 选择题的一次结构化记录：选项 + 超时 + 默认兜底（ADR-0012 注意点 5） */
export interface CliChoiceRecord {
  question: string;
  options: string[];
  timeout_ms: number | null;
  default_index: number;
  chosen_index: number;
  chosen: string;
  /** 无有效输入时的兜底原因；人正常回答为 null */
  fallback: "timeout" | "eof" | null;
  raw_input: string | null;
}

export function buildHumanDecisionDraft(
  record: CliChoiceRecord,
  ctx: { session_id: string; correlation_id?: string | null; actor_id?: string },
): EventDraft {
  return buildEventDraft({
    session_id: ctx.session_id,
    type: HUMAN_DECISION_EVENT_TYPE,
    actor: { kind: "human", id: ctx.actor_id ?? DEFAULT_HUMAN_ID },
    correlation_id: ctx.correlation_id ?? null,
    payload: {
      question: record.question,
      options: record.options,
      chosen: record.chosen,
      chosen_index: record.chosen_index,
      timeout_ms: record.timeout_ms,
      default_index: record.default_index,
      fallback: record.fallback,
      raw_input: record.raw_input,
    },
  });
}

export interface CliHumanGateOptions {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  /** null / 0 = 不超时 */
  timeout_ms?: number | null;
  /** 超时或 EOF 时的默认项下标 */
  default_index?: number;
}

/**
 * 编号选项 + 输入循环 + 超时默认项。
 * 输入 `2` 或选项原文均接受；非法输入重新提问；超时/EOF 落到默认项。
 */
export class CliHumanGate implements HumanGate {
  private readonly input: NodeJS.ReadableStream;
  private readonly output: NodeJS.WritableStream;
  private readonly default_timeout_ms: number | null;
  private readonly default_index: number;

  constructor(options: CliHumanGateOptions = {}) {
    this.input = options.input ?? process.stdin;
    this.output = options.output ?? process.stdout;
    this.default_timeout_ms = options.timeout_ms ?? null;
    this.default_index = options.default_index ?? 0;
  }

  async ask(question: string, options: string[]): Promise<string> {
    const record = await this.askChoice(question, options);
    return record.chosen;
  }

  askChoice(
    question: string,
    options: string[],
    overrides: { timeout_ms?: number | null; default_index?: number } = {},
  ): Promise<CliChoiceRecord> {
    if (options.length === 0) {
      throw new Error("选择题至少需要一个选项");
    }
    const timeout_ms = overrides.timeout_ms === undefined ? this.default_timeout_ms : overrides.timeout_ms;
    const default_index = clampIndex(overrides.default_index ?? this.default_index, options.length);
    const fallback_choice = options[default_index] ?? "";

    this.output.write(renderQuestion(question, options, timeout_ms, default_index));

    return new Promise<CliChoiceRecord>((resolve) => {
      const rl = createInterface({ input: this.input, output: this.output, terminal: false });
      let settled = false;
      let timer: NodeJS.Timeout | null = null;

      const finish = (record: CliChoiceRecord): void => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        rl.close();
        resolve(record);
      };

      const fallback = (reason: "timeout" | "eof"): void => {
        finish({
          question,
          options,
          timeout_ms,
          default_index,
          chosen_index: default_index,
          chosen: fallback_choice,
          fallback: reason,
          raw_input: null,
        });
      };

      rl.on("line", (line) => {
        const index = parseCliAnswer(line, options);
        if (index === null) {
          this.output.write(`无效输入：请输入 1-${options.length} 的编号，或选项原文\n`);
          return;
        }
        finish({
          question,
          options,
          timeout_ms,
          default_index,
          chosen_index: index,
          chosen: options[index] ?? "",
          fallback: null,
          raw_input: line.trim(),
        });
      });
      rl.on("close", () => fallback("eof"));

      if (timeout_ms !== null && timeout_ms > 0) {
        timer = setTimeout(() => fallback("timeout"), timeout_ms);
      }
    });
  }
}

/** 接受 `2` / `2.` / 选项原文（忽略大小写与首尾空白）；无法识别返回 null */
export function parseCliAnswer(line: string, options: string[]): number | null {
  const text = line.trim();
  if (text.length === 0) return null;
  const numeric = /^(\d+)\.?$/.exec(text);
  if (numeric?.[1] !== undefined) {
    const index = Number.parseInt(numeric[1], 10) - 1;
    return index >= 0 && index < options.length ? index : null;
  }
  const lower = text.toLowerCase();
  const index = options.findIndex((option) => option.trim().toLowerCase() === lower);
  return index >= 0 ? index : null;
}

function clampIndex(index: number, length: number): number {
  if (!Number.isInteger(index) || index < 0) return 0;
  return Math.min(index, length - 1);
}

function renderQuestion(
  question: string,
  options: string[],
  timeout_ms: number | null,
  default_index: number,
): string {
  const lines = [`? ${question}`];
  options.forEach((option, index) => {
    lines.push(`  ${index + 1}) ${option}`);
  });
  lines.push(
    timeout_ms !== null && timeout_ms > 0
      ? `输入编号后回车（超时 ${formatSeconds(timeout_ms)} 秒则默认 ${default_index + 1}）：`
      : "输入编号后回车：",
  );
  return `${lines.join("\n")}\n`;
}

function formatSeconds(ms: number): string {
  return Number.isInteger(ms / 1000) ? String(ms / 1000) : (ms / 1000).toFixed(1);
}
