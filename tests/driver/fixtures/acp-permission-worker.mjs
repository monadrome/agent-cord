// 合作 ACP 文件工具 fixture：只有明确的一次授权后才执行文件操作。
import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const flag = name => argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined;
let cwd = process.cwd(); let prompt_id; let prompt = ""; let step = 0;
const mode = flag("--mode") ?? "edit";
const target = flag("--path") ?? "src/value.txt";
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
const respond = (id, result) => send({ jsonrpc: "2.0", id, result });
const request = () => send({ jsonrpc: "2.0", id: "permission-" + step, method: "session/request_permission", params: {
  sessionId: "permission-worker", toolCall: { toolCallId: "file-" + step, kind: step === 0 ? "read" : mode === "execute" ? "execute" : "edit",
    title: "PRIVATE_PERMISSION_TITLE", locations: [{ path: resolve(cwd, step === 0 ? "src/value.txt" : target) }], rawInput: { value: "PRIVATE_PERMISSION_INPUT" } },
  options: [{ optionId: "forever", name: "PRIVATE_PERMISSION_LABEL", kind: "allow_always" }, { optionId: "once", name: "一次", kind: "allow_once" }, { optionId: "reject", name: "拒绝", kind: "reject_once" }],
} });
const finish = granted => {
  const text = "# Human review\n\n## 变更\n" + (granted ? "已写入声明源码位置。" : "未获授权，保留文件。") + "\n\n## 验收\n宿主检查实际文件内容。\n\n## 风险\nDraft，最终人审与合入仍人工。\n";
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "permission-worker", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
  respond(prompt_id, { stopReason: "end_turn" });
};
const lines = createInterface({ input: process.stdin });
lines.on("line", line => {
  const message = JSON.parse(line); const { id, method, params } = message;
  if (method === "initialize") respond(id, { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: "permission-worker", version: "1" } });
  else if (method === "session/new") { cwd = params.cwd; respond(id, { sessionId: "permission-worker" }); }
  else if (method === "session/prompt") {
    prompt_id = id; prompt = params.prompt[0]?.text ?? "";
    const calls = join(cwd, ".permission-worker-calls"); writeFileSync(calls, String((existsSync(calls) ? Number(readFileSync(calls, "utf8")) : 0) + 1));
    request();
  } else if (method === undefined && String(id).startsWith("permission-")) {
    const outcome = message.result?.outcome;
    appendFileSync(join(cwd, ".permission-worker-log.jsonl"), JSON.stringify({ step, outcome }) + "\n");
    if (outcome?.outcome !== "selected" || outcome.optionId !== "once") { finish(false); return; }
    if (step === 0) { readFileSync(join(cwd, "src/value.txt"), "utf8"); step++; request(); }
    else { writeFileSync(resolve(cwd, target), "fixed"); finish(true); }
  }
});
