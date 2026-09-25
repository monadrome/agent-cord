#!/usr/bin/env node
// ACP 驱动的测试替身：极简 JSON-RPC 2.0 over stdio agent。
// 只用于 tests/driver，不打网络、不调用真实 CLI。
//
// 开关（经 AcpDriver 的 args 注入）：
//   --mode <default|permission|hang|hang-after-permission|fail-prompt|fail-load|bad-version>
//   --pid-file <path>   写自己的 pid（验证进程清理）
//   --record <path>     把观测到的客户端→agent 消息追加成 JSONL（验证 session/load 走位、
//                       cwd 透传、permission 应答、session/cancel 等）
import { writeFileSync, appendFileSync } from "node:fs";

const argv = process.argv.slice(2);
const flagValue = (name) => {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
};

const mode = flagValue("--mode") ?? "default";
const pidFile = flagValue("--pid-file");
const recordFile = flagValue("--record");

if (pidFile !== undefined) writeFileSync(pidFile, String(process.pid));
const record = (entry) => {
  if (recordFile !== undefined) appendFileSync(recordFile, `${JSON.stringify(entry)}\n`);
};

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const respond = (id, result) => send({ jsonrpc: "2.0", id, result });
const respondError = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });
const notify = (method, params) => send({ jsonrpc: "2.0", method, params });

const sessionId = "acp-session-1";
let permissionRequestId = 0;
// 挂起的 prompt 请求 id：permission 应答后决定是否作答（模拟挂死）
let pendingPromptId = undefined;
let promptText = "";

const update = (value) => notify("session/update", { sessionId, update: value });
const textChunk = (text) => update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });

function handlePrompt(params) {
  record({ event: "prompt", sessionId: params.sessionId, text: params.prompt?.[0]?.text ?? null });
  promptText = params.prompt?.[0]?.text ?? "";

  textChunk("hello ");
  update({
    sessionUpdate: "tool_call",
    toolCallId: "call-1",
    title: "read file",
    kind: "read",
    status: "pending",
    rawInput: { path: "src/core/ports.ts" },
  });

  if (mode === "hang") {
    // 永不作答：验证平台侧 wall-clock 超时 + session/cancel
    return;
  }

  if (mode === "permission" || mode === "hang-after-permission") {
    permissionRequestId += 1;
    send({
      jsonrpc: "2.0",
      id: `perm-${permissionRequestId}`,
      method: "session/request_permission",
      params: {
        sessionId,
        toolCall: { toolCallId: "call-1", title: "write file", kind: "edit" },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        ],
      },
    });
    // 等应答：见 handleMessage 的 permission 分支
    return;
  }

  finishPrompt();
}

function finishPrompt() {
  textChunk("done");
  if (pendingPromptId === undefined) return;
  const id = pendingPromptId;
  pendingPromptId = undefined;
  respond(id, { stopReason: "end_turn" });
}

function handleMessage(message) {
  const { id, method, params } = message;

  if (method === "initialize") {
    respond(id, {
      protocolVersion: mode === "bad-version" ? 2 : 1,
      agentCapabilities: { loadSession: true },
      agentInfo: { name: "fake-acp-agent", version: "0.0.1" },
    });
    return;
  }

  if (method === "session/new") {
    record({ event: "session/new", cwd: params.cwd, mcpServers: params.mcpServers ?? null });
    respond(id, { sessionId });
    return;
  }

  if (method === "session/load") {
    record({ event: "session/load", sessionId: params.sessionId, cwd: params.cwd });
    if (mode === "fail-load") {
      respondError(id, -32601, "session/load not supported");
      return;
    }
    respond(id, {});
    return;
  }

  if (method === "session/prompt") {
    pendingPromptId = id;
    if (mode === "fail-prompt") {
      pendingPromptId = undefined;
      respondError(id, -32000, "prompt rejected by agent");
      return;
    }
    handlePrompt(params);
    return;
  }

  if (method === "session/cancel") {
    record({ event: "session/cancel", sessionId: params?.sessionId ?? null });
    return; // notification：无需应答
  }

  // session/request_permission 的应答（本进程作为请求发起方收到 result）
  if (method === undefined && typeof id === "string" && id.startsWith("perm-")) {
    const outcome = message.error !== undefined ? { outcome: "error" } : message.result?.outcome;
    record({ event: "permission_response", outcome });
    if (mode === "hang-after-permission") return; // 让 prompt 一直挂着
    finishPrompt();
    return;
  }

  if (id !== undefined && id !== null) respondError(id, -32601, `unknown method ${method}`);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf("\n");
  while (index !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line.length > 0) {
      try {
        handleMessage(JSON.parse(line));
      } catch (error) {
        process.stderr.write(`fake-acp-agent: bad message: ${String(error)}\n`);
      }
    }
    index = buffer.indexOf("\n");
  }
});
process.stdin.on("end", () => {
  record({ event: "stdin_end", promptText });
  process.exit(0);
});
