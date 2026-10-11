/**
 * 跨 driver 的只读工具审计（ADR-0068）。
 *
 * 这不是 OS 沙箱，也不能撤销已经发生的副作用；它只消费 driver 已归一化的
 * tool_use 事实，遇到无法判断的工具或命令时 fail-closed。
 */
import { parseArgs, type ParseArgsConfig } from "node:util";

export const WORKER_READONLY_TOOL_POLICY = "worker-command-options.v2";

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

function commandArgv(value: unknown): string[] | null {
  const tokenize = (command: string): string[] | null => {
    const trimmed = command.trim();
    return trimmed.length > 0 && trimmed.length <= 512 && /^[A-Za-z0-9_./:@%+=,\- ]+$/.test(trimmed) ? trimmed.split(/ +/u) : null;
  };
  if (typeof value === "string") return tokenize(value);
  const input = record(value);
  if (input === null) return null;
  const fields = ["command", "cmd", "shell_command", "argv"].filter(key => Object.hasOwn(input, key));
  if (fields.length !== 1) return null;
  const field = fields[0]!;
  if (field !== "argv") return typeof input[field] === "string" ? tokenize(input[field]) : null;
  if (Array.isArray(input.argv) && input.argv.length > 0 && input.argv.length <= 64
    && input.argv.every(item => typeof item === "string" && !/[\x00-\x1f\x7f]/.test(item))
    && input.argv.reduce((length: number, item: string) => length + item.length, 0) <= 512) return [...input.argv] as string[];
  return null;
}

type Options = NonNullable<ParseArgsConfig["options"]>;
function readOptions(boolean: readonly string[], string: readonly string[] = [], short: Record<string, string> = {}): Options {
  return Object.fromEntries([...boolean.map(name => [name, { type: "boolean", ...(short[name] === undefined ? {} : { short: short[name] }) }]),
    ...string.map(name => [name, { type: "string", ...(short[name] === undefined ? {} : { short: short[name] }) }])]) as Options;
}

const DIFF_FLAGS = ["stat", "numstat", "shortstat", "name-only", "name-status", "summary", "check", "no-ext-diff", "no-textconv", "patch", "no-patch", "raw", "binary", "ignore-all-space", "ignore-space-change", "ignore-space-at-eol", "ignore-blank-lines", "exit-code", "quiet", "no-index"];
const LOG_FLAGS = ["oneline", "graph", "all", "no-merges", "merges", "reverse", "date-order", "decorate", ...DIFF_FLAGS];
const GIT_OPTIONS: Record<string, Options> = {
  diff: readOptions(DIFF_FLAGS, ["unified", "color"], { patch: "p", "no-patch": "s", "ignore-all-space": "w", "ignore-space-change": "b", unified: "U" }),
  log: readOptions(LOG_FLAGS, ["max-count", "skip", "format", "pretty", "grep", "author", "since", "until", "date", "color"], { "max-count": "n", patch: "p" }),
  show: readOptions(LOG_FLAGS, ["format", "pretty", "unified", "color"], { patch: "p", "no-patch": "s", unified: "U" }),
  status: readOptions(["short", "branch", "porcelain", "ignored", "no-renames"], ["untracked-files", "ignore-submodules"], { short: "s", branch: "b", "untracked-files": "u" }),
  "rev-parse": readOptions(["show-toplevel", "show-prefix", "show-cdup", "show-object-format", "is-inside-work-tree", "is-bare-repository", "verify", "quiet", "short", "symbolic", "symbolic-full-name", "abbrev-ref", "end-of-options"]),
  "cat-file": readOptions(["p", "t", "s"], [], { p: "p", t: "t", s: "s" }),
  "ls-files": readOptions(["cached", "deleted", "modified", "others", "ignored", "stage", "unmerged", "killed", "exclude-standard", "full-name", "error-unmatch", "z"], ["exclude", "exclude-from"], { cached: "c", deleted: "d", modified: "m", others: "o", ignored: "i", stage: "s", unmerged: "u", killed: "k", exclude: "x", "exclude-from": "X", z: "z" }),
};
const FILE_OPTIONS: Record<string, Options> = {
  rg: readOptions(["hidden", "files", "no-ignore", "no-ignore-vcs", "json", "count", "line-number", "ignore-case", "smart-case", "fixed-strings", "word-regexp", "invert-match", "files-with-matches", "files-without-match", "only-matching", "quiet", "no-heading", "with-filename", "no-filename", "no-line-number", "no-messages", "text"],
    ["glob", "iglob", "type", "type-not", "regexp", "file", "max-count", "max-depth", "context", "before-context", "after-context", "encoding", "color", "sort", "sortr", "threads", "ignore-file"],
    { count: "c", "line-number": "n", "ignore-case": "i", "smart-case": "S", "fixed-strings": "F", "word-regexp": "w", "invert-match": "v", "files-with-matches": "l", "files-without-match": "L", "only-matching": "o", quiet: "q", "with-filename": "H", text: "a", glob: "g", type: "t", "type-not": "T", regexp: "e", file: "f", "max-count": "m", context: "C", "before-context": "B", "after-context": "A", threads: "j" }),
  grep: readOptions(["extended-regexp", "basic-regexp", "fixed-strings", "perl-regexp", "ignore-case", "invert-match", "line-number", "with-filename", "no-filename", "files-with-matches", "files-without-match", "count", "quiet", "no-messages", "word-regexp", "line-regexp", "recursive", "dereference-recursive"],
    ["regexp", "file", "max-count", "after-context", "before-context", "context", "include", "exclude", "exclude-dir", "color"],
    { "extended-regexp": "E", "basic-regexp": "G", "fixed-strings": "F", "perl-regexp": "P", "ignore-case": "i", "invert-match": "v", "line-number": "n", "with-filename": "H", "no-filename": "h", "files-with-matches": "l", "files-without-match": "L", count: "c", quiet: "q", "no-messages": "s", "word-regexp": "w", "line-regexp": "x", recursive: "r", "dereference-recursive": "R", regexp: "e", file: "f", "max-count": "m", "after-context": "A", "before-context": "B", context: "C" }),
  ls: readOptions(["all", "almost-all", "directory", "human-readable", "recursive", "reverse", "l", "t", "S", "1"], ["color"], { all: "a", "almost-all": "A", directory: "d", "human-readable": "h", recursive: "R", reverse: "r", l: "l", t: "t", S: "S", "1": "1" }),
  cat: readOptions(["number", "number-nonblank", "show-ends", "show-tabs", "show-all", "squeeze-blank", "show-nonprinting", "u"], [], { number: "n", "number-nonblank": "b", "show-ends": "E", "show-tabs": "T", "show-all": "A", "squeeze-blank": "s", "show-nonprinting": "v", u: "u" }),
  head: readOptions(["quiet", "verbose"], ["lines", "bytes"], { quiet: "q", verbose: "v", lines: "n", bytes: "c" }),
  tail: readOptions(["quiet", "verbose"], ["lines", "bytes"], { quiet: "q", verbose: "v", lines: "n", bytes: "c" }),
  wc: readOptions(["lines", "words", "chars", "bytes", "max-line-length"], [], { lines: "l", words: "w", chars: "m", bytes: "c", "max-line-length": "L" }),
  stat: readOptions(["dereference", "terse", "filesystem"], ["format", "printf", "f"], { dereference: "L", terse: "t", format: "c", f: "f" }),
  file: readOptions(["brief", "mime", "mime-type", "mime-encoding", "dereference", "no-dereference"], ["magic-file", "files-from"], { brief: "b", mime: "i", dereference: "L", "no-dereference": "h", "magic-file": "m", "files-from": "f" }),
  pwd: readOptions(["physical", "logical"], [], { physical: "P", logical: "L" }),
  true: readOptions([]),
};

