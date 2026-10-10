// 用于验证跨进程互斥、崩溃遗留标记与 detached 子进程边界。
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const { WorkspaceLease } = await import(new URL("../../../apps/server/src/services/workspace-lease.ts", import.meta.url));
const lease = new WorkspaceLease(process.argv[2]);
lease.acquire("REQ-CHILD", "child-run");
const pid_file = process.argv[3];
if (pid_file !== undefined) {
  const worker = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { detached: true, stdio: "ignore" });
  worker.unref(); writeFileSync(pid_file, String(worker.pid));
}
process.send?.({ status: "held" });
process.on("message", message => {
  if (message?.action === "release") { lease.close(); process.exit(0); }
});
