/** ADR-0073：启动选项与能力表，不把通信协议、权限和宿主 Goal 混为同一模式。 */
import { z } from "zod";

const identifier = z.string().min(1).max(200).refine(value => !/[\x00-\x1f]/.test(value), "启动标识不能含控制字符");
export const AgentLaunchSchema = z.strictObject({
  model: identifier.optional(),
  effort: identifier.optional(),
  max_turns: z.number().int().positive().optional(),
  budget_usd: z.number().positive().optional(),
  system_prompt: z.string().min(1).max(100_000).optional(),
  agent: identifier.optional(),
  agents_json: z.string().min(1).max(100_000).optional(),
  bare: z.boolean().optional(),
  auto: z.boolean().optional(),
  mode: identifier.optional(),
  option_ids: z.strictObject({ model: identifier.optional(), effort: identifier.optional(), mode: identifier.optional() }).optional(),
  config_options: z.record(identifier, z.union([identifier, z.boolean()])).optional(),
});
export type AgentLaunch = z.infer<typeof AgentLaunchSchema>;

export type { AgentCapabilities } from "../core/ports.js";

export function validate_agent_launch(value: unknown, supported: readonly string[]): AgentLaunch {
  const launch = AgentLaunchSchema.parse(value ?? {});
  const unsupported = Object.keys(launch).filter(key => !supported.includes(key));
  if (unsupported.length > 0) throw new Error(`agent 不支持启动选项：${unsupported.join("、")}`);
  return launch;
}
