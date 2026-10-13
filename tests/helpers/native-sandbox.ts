/** 原生沙箱验收开关：显式模式缺依赖必须失败，不能静默跳过（ADR-0104）。 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
const supported = ["darwin", "linux"].includes(process.platform) && (major > 22 || major === 22 && minor >= 12);
const required = process.env["CORD_NATIVE_SANDBOX_TESTS"] === "1";
let runtime = false;
try {
  const path = createRequire(import.meta.url).resolve("@anthropic-ai/sandbox-runtime/package.json");
  runtime = JSON.parse(readFileSync(path, "utf8")).version === "0.0.79";
} catch { /* 可选依赖不存在时普通离线测试仍可运行。 */ }

if (required && (!supported || !runtime)) throw new Error("原生沙箱验收需要 macOS/Linux、Node >=22.12 与固定 Sandbox Runtime 0.0.79");

export const native_sandbox_available = supported && runtime && (process.platform === "darwin" || required);
