/** ACP MCP配置是结构化连接声明；凭据值仅在实际session派发时解析。 */
import { isAbsolute } from "node:path";
import type { McpServer } from "@agentclientprotocol/sdk";
import { z } from "zod";
import { AcpLaunchConfigurationError } from "./acp-launch.js";

const name = z.string().min(1).max(200).refine(value => !/[\x00-\x1f\x7f]/.test(value), "MCP标识不能含控制字符");
const env_name = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/, "MCP环境引用必须是环境变量名");
const header_name = z.string().regex(/^[!#$%&'*+.^_`|~A-Za-z0-9-]{1,128}$/, "MCP header名称无效");
const sorted_mapping = (value: Record<string, string>) => Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
const env_from = z.record(env_name, env_name).refine(value => Object.keys(value).length <= 32, "MCP环境引用最多32项").default({}).transform(sorted_mapping);
const headers_from = z.record(header_name, env_name).refine(value => Object.keys(value).length <= 32, "MCP header引用最多32项")
  .refine(value => new Set(Object.keys(value).map(key => key.toLowerCase())).size === Object.keys(value).length, "MCP header名称不能重复")
  .default({}).transform(sorted_mapping);
const endpoint = z.string().max(4000).refine(value => {
  try { const url = new URL(value); return /^https?:\/\//i.test(value) && !/[\x00-\x20\x7f]/.test(value) && ["http:", "https:"].includes(url.protocol) && url.username === "" && url.password === "" && url.hash === ""; }
  catch { return false; }
}, "MCP地址必须是无userinfo/fragment的http(s) URL");
const server_schema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("stdio"), name, command: z.string().min(1).max(4000).refine(value => isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value), "MCP command必须是绝对路径"),
    args: z.array(z.string().max(8192).refine(value => !value.includes("\0"), "MCP argv不能含NUL")).max(128).default([]), env_from }),
  z.strictObject({ type: z.literal("http"), name, url: endpoint, headers_from }),
  z.strictObject({ type: z.literal("sse"), name, url: endpoint, headers_from }),
]);
export const AcpMcpServersSchema = z.array(server_schema).max(16)
  .refine(servers => new Set(servers.map(server => server.name)).size === servers.length, "MCP名称必须唯一")
  .refine(servers => JSON.stringify(servers).length <= 65536, "MCP配置超过64Ki字符上限");
export type AcpMcpServersInput = z.input<typeof AcpMcpServersSchema>;
export type AcpMcpServers = z.output<typeof AcpMcpServersSchema>;
export interface AcpMcpTransportObservation {
  stdio: "required";
  http: boolean;
  sse: boolean;
  connections: "not_requested";
}

export function mcp_transport_observation(capabilities: { http?: boolean; sse?: boolean } | undefined): AcpMcpTransportObservation {
  return { stdio: "required", http: capabilities?.http === true, sse: capabilities?.sse === true, connections: "not_requested" };
}
export function assert_acp_mcp_transports(servers: AcpMcpServers, capabilities: { http?: boolean; sse?: boolean } | undefined): void {
  for (const server of servers) if (server.type !== "stdio" && capabilities?.[server.type] !== true) throw new AcpLaunchConfigurationError("ACP未协商支持声明的MCP传输");
}
export function compile_acp_mcp_servers(servers: AcpMcpServers, environment: Record<string, string | undefined>): McpServer[] {
  const variables = (references: Record<string, string>, header: boolean) => Object.entries(references).map(([name, reference]) => {
    const value = environment[reference];
    if (value === undefined || value.includes("\0") || (header && (value.length === 0 || /[\r\n]/.test(value)))) throw new AcpLaunchConfigurationError("MCP凭据环境引用缺失或无法验证");
    return { name, value };
  });
  return servers.map(server => server.type === "stdio" ? { name: server.name, command: server.command, args: [...server.args], env: variables(server.env_from, false) }
    : { type: server.type, name: server.name, url: server.url, headers: variables(server.headers_from, true) });
}
