/** ACP 旧 ClientContext 将扩展响应标为 unknown，结构化解析后才能依赖回执。 */
import { z } from "zod";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type { AgentLaunch } from "./launch.js";

export const ACP_LAUNCH_STATE_POLICY = "explicit-session-selections.v1";
export class AcpLaunchConfigurationError extends Error {}
const choice = z.object({ value: z.string(), name: z.string() });
const option = z.intersection(z.object({ id: z.string(), name: z.string(), category: z.string().nullable().optional() }), z.discriminatedUnion("type", [
  z.object({ type: z.literal("select"), currentValue: z.string(), options: z.union([z.array(choice), z.array(z.object({ group: z.string(), name: z.string(), options: z.array(choice) }))]) }),
  z.object({ type: z.literal("boolean"), currentValue: z.boolean() }),
]));
export const AcpConfigResponseSchema = z.object({ configOptions: z.array(option) });
const modes_schema = z.object({ currentModeId: z.string(), availableModes: z.array(z.object({ id: z.string() })) });

export class AcpLaunchState {
  private options: SessionConfigOption[] = [];
  private current_mode: string | null = null;
  private available_modes = new Set<string>();
  private mode_updates = 0;
  private sealed = false;
  private readonly selections = new Map<string, string | boolean>();
  readonly legacy_mode: string | undefined;

  constructor(launch: AgentLaunch, private readonly readonly_task: boolean) {
    if (readonly_task && (Object.keys(launch.config_options ?? {}).length > 0 || (launch.mode !== undefined && launch.mode !== "plan"))) {
      throw new AcpLaunchConfigurationError("只读 ACP 任务拒绝扩展配置或非 plan mode");
    }
    this.legacy_mode = launch.option_ids?.mode === undefined ? launch.mode : undefined;
    if (launch.mode !== undefined && launch.option_ids?.mode !== undefined) this.selections.set(launch.option_ids.mode, launch.mode);
    for (const [id, value] of Object.entries(launch.config_options ?? {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) this.selections.set(id, value);
    for (const key of ["provider", "model", "effort"] as const) {
      const value = launch[key];
      if (value !== undefined) this.selections.set(launch.option_ids![key]!, value);
    }
  }

  initialize(state: { modes?: unknown; configOptions?: unknown }): void {
    if (state.modes != null) {
      const checked = modes_schema.safeParse(state.modes);
      if (!checked.success) throw new AcpLaunchConfigurationError("ACP mode 状态结构不可验证");
      this.available_modes = new Set(checked.data.availableModes.map(mode => mode.id));
      if (this.available_modes.size !== checked.data.availableModes.length || !this.available_modes.has(checked.data.currentModeId)) {
        throw new AcpLaunchConfigurationError("ACP mode 状态重复或当前值不可验证");
      }
      this.current_mode = checked.data.currentModeId;
    }
    this.replace_options(state.configOptions ?? []);
  }

  configuration(): SessionConfigOption[] { return this.options; }
  entries(): Array<[string, string | boolean]> { return [...this.selections]; }
  mode_version(): number { return this.mode_updates; }
  assert_legacy_mode(): void {
    if (this.legacy_mode !== undefined && !this.available_modes.has(this.legacy_mode)) throw new AcpLaunchConfigurationError("ACP 不支持请求的 session mode");
  }
  acknowledge_legacy_mode(prior_version: number): void {
    // 旧 set_mode 的成功回执为空；没有新通知时按协议成功确认，不虚构额外观测。
    if (this.mode_updates === prior_version) this.current_mode = this.legacy_mode ?? this.current_mode;
    if (this.current_mode !== this.legacy_mode) throw new AcpLaunchConfigurationError("ACP mode 通知与启动请求不一致");
  }

  replace_options(value: unknown): void {
    const checked = AcpConfigResponseSchema.safeParse({ configOptions: value });
    if (!checked.success) throw new AcpLaunchConfigurationError("ACP 配置状态结构不可验证");
    const ids = new Set<string>();
    for (const entry of checked.data.configOptions) {
      if (ids.has(entry.id)) throw new AcpLaunchConfigurationError("ACP 配置 ID 重复");
      ids.add(entry.id);
      if (entry.type === "select") {
        const values = entry.options.flatMap(item => "group" in item ? item.options.map(choice => choice.value) : [item.value]);
        if (new Set(values).size !== values.length || !values.includes(entry.currentValue)) throw new AcpLaunchConfigurationError("ACP 配置候选重复或当前值不可验证");
      }
    }
    this.options = checked.data.configOptions;
    if (this.sealed) this.assert_ready();
  }

  update_mode(value: string): void {
    this.current_mode = value; this.mode_updates += 1;
    if (this.sealed) this.assert_ready();
  }

  assert_supported(id: string, value: string | boolean): void {
    const entry = this.options.find(option => option.id === id);
    const supported = entry?.type === "boolean" ? typeof value === "boolean" : entry?.type === "select" && typeof value === "string"
      && entry.options.some(item => "group" in item ? item.options.some(choice => choice.value === value) : item.value === value);
    if (!supported) throw new AcpLaunchConfigurationError("ACP 不支持请求的配置 ID/值");
    if (this.readonly_task && entry?.category === "mode" && value !== "plan") throw new AcpLaunchConfigurationError("只读 ACP 任务不能选择非 plan mode");
  }

  assert_selected(id: string, value: string | boolean): void {
    this.assert_supported(id, value);
    if (this.options.find(option => option.id === id)?.currentValue !== value) throw new AcpLaunchConfigurationError("ACP 配置与显式启动选择不一致");
  }
  assert_ready(): void {
    for (const [id, value] of this.selections) this.assert_selected(id, value);
    if (this.legacy_mode !== undefined && this.current_mode !== this.legacy_mode) throw new AcpLaunchConfigurationError("ACP mode 与显式启动选择不一致");
  }
  seal(): void { this.assert_ready(); this.sealed = true; }
}

export interface AcpCapabilityObservation {
  evidence: "acp_handshake";
  protocol_version: number;
  native_resume: boolean;
  modes: string[];
  omitted_modes: number;
  config_options: Array<{ id: string; type: "select" | "boolean"; category: string | null; values?: string[]; omitted_values?: number }>;
  omitted_options: number;
}
