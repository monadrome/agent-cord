// 真实OS反例与Goal替身：明确报告访问结果，不读取真实用户凭据。
import { existsSync, readFileSync, writeFileSync, renameSync, linkSync, symlinkSync, chmodSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import http from "node:http";
const args = process.argv.slice(2); const value = flag => args[args.indexOf(flag) + 1];
const acp = args.includes("--acp"); const operation = args.includes("--operation") ? value("--operation") : "observe";
if (args.includes("--version")) { process.stdout.write("codex-cli 1.2.3\n"); process.exit(0); }
if (args.includes("--help")) { process.stdout.write("Usage: codex exec" + (args.includes("resume") ? " resume" : "") + " [OPTIONS]\n -h, --help Show help\n -m, --model Choose model\n --json Emit JSON\n"); process.exit(0); }
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
const attempt = work => { try { work(); return "allowed"; } catch { return "blocked"; } };
const report = "# Human review\n\n## 变更\nvalue.txt修复为fixed，保持Draft。\n\n## 验收\n以宿主实测证据为准。\n\n## 风险\n仅覆盖示例业务，最终人审仍未决。\n";
const options = [{ id: "workflow", type: "select", name: "Mode", currentValue: "code", options: [{ value: "code", name: "Code" }, { value: "plan", name: "Plan" }] }];
function resume(session) { if (session !== "sandbox-session" || !existsSync(join(process.env.HOME, "session.txt"))) throw new Error("SESSION_NOT_FOUND"); }
async function work(prompt) {
  const state = join(process.env.HOME, "session.txt"); const count = existsSync(state) ? Number(readFileSync(state, "utf8")) : 0; writeFileSync(state, String(count + 1));
  if (operation === "documents") {
    const root = process.env.CORD_INPUT_DIR; const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
    const texts = manifest.files.map(file => readFileSync(join(root, "documents", file.file), "utf8"));
    const first = join(root, "documents", manifest.files[0].file);
    return JSON.stringify({ directory: root, manifest, middle: texts.some(text => text.includes("MID_ONLY")), prompt_chars: prompt.length, literal: prompt.includes("{{cord_input_dir}}"),
      write: attempt(() => writeFileSync(first, "INVALID_INPUT")), rename: attempt(() => renameSync(root, join(process.env.TMPDIR, "MOVED_INPUT"))),
      chmod: attempt(() => chmodSync(first, 0o600)), manifest_write: attempt(() => writeFileSync(join(root, "manifest.json"), "{}")),
      hardlink: attempt(() => { linkSync(first, join(process.env.TMPDIR, "alias-input")); writeFileSync(join(process.env.TMPDIR, "alias-input"), "INVALID_INPUT"); }),
      facts: attempt(() => readFileSync("cord/events.jsonl")), count: count + 1,
      root_matches_prompt: prompt.includes("input_documents_root: " + JSON.stringify(root)) });
  }
  if (operation === "never") {
    const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" });
    process.on("SIGTERM", () => {}); const text = JSON.stringify({ pids: [process.pid, child.pid], home: process.env.HOME });
    if (acp) send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sandbox-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
    else send({ type: "result", subtype: "success", result: text, session_id: "sandbox-session" });
    await new Promise(resolve => setInterval(resolve, 60000)); return text;
  }
  if (operation === "workflow") {
    const readonly = acp ? options[0].currentValue === "plan" : value("--readonly") === "true";
    let input_risk = "";
    if (args.includes("--tamper-local-tests") && !readonly) {
      writeFileSync("local-tests.cjs", "process.exit(0)\n");
      const external_write = args.includes("--asset-file") ? attempt(() => writeFileSync(value("--asset-file"), "process.exit(0)\n")) : "not-requested";
      appendFileSync(join(process.env.HOME, "trusted-probes.jsonl"), JSON.stringify({ external_write }) + "\n");
    }
    if (args.includes("--require-documents") && !prompt.startsWith("# Context Session Agent")) {
      const directory = process.env.CORD_INPUT_DIR; const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
      const prd = readFileSync(join(directory, "documents/prd.md"), "utf8"); const number = prd.match(/MID_ONLY_VALUE=(\d+)/)?.[1];
      const manual = readFileSync(join(directory, "documents/manual.md"), "utf8");
      if (number === undefined || !manual.includes("MANUAL_MID_ONLY")) throw new Error("FULL_INPUT_MIDDLE_MISSING");
      const files = manifest.files.map(file => file.file);
      if (files.includes(readonly ? "findings.md" : "review.md")) throw new Error("OWN_OUTPUT_IN_INPUTS");
      if (readonly) {
        if (!files.includes("review.md")) throw new Error("REVIEW_GUIDE_MISSING");
        if (readFileSync("document-value.txt", "utf8") !== number) input_risk = "\nINPUT_VALUE_MISMATCH：当前代码与最新PRD中段不一致，不能放行。\n";
      }
      else writeFileSync("document-value.txt", number);
      appendFileSync(join(process.env.HOME, "input-observations.jsonl"), JSON.stringify({ readonly, directory, files, number, prompt_chars: prompt.length,
        prompt_has_middle: prompt.includes("MID_ONLY_VALUE="), prompt_has_manual_middle: prompt.includes("MANUAL_MID_ONLY"), manifest }) + "\n");
    }
    if (!readonly) writeFileSync("value.txt", args.includes("--never-fix") || args.includes("--first-broken") && count === 0 ? "broken" : "fixed"); else if (readFileSync("value.txt", "utf8") !== "fixed") throw Error("CODE_NOT_FIXED");
    return prompt.startsWith("# Context Session Agent") ? JSON.stringify({ summary: "当前隔离Goal已交付，等待最终人审", next_action: { kind: "wait", reason: "最终人工gate未决", evidence: [{ source: "workflow", id: "review" }] }, risks: [] }) : report + input_risk;
  }
  const observed = { home: process.env.HOME, tmp: process.env.TMPDIR, count: count + 1, source: readFileSync("value.txt", "utf8"),
    source_write: attempt(() => writeFileSync("value.txt", "fixed")), facts_read: attempt(() => readFileSync("cord/events.jsonl")),
    facts_write: attempt(() => writeFileSync("cord/events.jsonl", "INVALID_FACT")), git_read: attempt(() => readFileSync(".git/config")),
    git_write: attempt(() => writeFileSync(".git/config", "INVALID_GIT")), private_env: process.env.CORD_FAKE_PRIVATE !== undefined,
    auth_env: process.env.CORD_FAKE_AUTH === "FIXTURE_TOKEN", literal: args.includes("--literal") ? value("--literal") : null,
    session: acp ? "sandbox-session" : args.includes("--session") ? value("--session") : null };
  if (args.includes("--alias-probes")) {
    observed.facts_rename = attempt(() => renameSync("cord", "CORD_MOVED"));
    observed.facts_link_write = attempt(() => { linkSync("cord/events.jsonl", "linked-fact"); writeFileSync("linked-fact", "INVALID_FACT"); });
    observed.facts_symlink_write = attempt(() => { symlinkSync("cord/events.jsonl", "symlink-fact"); writeFileSync("symlink-fact", "INVALID_FACT"); });
  }
  if (args.includes("--outside")) observed.outside = attempt(() => writeFileSync(value("--outside"), "INVALID_OUTSIDE"));
  if (args.includes("--secret")) observed.secret = attempt(() => readFileSync(value("--secret")));
  if (args.includes("--url")) {
    const proxy = new URL(process.env.HTTP_PROXY); const target = new URL(value("--url")); observed.proxy_host = proxy.hostname;
    observed.network = await new Promise(resolve => {
      const auth = proxy.username === "" ? {} : { "Proxy-Authorization": "Basic " + Buffer.from(decodeURIComponent(proxy.username) + ":" + decodeURIComponent(proxy.password)).toString("base64") };
      const request = http.get({ hostname: proxy.hostname, port: proxy.port, path: target.href, headers: { Host: target.host, ...auth } }, response => {
        response.resume(); response.on("end", () => resolve(response.statusCode));
      }); request.on("error", error => { observed.network_error = error.code ?? error.name; resolve("blocked"); }); request.setTimeout(1500, () => { request.destroy(); resolve("blocked"); });
    });
  }
  if (args.includes("--exit-failure")) { send({ type: "result", subtype: "success", result: "SPOOFED_SUCCESS", session_id: "sandbox-session" }); process.exit(3); }
  return JSON.stringify(observed);
}
if (!acp) {
  if (args.includes("--session")) resume(value("--session"));
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
  const result = await work(args.includes("--prompt") ? value("--prompt") : Buffer.concat(chunks).toString("utf8")); send({ type: "result", subtype: "success", result, session_id: "sandbox-session" });
} else {
  const lines = createInterface({ input: process.stdin });
  lines.on("line", async line => {
    const { id, method, params } = JSON.parse(line); const respond = result => send({ jsonrpc: "2.0", id, result });
    try {
      if (method === "initialize") respond({ protocolVersion: 1, agentCapabilities: { loadSession: true }, agentInfo: { name: "sandbox-fixture", version: "1" } });
      else if (method === "session/new") respond({ sessionId: "sandbox-session", configOptions: options });
      else if (method === "session/load") { resume(params.sessionId); respond({ configOptions: options }); }
      else if (method === "session/set_config_option") { options[0].currentValue = params.value; respond({ configOptions: options }); }
      else if (method === "session/prompt") {
        const text = await work(params.prompt[0].text); send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sandbox-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } }); respond({ stopReason: "end_turn" });
      } else if (method === "session/cancel" && id !== undefined) respond({});
    } catch { send({ jsonrpc: "2.0", id, error: { code: -32000, message: "SANDBOX_FIXTURE_FAILURE" } }); }
  });
}
