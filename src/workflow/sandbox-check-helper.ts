/** ADR-0097：单次检查的可信监督进程；测试进程不继承IPC控制通道。 */
import { spawn } from "node:child_process";
import { access, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { GoalCommandSchema } from "../core/schema.js";

const input_schema = z.strictObject({ command: GoalCommandSchema, cwd: z.string().min(1), scratch: z.string().min(1), git_paths: z.array(z.string()) });
let received = false;
process.once("message", async raw => {
  if (received || process.send === undefined) { process.exitCode = 1; return; }
  received = true;
  let reset: (() => Promise<void>) | undefined;
  try {
    const input = input_schema.parse(raw);
    if (!["darwin", "linux"].includes(process.platform)) throw new Error("unsupported");
    const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
    if (major < 22 || (major === 22 && minor < 12)) throw new Error("unsupported node version");
    const candidates = input.command.bin.includes("/") ? [resolve(input.cwd, input.command.bin)]
      : (process.env["PATH"] ?? "").split(delimiter).map(path => resolve(input.cwd, path, input.command.bin));
    let executable: string | undefined;
    for (const path of candidates) {
      try { await access(path, constants.X_OK); if ((await stat(path)).isFile()) { executable = path; break; } }
      catch { /* 按原PATH顺序查找，不把不存在的命令转为验证失败重试。 */ }
    }
    if (executable === undefined) throw new Error("missing command");
    const require_ = createRequire(import.meta.url);
    const package_path = require_.resolve("@anthropic-ai/sandbox-runtime/package.json");
    const metadata = JSON.parse(await readFile(package_path, "utf8"));
    if (metadata.version !== "0.0.79") throw new Error("unsupported runtime");
    const { SandboxManager } = await import(pathToFileURL(join(dirname(package_path), "dist/index.js")).href);
    const { quote } = await import(pathToFileURL(join(dirname(package_path), "dist/utils/shell-quote.js")).href);
    reset = () => SandboxManager.reset();
    const dependencies = await SandboxManager.checkDependenciesAsync();
    if (dependencies.errors.length !== 0 || dependencies.warnings.length !== 0 || !SandboxManager.isSupportedPlatform()) throw new Error("dependencies");
    const literal = (path: string) => ({ path, literal: true });
    const system = process.platform === "darwin" ? ["/System", "/Library", "/usr", "/bin", "/sbin", "/dev", "/etc", "/opt"]
      : ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/dev", "/etc", "/proc", "/sys", "/opt"];
    await SandboxManager.initialize({
      network: { allowedDomains: [], deniedDomains: ["*"], strictAllowlist: true, allowLocalBinding: false, allowUnixSockets: [], allowAllUnixSockets: false, allowMachLookup: [] },
      filesystem: { denyRead: [literal("/"), literal(join(input.cwd, "cord")), ...input.git_paths.map(literal)],
        allowRead: [input.cwd, input.scratch, ...system].map(literal), allowWrite: [literal(input.scratch)],
        denyWrite: ["/tmp/claude", "/private/tmp/claude"].map(literal) },
      enableWeakerNestedSandbox: false, enableWeakerNetworkIsolation: false, allowAppleEvents: false, allowPty: false,
    }, undefined, false);
    if (!SandboxManager.isSandboxingEnabled()) throw new Error("disabled");
    // runtime默认设置共享/tmp/claude；真正的检查覆盖为本次私有scratch。
    const wrapped = await SandboxManager.wrapWithSandboxArgv("exec " + quote(["/usr/bin/env", `HOME=${input.scratch}`, `TMPDIR=${input.scratch}`, `TMP=${input.scratch}`, `TEMP=${input.scratch}`,
      executable, ...input.command.args]), "/bin/bash", undefined, undefined, input.cwd);
    const child = spawn(wrapped.argv[0], wrapped.argv.slice(1), { cwd: input.cwd, env: wrapped.env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
    let spawn_error = false;
    child.once("error", () => { spawn_error = true; });
    process.send({ kind: "started" });
    const terminate = () => { child.kill("SIGKILL"); };
    process.once("disconnect", terminate);
    const result = await new Promise<{ exit_code: number | null; signal: string | null }>(resolve => child.once("close", (exit_code, signal) => resolve({ exit_code, signal })));
    process.removeListener("disconnect", terminate);
    await reset(); reset = undefined;
    await new Promise<void>((resolve, reject) => process.send!({ kind: "completed", ...result, spawn_error }, error => error ? reject(error) : resolve()));
    process.disconnect();
  } catch {
    try { await reset?.(); } catch { /* 初始化故障保持失败，不覆盖为有效检查。 */ }
    process.send?.({ kind: "setup_failed" });
    if (process.connected) process.disconnect();
    process.exitCode = 1;
  }
});
