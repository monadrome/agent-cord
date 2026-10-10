#!/usr/bin/env node
// CLI 能力诊断替身：只接受固定帮助命令，拒绝任何实际模型调用。
import { appendFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
const argv = process.argv.slice(2); const end = argv.indexOf("--probe-args");
const flags = end === -1 ? [] : argv.slice(0, end); const args = end === -1 ? argv : argv.slice(end + 1);
const value = flag => flags[flags.indexOf(flag) + 1];
const profile = flags.includes("--profile") ? value("--profile") : process.env.CORD_INSPECT_PROFILE;
const scenario = flags.includes("--scenario") ? value("--scenario") : process.env.CORD_INSPECT_SCENARIO ?? "normal";
const record = flags.includes("--record") ? value("--record") : process.env.CORD_INSPECT_RECORD;
if (record !== undefined) appendFileSync(record, JSON.stringify({ args }) + "\n");
if (![["--version"], ["--help"], ["exec", "--help"], ["exec", "resume", "--help"]].some(allowed => JSON.stringify(allowed) === JSON.stringify(args))) {
  process.stderr.write("PRIVATE_UNEXPECTED_MODEL_CALL\n"); process.exit(2);
}
if (flags.includes("--pid-file")) writeFileSync(value("--pid-file"), String(process.pid));
if (flags.includes("--child-pid-file")) {
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setTimeout(()=>{},60000)"], { stdio: "ignore" });
  writeFileSync(value("--child-pid-file"), String(child.pid));
}
if (scenario === "hang" || (scenario === "hang-help" && args.at(-1) === "--help")) {
  process.on("SIGTERM", () => undefined); await new Promise(resolve => setTimeout(resolve, 60000));
}
if (scenario === "fail") { process.stderr.write("PRIVATE_ENV_MARKER SECRET_PATH\n"); process.exit(1); }
if (scenario === "large") { await new Promise(resolve => process.stdout.write("PRIVATE_ENV_MARKER".repeat(20000), resolve)); process.exit(0); }
if (scenario === "slow") await new Promise(resolve => setTimeout(resolve, 180));
if (args[0] === "--version") {
  process.stdout.write(scenario === "unknown" ? "PRIVATE_ENV_MARKER\n" : profile === "codex" ? "codex-cli 1.2.3\n" : profile === "claude" ? "2.3.4 (Claude Code)\n" : "3.4.5\n");
  process.exit(0);
}
if (scenario === "unknown-help") { process.stdout.write("Usage: unrelated --model --help\nPRIVATE_ENV_MARKER"); process.exit(0); }
const usage = profile === "codex" ? args.includes("resume") ? "codex exec resume" : "codex exec" : profile;
const options = ["  -h, --help  Show help", "  -m, --model <MODEL>  Choose model"];
if (profile === "codex") options.push("  -c, --config <KEY=VALUE>  Set config", "      --json  Emit JSON");
if (profile === "kimi") options.push("  -S, --session [id]  Resume session");
if (profile === "claude") options.push("  --effort <level>  Effort", "  --max-turns <n>  Turns", "  --max-budget-usd <n>  Budget", "  --append-system-prompt <TEXT>  Prompt", "  --agent <name>  Role", "  --agents <json>  Definitions", "  --resume <id>  Resume", "  --permission-mode <mode>  (choices: plan, auto, manual)");
if (profile === "claude" && scenario !== "missing-bare") options.push("  --bare  Minimal mode");
if (scenario === "prose-only") {
  const index = options.findIndex(option => option.includes("--model")); options.splice(index, 1);
  options.push("Description: examples can mention --model; this is not an option definition");
}
if (scenario === "no-auto") {
  const index = options.findIndex(option => option.includes("--permission-mode"));
  options[index] = "  --permission-mode <mode>  (choices: plan, manual)";
}
if (scenario === "quoted-auto") {
  const index = options.findIndex(option => option.includes("--permission-mode"));
  options[index] = '  --permission-mode <mode>  (choices: "plan", "auto", "manual")';
}
if (scenario === "auto-no-choices") {
  const index = options.findIndex(option => option.includes("--permission-mode"));
  options[index] = '  --permission-mode <mode>  Manage auto approvals';
}
await new Promise(resolve => process.stdout.write(`Usage: ${usage} [OPTIONS]\n\nOptions:\n${options.join("\n")}\nPRIVATE_ENV_MARKER\n`, resolve));
process.exit(0);
