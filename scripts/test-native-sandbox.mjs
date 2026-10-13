/** 严格原生验收入口：依赖/namespace实际探针，通过测试必须零skip。 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const suites = [
  "tests/driver/worker-sandbox.test.ts",
  "tests/workflow/sandboxed-host-check.test.ts",
  "tests/workflow/check-assets.test.ts",
  "tests/workflow/frozen-check-workspace.test.ts",
  "apps/server/tests/worker-sandbox.test.ts",
  "apps/server/tests/sandboxed-goal.test.ts",
  "apps/server/tests/input-documents.test.ts",
  "apps/server/tests/check-assets.test.ts",
];

function execute(bin, args, options = {}, timeout_ms = 30_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: root, stdio: "inherit", ...options, detached: true });
    let stopped = false; let forced;
    const kill = signal => { if (child.pid !== undefined) { try { process.kill(-child.pid, signal); } catch {} } };
    const stop = () => { if (stopped) { kill("SIGKILL"); return; } stopped = true; kill("SIGTERM"); forced = setTimeout(() => kill("SIGKILL"), 1000); };
    const timeout = setTimeout(stop, timeout_ms);
    process.on("SIGINT", stop); process.on("SIGTERM", stop);
    const cleanup = () => { clearTimeout(timeout); clearTimeout(forced); process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); };
    child.once("error", error => { cleanup(); reject(error); });
    child.once("close", (code, signal) => {
      if (stopped) kill("SIGKILL");
      cleanup();
      if (!stopped && code === 0 && signal === null) resolve();
      else reject(new Error(`原生验收命令失败：${bin}，退出=${code ?? "未知"}，信号=${signal ?? "无"}`));
    });
  });
}

let scratch;
try {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  if (!["darwin", "linux"].includes(process.platform) || major < 22 || major === 22 && minor < 12) throw new Error("需要 macOS/Linux 与 Node >=22.12");
  if (process.getuid?.() === 0) throw new Error("原生沙箱验收必须使用普通用户，不能以 root 掩盖权限边界");
  const package_path = require.resolve("@anthropic-ai/sandbox-runtime/package.json");
  if (JSON.parse(await readFile(package_path, "utf8")).version !== "0.0.79") throw new Error("需要固定 Sandbox Runtime 0.0.79");
  const { SandboxManager } = await import(pathToFileURL(join(dirname(package_path), "dist/index.js")).href);
  const dependencies = await SandboxManager.checkDependenciesAsync();
  if (dependencies.errors.length > 0 || dependencies.warnings.length > 0 || !SandboxManager.isSupportedPlatform()) {
    throw new Error(`原生沙箱依赖不满足：${[...dependencies.errors, ...dependencies.warnings].join("；")}`);
  }
  if (process.platform === "linux") {
    await execute("bwrap", ["--unshare-user", "--unshare-pid", "--unshare-net", "--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev", "--die-with-parent", "--", "/usr/bin/true"]);
  }
  console.log(`原生沙箱探针通过：${process.platform}/${process.arch}，Node ${process.versions.node}`);
  scratch = await mkdtemp(join(tmpdir(), "cord-native-tests-"));
  const report = join(scratch, "vitest.json");
  // 整组验收有独立10分钟上限，单测试仍使用项目原有预算。
  await execute(process.execPath, [require.resolve("vitest/vitest.mjs"), "run", ...suites,
    "--maxWorkers=2", "--reporter=default", "--reporter=json", `--outputFile.json=${report}`], {
    env: { ...process.env, CORD_NATIVE_SANDBOX_TESTS: "1" },
  }, 600_000);
  const result = JSON.parse(await readFile(report, "utf8"));
  const expected = new Set(suites.map(path => join(root, path)));
  if (result.success !== true || result.numPendingTests !== 0 || result.numFailedTests !== 0 || result.numTotalTests < 1
    || result.numTotalTests !== result.numPassedTests || result.testResults.length !== suites.length
    || result.testResults.reduce((total, suite) => total + suite.assertionResults.length, 0) !== result.numTotalTests
    || result.testResults.some(suite => !expected.delete(suite.name) || suite.status !== "passed" || suite.assertionResults.length === 0 || suite.assertionResults.some(test => test.status !== "passed"))) {
    throw new Error("验收报告存在缺失、失败或skip，不能宣称原生支持已通过");
  }
  console.log(`原生沙箱验收通过：${result.numPassedTests} 项，${result.testResults.length} 文件，0 skip`);
} catch (error) {
  console.error(error instanceof Error ? error.message : "原生沙箱验收失败");
  process.exitCode = 1;
} finally {
  if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
}
