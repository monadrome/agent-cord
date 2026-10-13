import { copyFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cord-native-entry-fixture-"));
  for (const path of ["scripts", "bin", "node_modules/vitest", "node_modules/@anthropic-ai/sandbox-runtime/dist"]) await mkdir(join(root, path), { recursive: true });
  await copyFile(new URL("../../scripts/test-native-sandbox.mjs", import.meta.url), join(root, "scripts/test-native-sandbox.mjs"));
  await writeFile(join(root, "node_modules/@anthropic-ai/sandbox-runtime/package.json"), JSON.stringify({ version: "0.0.79", type: "module" }));
  // 替身仅验证入口的报告与收束，不作为真实OS验收证据。
  await writeFile(join(root, "node_modules/@anthropic-ai/sandbox-runtime/dist/index.js"), "export const SandboxManager={checkDependenciesAsync:async()=>({errors:[],warnings:[]}),isSupportedPlatform:()=>true};");
  await writeFile(join(root, "bin/bwrap"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await writeFile(join(root, "node_modules/vitest/vitest.mjs"), `import {writeFileSync} from 'node:fs';
const args=process.argv.slice(2);const suites=args.slice(1,args.indexOf('--maxWorkers=2'));
const report={success:true,numPendingTests:0,numFailedTests:0,numTotalTests:8,numPassedTests:8,testResults:suites.map(name=>({name:process.cwd()+'/'+name,status:'passed',assertionResults:[{status:'passed'}]}))};
const mode=process.env.CORD_ENTRY_FIXTURE;
if(mode==='pending'){report.numPendingTests=1;report.testResults[0].assertionResults[0].status='pending'}
if(mode==='failed'){report.numFailedTests=1;report.testResults[0].assertionResults[0].status='failed'}
if(mode==='empty'){report.testResults[0].assertionResults=[]}
if(mode==='duplicate'){report.testResults[0].name=report.testResults[1].name}
writeFileSync(args.find(arg=>arg.startsWith('--outputFile.json=')).slice('--outputFile.json='.length),JSON.stringify(report));
if(mode==='interrupt'){
const child=(await import('node:child_process')).spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)"],{stdio:['ignore','pipe','inherit']});
process.on('SIGTERM',()=>{});child.stdout.once('data',()=>console.log(JSON.stringify({pids:[process.pid,child.pid]})));setInterval(()=>{},1000);
}`);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
function run(mode: string) {
  const child = spawn(process.execPath, [join(root, "scripts/test-native-sandbox.mjs")], { env: { ...process.env, PATH: join(root, "bin") + ":" + process.env.PATH, CORD_ENTRY_FIXTURE: mode }, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; });
  const closed = new Promise<number | null>(resolve => child.once("close", resolve));
  return { child, closed, output: () => output };
}
const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
const supported = ["darwin", "linux"].includes(process.platform) && process.getuid?.() !== 0 && (major > 22 || major === 22 && minor >= 12);
describe.skipIf(!supported)("严格原生入口控制（离线替身）", () => {
  it("完整八文件报告通过", async () => {
    const result = run("passed"); expect(await result.closed).toBe(0); expect(result.output()).toContain("8 文件，0 skip");
  });
  it.each(["pending", "failed", "empty", "duplicate"])("%s报告即使子进程exit0也拒绝；完整报告可恢复", async mode => {
    const result = run(mode); expect(await result.closed).toBe(1); expect(result.output()).toContain("不能宣称原生支持已通过");
    const recovered = run("passed"); expect(await recovered.closed).toBe(0);
  });
  it("中断强制回收忽略SIGTERM的测试父子进程，不输出验收成功", async () => {
    const result = run("interrupt");
    try {
      await expect.poll(result.output).toContain('"pids"');
      const pids: number[] = JSON.parse(result.output().split("\n").find(line => line.startsWith('{"pids"'))!).pids;
      result.child.kill("SIGINT"); expect(await result.closed).toBe(1); expect(result.output()).not.toContain("验收通过");
      for (const pid of pids) await expect.poll(() => { try { process.kill(pid, 0); return true; } catch { return false; } }).toBe(false);
    } finally { result.child.kill("SIGINT"); await result.closed; }
  });
});
