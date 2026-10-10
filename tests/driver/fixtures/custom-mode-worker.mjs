// 自定义wrapper替身：完整argv分支决定实现/评审，记录调用，不请求实际模型。
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const value = flag => args[args.indexOf(flag) + 1];
const action = value("--operation"); const readonly = value("--readonly") === "true";
const prompt = value("--prompt"); const model = value("--model"); const effort = value("--effort");
if (!prompt || !model || !effort || !["write", "review"].includes(action) || (action === "write") === readonly) process.exit(2);
appendFileSync(join(process.cwd(), ".mode-calls.jsonl"), JSON.stringify({ action, readonly, model, effort, prompt, args }) + "\n");
if (action === "write") writeFileSync(join(process.cwd(), "value.txt"), "fixed");
else if (readFileSync(join(process.cwd(), "value.txt"), "utf8") !== "fixed") process.exit(3);
if (args.includes("--emit-write-tool")) process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "file_change", changes: [{ path: "value.txt" }] } }) + "\n");
const report = "# Human review\n\n## 变更\nvalue.txt已按当前目标修复。\n\n## 验收\n以宿主实测结果为准。\n\n## 风险\n仅验证示例业务值，最终gate保持人工。\n";
const result = prompt.startsWith("# Context Session Agent") ? JSON.stringify({ summary: "当前交付等待最终人审", next_action: { kind: "wait", reason: "未决人工gate", evidence: [{ source: "workflow", id: "review" }] }, risks: [] }) : report;
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", session_id: "custom-mode-session", result }) + "\n");
