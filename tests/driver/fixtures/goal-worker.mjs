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

function work(prompt, configuration) {
  const calls_file = join(cwd, ".goal-worker-calls");
  const calls = existsSync(calls_file) ? Number(readFileSync(calls_file, "utf8")) : 0;
  writeFileSync(calls_file, String(calls + 1));
  appendFileSync(join(cwd, ".goal-worker-prompts.jsonl"), JSON.stringify({ prompt, calls: calls + 1, ...(configuration === undefined ? {} : { configuration }) }) + "\n");
  if (process.argv.includes("--profile-worker") && configuration?.workflow === "plan") {
    if (process.argv.includes("--profile-supervisor") && prompt.startsWith("# Context Session Agent")) {
      const context = JSON.parse(prompt.split("\n").find(line => line.startsWith("execution_context: ")).slice("execution_context: ".length));
      const blocker = context.goals.find(goal => goal.status === "blocked");
      if (blocker === undefined) throw new Error("只读supervisor fixture缺少当前blocker");
      return JSON.stringify({ summary: "Goal达到自动修复边界，等待明确处理卡点",
        next_action: { kind: "ask_human", question: "是否补充最新事实后明确重新执行？", options: ["修复并重新验收", "停止目标"],
          reason: "原预算已耗尽，问答不等于新预算或最终gate批准", evidence: [{ source: "goal", id: blocker.event_id }] }, risks: ["代码尚无当前自测通过证据"] });
    }
    if (readFileSync(join(cwd, "value.txt"), "utf8") !== "fixed") throw new Error("只读fixture观察到业务值未修复");
    return prompt.startsWith("# Context Session Agent") ? JSON.stringify({ summary: "最新只读配置观察等待最终人审",
      next_action: { kind: "wait", reason: "最终gate人工未决", evidence: [{ source: "workflow", id: "review" }] }, risks: [] }) : report;
  }
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
    ...(process.argv.includes("--provider-config") ? [{ id: "provider", name: "Provider", type: "select", currentValue: "openai", options: [{ value: "openai", name: "OpenAI" }, { value: "anthropic", name: "Anthropic" }] }] : []),
    { id: "llm", name: "Model", type: "select", currentValue: "small", options: [{ value: "small", name: "Small" }, { value: "large", name: "Large" }] },
    { id: "thinking", name: "Effort", type: "select", currentValue: "low", options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }] },
    { id: "workflow", name: "Mode", type: "select", currentValue: "plan", options: [{ value: "plan", name: "Plan" }, { value: "code", name: "Code" }] },
    ...(process.argv.includes("--profile-worker") ? [{ id: "extended", name: "Extension", type: "boolean", currentValue: false }] : []),
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
      const text = work(params.prompt[0].text, process.argv.includes("--provider-config") ? Object.fromEntries(launch_options.map(option => [option.id, option.currentValue])) : undefined);
      if (process.argv.includes("--drift-model")) {
        launch_options.find(option => option.id === "llm").currentValue = "small";
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "goal-acp", update: { sessionUpdate: "config_option_update", configOptions: launch_options } } });
      }
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "goal-acp", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
      respond({ stopReason: "end_turn", ...(usage === undefined ? {} : { usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.inputTokens + usage.outputTokens } }) });
    }
  });
}
