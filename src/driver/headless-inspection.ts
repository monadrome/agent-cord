/** CLI 帮助仅证明公开入口，不推断模型/配置键/隐藏参数是否可用。 */
import { canonicalJson, sha256Hex } from "../core/hash.js";

export type HeadlessInspectionProfile = "claude" | "codex" | "kimi";
export type CliProbeStatus = "passed" | "unavailable" | "timeout" | "failed" | "unrecognized";
export interface HeadlessCapabilityObservation {
  evidence: "cli_help";
  profile: HeadlessInspectionProfile;
  status: CliProbeStatus;
  version: string | null;
  help_hash: string | null;
  checks: Array<{ id: "version" | "task_help" | "resume_help"; status: CliProbeStatus }>;
  launch_options: Array<{ id: string; configured: boolean; advertised: boolean | null }>;
  native_resume: "advertised" | "unadvertised" | "unknown";
}

export function cli_version(profile: HeadlessInspectionProfile, text: string): string | null {
  const semver = "(\\d{1,6}\\.\\d{1,6}\\.\\d{1,6}(?:-[a-zA-Z0-9.-]{1,40})?)";
  const pattern = profile === "claude" ? new RegExp(`^${semver} \\(Claude Code\\)$`, "m")
    : profile === "codex" ? new RegExp(`^codex-cli ${semver}$`, "m") : new RegExp(`^${semver}$`, "m");
  return text.trim().match(pattern)?.[1] ?? null;
}

function option_blocks(text: string): Map<string, string> {
  const blocks = new Map<string, string>(); let id: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s{0,8}(?:-[A-Za-z0-9],\s*)?(--[A-Za-z][A-Za-z0-9-]*)(?=[\s,=]|$)/);
    if (match !== null) { id = match[1]!; blocks.set(id, line); }
    else if (id !== undefined) blocks.set(id, `${blocks.get(id)}\n${line}`);
  }
  return blocks;
}

export function cli_help_recognized(profile: HeadlessInspectionProfile, text: string, resume = false): boolean {
  const command = profile === "codex" ? `codex exec${resume ? " resume" : ""}` : profile;
  return new RegExp(`^Usage: ${command}(?=\\s|$)`, "m").test(text) && option_blocks(text).has("--help");
}

export function cli_help_observation(profile: HeadlessInspectionProfile, help: string, resume_help: string | null,
  options: readonly string[], configured: readonly string[]): Pick<HeadlessCapabilityObservation, "help_hash" | "launch_options" | "native_resume"> {
  const blocks = option_blocks(help);
  const flags: Record<string, string> = { model: "--model", effort: "--effort", bare: "--bare", max_turns: "--max-turns", budget_usd: "--max-budget-usd",
    system_prompt: "--append-system-prompt", agent: "--agent", agents_json: "--agents" };
  const launch_options = options.map(id => {
    let advertised: boolean | null = Object.hasOwn(flags, id) ? blocks.has(flags[id]!) : null;
    if (id === "effort" && profile === "codex") advertised = null;
    if (id === "auto") {
      const block = blocks.get("--permission-mode");
      const choices = block?.match(/\bchoices:\s*([^)]*)\)/)?.[1];
      advertised = block === undefined ? false : choices === undefined ? null : /(?:^|[,\s])["']?auto["']?(?:$|[,\s])/.test(choices);
    }
    return { id, configured: configured.includes(id), advertised };
  });
  return { help_hash: sha256Hex(canonicalJson({ domain: "cord.cli-help-observation.v1", profile, help, resume_help })), launch_options,
    native_resume: profile === "codex" ? resume_help === null ? "unknown" : cli_help_recognized(profile, resume_help, true) ? "advertised" : "unadvertised"
      : blocks.has(profile === "claude" ? "--resume" : "--session") ? "advertised" : "unadvertised" };
}
