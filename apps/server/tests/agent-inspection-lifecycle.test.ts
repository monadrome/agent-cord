import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { ulid } from "ulid";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp, type BuiltServer } from "@agent-cord/server";

type Protocol = "headless" | "acp";
const cli_fixture = fileURLToPath(new URL("../../../tests/driver/fixtures/cli-inspection.mjs", import.meta.url));
const acp_fixture = fileURLToPath(new URL("../../../tests/driver/fixtures/fake-acp-agent.mjs", import.meta.url));
let root: string; let server: BuiltServer; let base: string;
const path = (name: string) => join(root, name);
async function wait(test: () => Promise<boolean>, message: string, timeout_ms = 4000) {
  const deadline = Date.now() + timeout_ms;
  while (!await test()) { if (Date.now() >= deadline) throw new Error(message); await new Promise(resolve => setTimeout(resolve, 10)); }
}
async function logs(): Promise<Array<Record<string, any>>> {
  return readFile(path("calls.jsonl"), "utf8").then(text => text.trim().split("\n").filter(Boolean).map(line => JSON.parse(line))).catch(() => []);
}
async function configure(protocol: Protocol, mode: string) {
  const probe = protocol === "headless" ? { kind: "headless", template: "claude", bin: path("cli.mjs"), env: {
    CORD_INSPECT_PROFILE: "claude", CORD_INSPECT_SCENARIO: mode, CORD_INSPECT_RECORD: path("calls.jsonl"),
    CORD_INSPECT_PID_FILE: path("pid"), CORD_INSPECT_CHILD_PID_FILE: path("child-pid"), CORD_INSPECT_GATE_FILE: path("release"),
  } } : { kind: "acp", bin: process.execPath, args: [acp_fixture, "--config", "--no-tools", "--mode", mode,
    "--record", path("calls.jsonl"), "--pid-file", path("pid"), "--gate-file", path("release")] };
  await writeFile(path("cord/agents.yaml"), stringify({ agents: { probe, other: { kind: "acp", bin: "/missing/other-agent" } } }));
  await server.agents.reload();
}
async function api(name = "probe", input: Record<string, unknown> = {}, key = ulid()) {
  const response = await fetch(`${base}/api/v1/agents/${name}/inspect`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify(input) });
  return { status: response.status, body: await response.json() };
}
async function started(protocol: Protocol) {
  await wait(async () => (await logs()).some(entry => protocol === "acp" ? entry.event === "initialize" : entry.args?.[0] === "--version"), "能力查询未启动");
  if (protocol === "headless") await wait(async () => readFile(path("child-pid"), "utf8").then(() => true).catch(() => false), "CLI诊断子进程未启动");
}
async function assert_dead(file: string) {
  const pid = Number(await readFile(path(file), "utf8"));
  await wait(async () => { try { process.kill(pid, 0); return false; } catch { return true; } }, "查询进程未收束");
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cord-inspection-lifecycle-")); await mkdir(path("cord"));
  await copyFile(cli_fixture, path("cli.mjs")); await chmod(path("cli.mjs"), 0o755);
  server = await buildApp({ root }); base = await server.app.listen({ host: "127.0.0.1", port: 0 });
});
afterEach(async () => { vi.restoreAllMocks(); await server.app.close(); server.index.close(); await rm(root, { recursive: true, force: true }); });

