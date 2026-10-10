#!/usr/bin/env node
// ACP 驱动的测试替身：极简 JSON-RPC 2.0 over stdio agent。
// 只用于 tests/driver，不打网络、不调用真实 CLI。
//
// 开关（经 AcpDriver 的 args 注入）：
//   --mode <default|permission|hang|hang-after-permission|fail-prompt|fail-load|bad-version>
//   --pid-file <path>   写自己的 pid（验证进程清理）
//   --record <path>     把观测到的客户端→agent 消息追加成 JSONL（验证 session/load 走位、
//                       cwd 透传、permission 应答、session/cancel 等）
//   --result-text <text> 输出指定最终文本（结构化协调协议测试）
//   --no-tools          不报告工具事件（独立协调测试）
import { writeFileSync, appendFileSync } from "node:fs";

const argv = process.argv.slice(2);
const flagValue = (name) => {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
};

const mode = flagValue("--mode") ?? "default";
const pidFile = flagValue("--pid-file");
const recordFile = flagValue("--record");
const resultText = flagValue("--result-text");

if (pidFile !== undefined) writeFileSync(pidFile, String(process.pid));
const record = (entry) => {
  if (recordFile !== undefined) appendFileSync(recordFile, `${JSON.stringify(entry)}\n`);
};

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const respond = (id, result) => send({ jsonrpc: "2.0", id, result });
const respondError = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });
const notify = (method, params) => send({ jsonrpc: "2.0", method, params });

const sessionId = "acp-session-1";
let updateSessionId = sessionId;
const configOptions = [
  { id: "llm", name: "LLM", category: "model", type: "select", currentValue: "small", options: [{ group: "models", name: "Models", options: [{ value: "small", name: "Small" }, { value: "large", name: "Large" }] }] },
  { id: "thinking", name: "Effort", category: "thought_level", type: "select", currentValue: "low", options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }] },
  { id: "extended", name: "Extension", type: "boolean", currentValue: false },
];
const availableModes = [{ id: "plan", name: "Plan" }, { id: "code", name: "Code" }];
if (mode === "mode-dependent-model") configOptions.find(value => value.id === "llm").options = [{ value: "small", name: "Small" }];
let currentModeId = "plan";
if (argv.includes("--config-mode")) configOptions.unshift({ id: "workflow", name: "Mode", type: "select", currentValue: "plan", options: [{ value: "plan", name: "Plan" }, { value: "code", name: "Code" }] });
if (argv.includes("--extra-config")) configOptions.push({ id: "extra", name: "Extra", type: "boolean", currentValue: false });
if (argv.includes("--large-capabilities")) {
  configOptions[0].options = [{ group: "models", name: "Models", options: Array.from({ length: 140 }, (_, index) => ({ value: `model-${index}`, name: `Model ${index}` })) }];
  configOptions[0].currentValue = "model-0";
  availableModes.push(...Array.from({ length: 140 }, (_, index) => ({ id: `mode-${index}`, name: `Mode ${index}` })));
  configOptions.push(...Array.from({ length: 140 }, (_, index) => ({ id: `option-${index}`, name: `Option ${index}`, type: "boolean", currentValue: false })));
}
const sessionState = () => argv.includes("--config") ? { ...(argv.includes("--config-only") ? {} : { modes: { currentModeId, availableModes } }), configOptions } : {};
let permissionRequestId = 0;
// 挂起的 prompt 请求 id：permission 应答后决定是否作答（模拟挂死）
let pendingPromptId = undefined;
let promptText = "";

const update = (value) => notify("session/update", { sessionId: updateSessionId, update: value });
const textChunk = (text) => update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });

