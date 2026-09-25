/**
 * @agent-cord/server 公共出口（ADR-0021）：buildApp 供测试与嵌入；contracts 单独子路径导出。
 */
export { buildApp, type BuiltServer, type ServerOptions } from "./app.js";
export { ApiError } from "./errors.js";
export { SessionService, encodeApprovalId, decodeApprovalId } from "./services/session-service.js";
export { RunService } from "./services/run-service.js";
export { SdlcService, DEFAULT_SDLC, DEFAULT_SDLC_ID } from "./services/sdlc-service.js";
export { IndexStore } from "./services/index-store.js";