describe("能力查询实际进程与HTTP生命周期", () => {
  it.each(["headless", "acp"] as const)("%s 不同幂等键/默认timeout共享实际进程，冲突不spawn，完成后新查询重新探测", async protocol => {
    await configure(protocol, protocol === "headless" ? "gate-version" : "gate-init");
    const service = vi.spyOn(server.agents, "inspect");
    const first = api(); await started(protocol);
    const second = api("probe", { timeout_ms: 5000 });
    await wait(async () => service.mock.calls.length === 2, "第二个HTTP请求未进入查询");
    expect(await api("probe", { timeout_ms: 1000 })).toMatchObject({ status: 409 });
    expect(await api("other")).toMatchObject({ status: 409 });
    expect((await logs()).length).toBe(1);
    await writeFile(path("release"), "ready");
    const [a, b] = await Promise.all([first, second]);
    expect(a.status).toBe(200); expect(b.status).toBe(200);
    expect(a.body.request_id).not.toBe(b.body.request_id);
    expect(a.body.observation).toEqual(b.body.observation); expect(a.body.cli_observation).toEqual(b.body.cli_observation);
    expect(a.body.configuration_hash).toBe(b.body.configuration_hash); expect(a.body.current).toBe(true);
    const count = () => logs().then(entries => entries.filter(entry => protocol === "acp" ? entry.event === "initialize" : entry.args?.[0] === "--version").length);
    expect(await count()).toBe(1);
    expect((await api()).status).toBe(200); expect(await count()).toBe(2);
    expect((await logs()).some(entry => entry.event === "prompt")).toBe(false);
    expect(await server.sessions.listIds()).toEqual([]);
  });

  it.each(["headless", "acp"] as const)("%s 重载期间新配置冲突，原共享结果保持旧身份，清理后可新探测", async protocol => {
    await configure(protocol, protocol === "headless" ? "gate-version" : "gate-init");
    const before = server.agents.catalog(); const pending = api(); await started(protocol);
    await configure(protocol, "normal");
    expect((await api()).status).toBe(409);
    await writeFile(path("release"), "ready");
    expect(await pending).toMatchObject({ status: 200, body: { revision: before.revision, current: false } });
    expect(await api()).toMatchObject({ status: 200, body: { current: true, revision: before.revision + 1 } });
  });

  it.each(["headless", "acp"] as const)("%s 超时/失败后释放槽位，修复配置再查询成功", async protocol => {
    await configure(protocol, protocol === "headless" ? "hang" : "hang-init");
    const failed = await api("probe", { timeout_ms: 2000 });
    expect(failed.status).toBe(protocol === "headless" ? 200 : 400);
    if (protocol === "headless") expect(failed.body.cli_observation.status).toBe("timeout");
    await assert_dead("pid"); if (protocol === "headless") await assert_dead("child-pid");
    await configure(protocol, protocol === "headless" ? "fail" : "bad-version");
    const failure = await api(); expect(failure.status).toBe(protocol === "headless" ? 200 : 400);
    if (protocol === "headless") expect(failure.body.cli_observation.status).toBe("failed");
    await configure(protocol, "normal"); expect((await api()).status).toBe(200);
  });

  it.each(["headless", "acp"] as const)("%s 服务关闭取消10秒在途HTTP查询，返回503前已清理进程，关闭后拒绝重载", async protocol => {
    await configure(protocol, protocol === "headless" ? "hang" : "hang-new");
    const pending = api("probe", { timeout_ms: 10000 }); await started(protocol);
    if (protocol === "acp") await wait(async () => (await logs()).some(entry => entry.event === "session/new"), "ACP未进入session/new");
    const closing = server.agents.close();
    expect(await pending).toMatchObject({ status: 503, body: { code: "service_closing" } }); await closing;
    await assert_dead("pid"); if (protocol === "headless") await assert_dead("child-pid");
    expect((await api()).status).toBe(503);
    await expect(server.agents.reload()).rejects.toMatchObject({ statusCode: 503 });
    expect((await logs()).some(entry => entry.event === "prompt")).toBe(false);
  });

  it.each(["headless", "acp"] as const)("%s Fastify preClose收束真实查询，不等10秒deadline或留下进程", async protocol => {
    await configure(protocol, protocol === "headless" ? "hang" : "hang-init");
    const pending = api("probe", { timeout_ms: 10000 }).then(value => ({ response: value }), () => ({ disconnected: true }));
    await started(protocol);
    const settled = await Promise.race([server.app.close().then(() => true), new Promise<false>(resolve => { const timer = setTimeout(() => resolve(false), 4000); timer.unref(); })]);
    expect(settled).toBe(true);
    const outcome = await pending;
    if ("response" in outcome) expect(outcome.response).toMatchObject({ status: 503, body: { code: "service_closing" } });
    await assert_dead("pid"); if (protocol === "headless") await assert_dead("child-pid");
    await expect(server.agents.inspect("probe")).rejects.toMatchObject({ statusCode: 503 });
  });

  it("共享观察返回独立副本，排队reload在close后不提交新版本", async () => {
    await configure("acp", "gate-init"); const revision = server.agents.catalog().revision;
    const first = server.agents.inspect("probe"); await started("acp"); const second = server.agents.inspect("probe");
    await writeFile(path("release"), "ready"); const [a, b] = await Promise.all([first, second]);
    a.observation!.modes.push("mutated"); a.capabilities!.launch_options = ["mutated"];
    expect(b.observation!.modes).not.toContain("mutated"); expect(server.agents.catalog().agents.find(agent => agent.name === "probe")!.capabilities!.launch_options).not.toContain("mutated");
    const reloading = server.agents.reload(); const closing = server.agents.close();
    await expect(reloading).rejects.toMatchObject({ statusCode: 503 }); await closing;
    expect(server.agents.catalog().revision).toBe(revision);
  });
});
