/** ACP 旧 ClientContext 将扩展响应标为 unknown，结构化解析后才能依赖回执。 */
import { z } from "zod";
const choice = z.object({ value: z.string(), name: z.string() });
const option = z.intersection(z.object({ id: z.string(), name: z.string(), category: z.string().nullable().optional() }), z.discriminatedUnion("type", [
  z.object({ type: z.literal("select"), currentValue: z.string(), options: z.union([z.array(choice), z.array(z.object({ group: z.string(), name: z.string(), options: z.array(choice) }))]) }),
  z.object({ type: z.literal("boolean"), currentValue: z.boolean() }),
]));
export const AcpConfigResponseSchema = z.object({ configOptions: z.array(option) });

export interface AcpCapabilityObservation {
  evidence: "acp_handshake";
  protocol_version: number;
  native_resume: boolean;
  modes: string[];
  omitted_modes: number;
  config_options: Array<{ id: string; type: "select" | "boolean"; category: string | null; values?: string[]; omitted_values?: number }>;
  omitted_options: number;
}
