// 离线 Goal worker：真实 ACP/headless 子进程，首次写坏值，收到宿主反馈后修复。
import { appendFileSync, chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const acp = process.argv.includes("--acp");
const always_fail = process.argv.includes("--always-fail");
const usage_mode = process.argv.includes("--usage-mode") ? process.argv[process.argv.indexOf("--usage-mode") + 1] : "none";
const usage = usage_mode === "none" ? undefined : { inputTokens: 6, outputTokens: 2, ...(usage_mode === "full" ? { cost: 0.02 } : {}) };
let cwd = process.cwd();
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
const report = "# Human review\n\n## 变更\nvalue.txt 对应当前目标，Draft 尚未合入。\n\n## 验收\n宿主检查 value.txt 的值；以宿主实际结果为准。\n\n## 风险\n只验证示例业务值，最终 review 与合入仍人工。\n";

function work(prompt) {
  const calls_file = join(cwd, ".goal-worker-calls");
  const calls = existsSync(calls_file) ? Number(readFileSync(calls_file, "utf8")) : 0;
  writeFileSync(calls_file, String(calls + 1));
  appendFileSync(join(cwd, ".goal-worker-prompts.jsonl"), JSON.stringify({ prompt, calls: calls + 1 }) + "\n");
  const repaired = calls > 0 && !always_fail;
  writeFileSync(join(cwd, "value.txt"), repaired ? "fixed" : "broken");
  if (process.argv.includes("--source-changes")) {
    mkdirSync(join(cwd, "src"), { recursive: true });
    rmSync(join(cwd, "src/deleted.ts"), { force: true });
    writeFileSync(join(cwd, "src/added.ts"), "export const added = true;\n");
    chmodSync(join(cwd, "value.txt"), 0o755);
  }
  return report;
}

if (!acp) {
  const text = work(process.argv.at(-1) ?? "");
  send({ type: "result", subtype: "success", result: text, session_id: "goal-headless", ...(usage === undefined ? {} : {
    usage: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens }, total_cost_usd: usage.cost,
  }) });
} else {
  const launch_options = [
    { id: "llm", name: "Model", type: "select", currentValue: "small", options: [{ value: "small", name: "Small" }, { value: "large", name: "Large" }] },
    { id: "thinking", name: "Effort", type: "select", currentValue: "low", options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }] },
    { id: "workflow", name: "Mode", type: "select", currentValue: "plan", options: [{ value: "plan", name: "Plan" }, { value: "code", name: "Code" }] },
  ];
  const lines = createInterface({ input: process.stdin });
  lines.on("line", line => {
    const { id, method, params } = JSON.parse(line);
    const respond = result => send({ jsonrpc: "2.0", id, result });
    if (method === "initialize") respond({ protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: "goal-fixture", version: "1" } });
    else if (method === "session/new") { cwd = params.cwd; respond({ sessionId: "goal-acp", ...(process.argv.includes("--launch-config") ? { configOptions: launch_options } : {}) }); }
    else if (method === "session/set_config_option") {
      launch_options.find(option => option.id === params.configId).currentValue = params.value;
      respond({ configOptions: launch_options });
    }
    else if (method === "session/prompt") {
      const text = work(params.prompt[0].text);
      if (process.argv.includes("--drift-model")) {
        launch_options[0].currentValue = "small";
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "goal-acp", update: { sessionUpdate: "config_option_update", configOptions: launch_options } } });
      }
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "goal-acp", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
      respond({ stopReason: "end_turn", ...(usage === undefined ? {} : { usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.inputTokens + usage.outputTokens } }) });
    }
  });
}
