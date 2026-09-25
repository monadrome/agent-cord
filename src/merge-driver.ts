#!/usr/bin/env node
/**
 * Git merge driver for cord event logs (ADR-0020 决策 3）。
 * 输入是 %O、%A、%B，输出覆盖 %A；事件流本身仍由 doctor 检查完整性。
 */
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { canonicalJson, orderEvents } from "./core/hash.js";
import { EventEnvelopeSchema, type EventEnvelope } from "./core/schema.js";

function parseLog(text: string, filePath: string): EventEnvelope[] {
  const events: EventEnvelope[] = [];
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    if (raw.trim().length === 0) continue;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      throw new Error(`${filePath}:${index + 1} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
    }
    const parsed = EventEnvelopeSchema.safeParse(value);
    if (!parsed.success) {
      throw new Error(`${filePath}:${index + 1} 不符合 EventEnvelope v1：${parsed.error.message}`);
    }
    events.push(parsed.data);
  }
  return events;
}

export function mergeEventLogs(inputs: readonly { path: string; text: string }[]): string {
  const byId = new Map<string, EventEnvelope>();
  for (const input of inputs) {
    for (const event of parseLog(input.text, input.path)) {
      const existing = byId.get(event.event_id);
      if (existing !== undefined && canonicalJson(existing) !== canonicalJson(event)) {
        throw new Error(`event_id ${event.event_id} 在合并输入中内容不一致`);
      }
      byId.set(event.event_id, event);
    }
  }
  const ordered = orderEvents([...byId.values()]);
  return ordered.length === 0 ? "" : `${ordered.map(canonicalJson).join("\n")}\n`;
}

async function main(args: string[]): Promise<void> {
  if (args.length !== 3) throw new Error("用法：cord-merge-driver %O %A %B");
  const inputs = await Promise.all(
    args.map(async (path) => ({ path, text: await readFile(path, "utf8") })),
  );
  const merged = mergeEventLogs(inputs);
  const target = args[1];
  if (target === undefined) throw new Error("缺少 %A 输出路径");
  const temporary = join(dirname(target), `.events.merge-${process.pid}-${Date.now()}.tmp`);
  await writeFile(temporary, merged, "utf8");
  await rename(temporary, target);
}

if (process.argv[1]?.endsWith("merge-driver.js") === true) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
