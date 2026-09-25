#!/usr/bin/env node
// headless 驱动的测试替身：按 argv 打印各家 CLI 的 stream-json / JSONL 形态。
// 只用于 tests/driver，不打网络、不调用真实 CLI。
//
// 支持的开关（由 HeadlessDriver 的 prefixArgs 注入）：
//   --mode <claude|kimi|codex|plain|garbage|fail>  输出的行形态
//   --sleep <ms>                                   打印首行后睡多久（模拟卡死/超时）
//   --pid-file <path>                              把自己的 pid 写进去（验证进程清理）
//   --child-pid-file <path>                        派生一个孙进程并写 pid（验证进程树清理）
//   --help                                         打印含 "acp" 的帮助（registry 探测用）
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const flagValue = (name) => {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
};
const hasFlag = (name) => argv.includes(name);
const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (hasFlag("--help")) {
  process.stdout.write(
    [
      "fake-cli [options] [command]",
      "",
      "Options:",
      "  -p, --prompt <prompt>         Run one prompt non-interactively",
      "      --output-format <format>  text | stream-json",
      "",
      "Commands:",
      "  acp   Run fake-cli as an Agent Client Protocol server over stdio",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

const pidFile = flagValue("--pid-file");
if (pidFile !== undefined) writeFileSync(pidFile, String(process.pid));

const mode = flagValue("--mode") ?? "claude";
const sleepMs = Number(flagValue("--sleep") ?? 0);
const sessionId = "fake-session-1";
const prompt = flagValue("-p") ?? argv[argv.length - 1] ?? "";

write({
  type: "system",
  subtype: "init",
  session_id: sessionId,
  pid: process.pid,
  cwd: process.cwd(),
  prompt,
  argv,
});

const childPidFile = flagValue("--child-pid-file");
if (childPidFile !== undefined) {
  const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
    stdio: "ignore",
  });
  writeFileSync(childPidFile, String(grandchild.pid));
}

switch (mode) {
  case "claude": {
    write({
      type: "assistant",
      session_id: sessionId,
      message: { content: [{ type: "text", text: "reading files" }] },
    });
    write({
      type: "assistant",
      session_id: sessionId,
      message: {
        content: [{ type: "tool_use", name: "Read", input: { file_path: "src/core/ports.ts" } }],
      },
    });
    if (sleepMs > 0) await sleep(sleepMs);
    write({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "final answer",
      session_id: sessionId,
    });
    break;
  }

  case "kimi": {
    write({ role: "assistant", content: "thinking out loud" });
    write({
      role: "assistant",
      tool_calls: [
        { type: "function", id: "call-1", function: { name: "read_file", arguments: '{"path":"a.ts"}' } },
      ],
    });
    write({ role: "tool", tool_call_id: "call-1", content: "file content" });
    if (sleepMs > 0) await sleep(sleepMs);
    write({ role: "assistant", content: "kimi final" });
    break;
  }

  case "codex": {
    write({ type: "thread.started", thread_id: "thread-1" });
    write({ type: "item.completed", item: { id: "item-1", type: "agent_message", text: "codex says hi" } });
    write({ type: "item.completed", item: { id: "item-2", type: "command_execution", command: "ls -la" } });
    if (sleepMs > 0) await sleep(sleepMs);
    write({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } });
    break;
  }

  case "plain": {
    process.stdout.write("plain line one\nplain line two\n");
    break;
  }

  case "garbage": {
    // 非 JSON 行、可解析但形态陌生的行、以及没有换行结尾的残行
    process.stdout.write('not json at all\n{"weird":true}\npartial-without-newline');
    break;
  }

  case "fail": {
    process.stderr.write("boom: model unavailable\n");
    process.exit(3);
    break;
  }

  default: {
    process.stderr.write(`fake-cli: unknown --mode ${mode}\n`);
    process.exit(2);
  }
}