function readFind(args: string[]): boolean {
  const values = new Set(["-name", "-iname", "-path", "-ipath", "-type", "-maxdepth", "-mindepth", "-mtime", "-mmin", "-size", "-perm", "-user", "-group", "-uid", "-gid"]);
  const flags = new Set(["-H", "-L", "-P", "-print", "-print0", "-ls", "-empty", "-readable", "-writable", "-executable", "-xdev", "-mount", "-depth", "-prune", "-true", "-false", "-and", "-or", "-not", "-a", "-o", "!", "(", ")"]);
  let expression = false;
  for (let index = 0; index < args.length; index++) {
    const value = args[index]!;
    if (!expression && ["-H", "-L", "-P"].includes(value)) continue;
    if (values.has(value)) { expression = true; if (++index >= args.length) return false; }
    else if (flags.has(value)) expression = true;
    else if (expression || value.startsWith("-")) return false;
  }
  return true;
}

function safeCommand(argv: string[]): boolean {
  const bin = argv[0]; if (bin === undefined) return false;
  const executable = bin.startsWith("/usr/bin/") ? bin.slice(9) : bin.startsWith("/bin/") ? bin.slice(5) : bin;
  if (executable.includes("/")) return false;
  const args = argv.slice(1);
  if (executable === "find") return readFind(args);
  let options = Object.hasOwn(FILE_OPTIONS, executable) ? FILE_OPTIONS[executable] : undefined;
  if (executable === "git") {
    while (["--no-pager", "--no-optional-locks"].includes(args[0] ?? "")) args.shift();
    const subcommand = args.shift(); if (subcommand === undefined) return false;
    options = Object.hasOwn(GIT_OPTIONS, subcommand) ? GIT_OPTIONS[subcommand] : undefined;
  }
  if (options === undefined) return false;
  try { parseArgs({ args, options, strict: true, allowPositionals: true }); return true; }
  catch { return false; }
}

/** 返回 null 表示该 tool_use 可以在只读任务中继续；否则返回稳定的拒绝原因。 */
export function readonlyToolViolation(name: string | null, input: unknown): string | null {
  const normalized = name?.trim().toLowerCase() ?? "";
  if (normalized.length === 0) return "只读 worker 的工具名称缺失";
  if (READ_TOOL_NAMES.has(normalized)) return null;
  if (WRITE_TOOL_NAMES.has(normalized)) return `只读 worker 请求了写工具：${normalized}`;
  if (COMMAND_TOOL_NAMES.has(normalized) || normalized.startsWith("bash(")) {
    const command = commandArgv(input);
    return command !== null && safeCommand(command) ? null : `只读 worker 的命令工具不可核验：${normalized.startsWith("bash(") ? "bash" : normalized}`;
  }
  return `只读 worker 请求了未知工具：${normalized}`;
}
