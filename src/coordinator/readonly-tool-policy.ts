/**
 * 跨 driver 的只读工具审计（ADR-0068）。
 *
 * 这不是 OS 沙箱，也不能撤销已经发生的副作用；它只消费 driver 已归一化的
 * tool_use 事实，遇到无法判断的工具或命令时 fail-closed。
 */

const READ_TOOL_NAMES = new Set([
  "read", "read file", "read_file", "readfile", "file_read", "grep", "glob", "search", "find",
  "ls", "list files", "list_files", "list_directory", "directory_list", "cat", "head", "tail", "stat",
  "git_diff", "git_log", "git_show", "git_status", "git_ls_files",
]);

const COMMAND_TOOL_NAMES = new Set(["bash", "shell", "command", "command_execution", "execute", "terminal", "run_command"]);
const WRITE_TOOL_NAMES = new Set([
  "write", "write_file", "edit", "apply_patch", "file_change", "delete", "remove", "move", "copy", "mkdir", "touch",
]);

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function commandOf(value: unknown): string | null {
  if (typeof value === "string") return value;
  const input = record(value);
  if (input === null) return null;
  for (const key of ["command", "cmd", "shell_command"] as const) if (typeof input[key] === "string") return input[key] as string;
  if (Array.isArray(input.argv) && input.argv.every(item => typeof item === "string")) return (input.argv as string[]).join(" ");
  return null;
}

function safeCommand(command: string): boolean {
  const trimmed = command.trim();
  // 不解析 shell；引号、重定向、替换和控制符一律拒绝，避免把文本审计误当执行策略。
  if (trimmed.length === 0 || trimmed.length > 512 || !/^[A-Za-z0-9_./:@%+=,\- ]+$/.test(trimmed)) return false;
  const argv = trimmed.split(/ +/u).filter(Boolean);
  const executable = argv[0]?.split("/").at(-1);
  if (executable === undefined) return false;
  if (executable === "git") {
    const subcommand = argv[1];
    return subcommand !== undefined && new Set(["diff", "log", "show", "status", "rev-parse", "cat-file", "ls-files"]).has(subcommand)
      && !argv.some(item => ["-c", "--config-env", "--exec-path"].includes(item));
  }
  if (!["pwd", "ls", "find", "rg", "grep", "cat", "head", "tail", "wc", "stat", "file", "printf", "test", "true"].includes(executable)) return false;
  if (executable === "find" && argv.some(item => ["-exec", "-execdir", "-delete", "-ok", "-okdir"].includes(item))) return false;
  if (executable === "sed" || argv.includes("-i") || argv.includes("--in-place")) return false;
  return true;
}

/** 返回 null 表示该 tool_use 可以在只读任务中继续；否则返回稳定的拒绝原因。 */
export function readonlyToolViolation(name: string | null, input: unknown): string | null {
  const normalized = name?.trim().toLowerCase() ?? "";
  if (normalized.length === 0) return "只读 worker 的工具名称缺失";
  if (READ_TOOL_NAMES.has(normalized)) return null;
  if (WRITE_TOOL_NAMES.has(normalized)) return `只读 worker 请求了写工具：${normalized}`;
  if (COMMAND_TOOL_NAMES.has(normalized) || normalized.startsWith("bash(")) {
    const command = commandOf(input);
    return command !== null && safeCommand(command) ? null : `只读 worker 的命令工具不可核验：${normalized}`;
  }
  return `只读 worker 请求了未知工具：${normalized}`;
}
