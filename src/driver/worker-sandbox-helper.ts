/** ADR-0100：监督agent stdio；控制IPC不传给不可信agent。 */
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { delimiter, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { WorkerSandboxLaunchSchema, WORKER_SANDBOX_POLICY } from "./worker-sandbox.js";

// 受限child不做DNS；runtime生成的localhost代理在沙箱内改为IPv4字面地址。
function run_agent(): void {
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "FTP_PROXY", "ftp_proxy"]) {
    const value = process.env[name]; if (value === undefined) continue;
    const url = new URL(value); if (url.hostname === "localhost") { url.hostname = "127.0.0.1"; process.env[name] = url.href; }
  }
  if (process.env["CLOUDSDK_PROXY_ADDRESS"] === "localhost") process.env["CLOUDSDK_PROXY_ADDRESS"] = "127.0.0.1";
  const [bin, ...args] = process.argv.slice(1);
  const result = require("node:child_process").spawnSync(bin, args, { env: process.env, stdio: "inherit", shell: false });
  process.exit(result.signal === null && result.error === undefined ? result.status ?? 1 : 1);
}

process.stdin.pause();
process.once("message", async raw => {
  let reset: (() => Promise<void>) | undefined;
  try {
    if (process.send === undefined) throw new Error("missing IPC");
    const input = WorkerSandboxLaunchSchema.parse(raw);
    const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
    if (!["darwin", "linux"].includes(process.platform) || major < 22 || major === 22 && minor < 12) throw new Error("unsupported");
    const candidates = input.bin.includes("/") ? [resolve(input.cwd, input.bin)] : (process.env["PATH"] ?? "").split(delimiter).map(path => resolve(input.cwd, path, input.bin));
    let executable: string | undefined;
    for (const path of candidates) { try { await access(path, constants.X_OK); if ((await stat(path)).isFile()) { executable = path; break; } } catch {} }
    if (executable === undefined) throw new Error("missing agent");
    const package_path = createRequire(import.meta.url).resolve("@anthropic-ai/sandbox-runtime/package.json");
    if (JSON.parse(await readFile(package_path, "utf8")).version !== "0.0.79") throw new Error("unsupported runtime");
    const { SandboxManager } = await import(pathToFileURL(join(dirname(package_path), "dist/index.js")).href);
    const { quote } = await import(pathToFileURL(join(dirname(package_path), "dist/utils/shell-quote.js")).href);
    reset = () => SandboxManager.reset();
    const dependencies = await SandboxManager.checkDependenciesAsync();
    if (dependencies.errors.length !== 0 || dependencies.warnings.length !== 0 || !SandboxManager.isSupportedPlatform()) throw new Error("dependencies");
    const literal = (path: string) => ({ path, literal: true });
    const system = process.platform === "darwin" ? ["/System", "/Library", "/usr", "/bin", "/sbin", "/dev", "/etc", "/opt"] : ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/dev", "/etc", "/proc", "/sys", "/opt"];
    await SandboxManager.initialize({ network: { allowedDomains: input.sandbox.allowed_domains, deniedDomains: [], strictAllowlist: true,
      allowLocalBinding: false, allowUnixSockets: [], allowAllUnixSockets: false, allowMachLookup: [] },
      filesystem: { denyRead: [literal("/"), literal(join(input.cwd, "cord")), ...input.git_paths.map(literal)],
        allowRead: [input.cwd, input.scratch, input.home, ...input.read_paths, ...system].map(literal),
        allowWrite: [input.scratch, input.home, ...(input.readonly ? [] : [input.cwd])].map(literal),
        denyWrite: [join(input.cwd, "cord"), ...input.git_paths, "/tmp/claude", "/private/tmp/claude", ...(input.input_documents_dir === undefined ? [] : [input.input_documents_dir])].map(literal) },
      enableWeakerNestedSandbox: false, enableWeakerNetworkIsolation: false, allowAppleEvents: false, allowPty: false }, undefined, false);
    if (!SandboxManager.isSandboxingEnabled()) throw new Error("disabled");
    const wrapped = await SandboxManager.wrapWithSandboxArgv("exec " + quote(["/usr/bin/env", `HOME=${input.home}`, `TMPDIR=${input.scratch}`, `TMP=${input.scratch}`, `TEMP=${input.scratch}`,
      process.execPath, "-e", `(${run_agent.toString()})()`, executable, ...input.args]), "/bin/bash", undefined, undefined, input.cwd);
    const child = spawn(wrapped.argv[0], wrapped.argv.slice(1), { cwd: input.cwd, env: { ...wrapped.env, ...input.environment,
      ...(input.input_documents_dir === undefined ? {} : { CORD_INPUT_DIR: input.input_documents_dir }) }, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
    child.stdin.on("error", () => { process.stdin.unpipe(child.stdin); });
    process.once("disconnect", () => child.kill("SIGKILL"));
    const started = new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    const finished = new Promise<{ exit_code: number | null; signal: string | null }>(resolve => child.once("close", (exit_code, signal) => resolve({ exit_code, signal })));
    await started;
    await new Promise<void>((resolve, reject) => process.send!({ kind: "sandbox_started", policy: WORKER_SANDBOX_POLICY }, error => error ? reject(error) : resolve()));
    process.stdin.pipe(child.stdin);
    const result = await finished;
    await reset(); reset = undefined;
    await new Promise<void>((resolve, reject) => process.send!({ kind: "sandbox_finished", ...result }, error => error ? reject(error) : resolve()));
    process.exitCode = result.signal === null ? result.exit_code ?? 1 : 1;
    if (process.connected) process.disconnect();
  } catch {
    try { await reset?.(); } catch {}
    process.send?.({ kind: "sandbox_failed" }); if (process.connected) process.disconnect(); process.exitCode = 1;
  }
});
