// 离线自动升级 fixture：只使用宿主给出的结构化 Goal。
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const flag = name => argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined;
const mode = flag("--mode") ?? "ask";
let cwd = process.cwd();
const send = value => process.stdout.write(JSON.stringify(value) + "\n");

async function work(prompt) {
  const calls_file = join(cwd, ".goal-supervisor-calls");
  const calls = (existsSync(calls_file) ? Number(readFileSync(calls_file, "utf8")) : 0) + 1;
  writeFileSync(calls_file, String(calls));
  appendFileSync(join(cwd, ".goal-supervisor-prompts.jsonl"), JSON.stringify({ prompt }) + "\n");
  await new Promise(resolve => setTimeout(resolve, Number(flag("--sleep") ?? "0")));
  const context = JSON.parse(prompt.split("\n").find(line => line.startsWith("execution_context: ")).slice("execution_context: ".length));
  const goal = context.goals?.find(item => item.status === "blocked");
  if (goal === undefined) throw new Error("missing current goal blocker");
  if (mode === "invalid" || (mode === "invalid-once" && calls === 1)) return "非 JSON 升级回复";
  return JSON.stringify({
    summary: "Goal 已达到自动修复边界，需要人工决定下一步",
    next_action: mode === "advance" ? { kind: "advance", node_id: goal.node_id, reason: "错误地继续", evidence: [{ source: "goal", id: goal.event_id }] } : {
      kind: mode === "wait" ? "wait" : "ask_human",
      ...(mode === "wait" ? {} : { question: "是否补充必要事实后重新执行，或终止当前目标？", options: ["补充事实", "终止目标"] }),
      reason: "Goal blocked；supervisor 只生成 Draft，不扩充预算或批准 gate。",
      evidence: [{ source: mode === "missing-evidence" ? "workflow" : "goal", id: mode === "missing-evidence" ? goal.node_id : goal.event_id }],
    },
    risks: ["当前代码未形成可交付的自测通过结果"],
  });
}

if (!argv.includes("--acp")) {
  const text = await work(argv.at(-1) ?? "");
  send({ type: "result", subtype: "success", result: text, session_id: "goal-supervisor" });
} else {
  const lines = createInterface({ input: process.stdin });
  lines.on("line", async line => {
    const { id, method, params } = JSON.parse(line);
    const respond = result => send({ jsonrpc: "2.0", id, result });
    if (method === "initialize") respond({ protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: "goal-supervisor", version: "1" } });
    else if (method === "session/new") { cwd = params.cwd; respond({ sessionId: "goal-supervisor" }); }
    else if (method === "session/prompt") {
      try {
        const text = await work(params.prompt[0].text);
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "goal-supervisor", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
        respond({ stopReason: "end_turn" });
      } catch { send({ jsonrpc: "2.0", id, error: { code: -32000, message: "Goal fixture failed" } }); }
    }
  });
}
