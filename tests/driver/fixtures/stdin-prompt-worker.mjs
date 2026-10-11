#!/usr/bin/env node
// stdin协议替身：记录实际字节/argv，按任务权限实现或只读分析，不调用模型。
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2); const value = flag => args[args.indexOf(flag) + 1];
if (args.includes("--pid-file")) writeFileSync(value("--pid-file"), String(process.pid));
if (args.includes("--never-read")) await new Promise(resolve => setTimeout(resolve, 60000));
const chunks = []; for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const input = Buffer.concat(chunks); const prompt = input.toString("utf8");
if (args.includes("--version") || args.includes("--help")) {
  appendFileSync(join(process.cwd(), ".stdin-probes.jsonl"), JSON.stringify({ args, input_hex: input.toString("hex") }) + "\n");
  process.stdout.write(args.includes("--version") ? "codex-cli 1.2.3\n" : `Usage: codex exec${args.includes("resume") ? " resume" : ""} [OPTIONS]\n  -h, --help Show help\n  -m, --model <MODEL> Choose model\n      --json Emit JSON\n`);
  process.exit(0);
}
const readonly = args.includes('sandbox_mode="read-only"') || (args.includes("--readonly") && value("--readonly") === "true");
const operation = args.includes("--operation") ? value("--operation") : process.env.CORD_STDIN_OPERATION ?? "echo";
const model = args.includes("--model") ? value("--model") : null;
const effort = args.includes("--effort") ? value("--effort") : args.find(arg => arg.startsWith("model_reasoning_effort=")) ?? null;
const session = args.includes("--session") ? value("--session") : args.includes("resume") ? args[args.indexOf("resume") + 1] : null;
const fact = { args, prompt, input_hex: input.toString("hex"), readonly, model, effort, session, operation };
appendFileSync(join(process.cwd(), ".stdin-calls.jsonl"), JSON.stringify(fact) + "\n");
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "stdin-fixture", ...fact }) + "\n");
if (args.includes("--sleep")) await new Promise(resolve => setTimeout(resolve, Number(value("--sleep"))));
let result = "# 原文回执\n" + prompt;
if (operation === "workflow") {
  if (!readonly) writeFileSync(join(process.cwd(), "value.txt"), "fixed");
  else if (readFileSync(join(process.cwd(), "value.txt"), "utf8") !== "fixed") process.exit(3);
  result = prompt.startsWith("# Context Session Agent") ? JSON.stringify({ summary: "最新需求下等待最终人审", next_action: { kind: "wait", reason: "最终gate人工未决", evidence: [{ source: "workflow", id: "review" }] }, risks: [] })
    : "# Human review\n\n## 变更\n业务值已修复为fixed，仍为Draft。\n\n## 验收\n以宿主实际检查为准。\n\n## 风险\n仅验证示例业务值，最终gate人工。\n";
}
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", session_id: "stdin-fixture", result }) + "\n");