function handlePrompt(params) {
  record({ event: "prompt", sessionId: params.sessionId, text: params.prompt?.[0]?.text ?? null });
  promptText = params.prompt?.[0]?.text ?? "";
  if (mode === "pending-permission-drift") {
    send({ jsonrpc: "2.0", id: "perm-1", method: "session/request_permission", params: { sessionId: params.sessionId,
      toolCall: { toolCallId: "pending-edit", title: "edit", kind: "edit" }, options: [{ optionId: "allow-once", name: "Allow", kind: "allow_once" }] } });
    const changed = structuredClone(configOptions); changed.find(value => value.id === "llm").currentValue = "small";
    update({ sessionUpdate: "config_option_update", configOptions: changed });
    return;
  }
  if (["drift-model", "drift-effort", "drift-config-mode", "drift-restored", "drift-permission", "same-update", "foreign-update", "remove-option", "change-type", "invalid-default", "unselected-update"].includes(mode)) {
    const options = structuredClone(configOptions);
    const option = options.find(value => value.id === (mode === "drift-effort" ? "thinking" : mode === "drift-config-mode" ? "workflow" : mode === "unselected-update" ? "extended" : "llm"));
    if (mode !== "same-update") option.currentValue = mode === "invalid-default" ? "invalid" : mode === "unselected-update" ? true : mode === "drift-effort" ? "low" : mode === "drift-config-mode" ? "plan" : "small";
    if (mode === "remove-option") options.splice(options.findIndex(value => value.id === "llm"), 1);
    if (mode === "change-type") Object.assign(option, { type: "boolean", currentValue: false });
    notify("session/update", { sessionId: mode === "foreign-update" ? "foreign-session" : params.sessionId,
      update: { sessionUpdate: "config_option_update", configOptions: options } });
    if (mode === "drift-restored") update({ sessionUpdate: "config_option_update", configOptions });
    if (mode === "drift-permission") send({ jsonrpc: "2.0", id: "perm-1", method: "session/request_permission", params: {
      sessionId: params.sessionId, toolCall: { toolCallId: "call-drift", title: "edit", kind: "edit" }, options: [{ optionId: "allow-once", name: "Allow", kind: "allow_once" }] } });
  }
  if (mode === "drift-mode") notify("session/update", { sessionId: params.sessionId, update: { sessionUpdate: "current_mode_update", currentModeId: "plan" } });

  if (resultText === undefined) textChunk("hello ");
  if (!argv.includes("--no-tools")) update({
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
  textChunk(resultText ?? "done");
  if (pendingPromptId === undefined) return;
  const id = pendingPromptId;
  pendingPromptId = undefined;
  respond(id, { stopReason: "end_turn" });
}

function handleMessage(message) {
  const { id, method, params } = message;

  if (method === "initialize") {
    record({ event: "initialize", clientCapabilities: params.clientCapabilities });
    if (mode === "hang-init") return;
    respond(id, {
      protocolVersion: mode === "bad-version" ? 2 : 1,
      agentCapabilities: { loadSession: !argv.includes("--no-resume") },
      agentInfo: { name: "fake-acp-agent", version: "0.0.1" },
    });
    return;
  }

  if (method === "session/new") {
    record({ event: "session/new", cwd: params.cwd, mcpServers: params.mcpServers ?? null });
    if (argv.includes("--permission-on-new")) send({ jsonrpc: "2.0", id: "perm-1", method: "session/request_permission", params: {
      sessionId, toolCall: { toolCallId: "probe-tool", title: "write file", kind: "edit" },
      options: [{ optionId: "allow-once", name: "Allow", kind: "allow_once" }] } });
    if (argv.includes("--tool-on-new")) update({ sessionUpdate: "tool_call", toolCallId: "probe-tool", title: "read file", kind: "read", status: "pending" });
    respond(id, { sessionId, ...sessionState() });
    return;
  }

  if (method === "session/load") {
    updateSessionId = params.sessionId;
    record({ event: "session/load", sessionId: params.sessionId, cwd: params.cwd });
    if (mode === "fail-load") {
      respondError(id, -32601, "session/load not supported");
      return;
    }
    respond(id, sessionState());
    return;
  }

  if (method === "session/set_mode") {
    record({ event: method, ...params });
    currentModeId = mode === "wrong-mode" ? "plan" : params.modeId;
    if (["wrong-mode", "mode-reconfig", "mode-reconfig-default"].includes(mode)) update({ sessionUpdate: "current_mode_update", currentModeId });
    if (["mode-reconfig", "mode-reconfig-default"].includes(mode)) {
      const llm = configOptions.find(value => value.id === "llm");
      if (mode === "mode-reconfig") llm.options = [{ value: "small", name: "Small" }]; llm.currentValue = "small";
      update({ sessionUpdate: "config_option_update", configOptions });
    }
    respond(id, {}); return;
  }
  if (method === "session/set_config_option") {
    record({ event: method, ...params });
    if (mode === "reject-config") { respondError(id, -32000, "configuration rejected"); return; }
    const option = configOptions.find(value => value.id === params.configId);
    if (option && mode !== "ignore-config") option.currentValue = params.value;
    if (mode === "reset-config" && params.configId === "thinking") configOptions.find(value => value.id === "llm").currentValue = "small";
    if (mode === "duplicate-option") configOptions.push(structuredClone(option));
    if (mode === "duplicate-value") configOptions.find(value => value.id === "thinking").options.push({ value: "high", name: "Duplicated" });
    if (mode === "mode-dependent-model" && params.configId === "workflow") configOptions.find(value => value.id === "llm").options.push({ value: "large", name: "Large" });
    respond(id, { configOptions });
    if (mode === "post-set-drift" && params.configId === "thinking") {
      const changed = structuredClone(configOptions); changed.find(value => value.id === "llm").currentValue = "small";
      update({ sessionUpdate: "config_option_update", configOptions: changed });
    }
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
