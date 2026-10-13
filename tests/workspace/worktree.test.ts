import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, rename, chmod, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { create_worktree, read_worktree, bind_worktree_driver } from "../../src/workspace/worktree.js";
import type { AgentDriver, AgentEvent } from "../../src/core/ports.js";
import { runInit, runDoctor } from "../../src/cli.js";

let directory: string;
let source: string;
const git = (cwd: string, args: string[]) => execa("git", args, { cwd, env: { GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined } });
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "cord-worktree-")); source = join(directory, "source"); await mkdir(source);
  await git(source, ["init", "--initial-branch=main"]);
  await writeFile(join(source, "value.txt"), "initial"); await writeFile(join(source, ".gitignore"), ".secret\ncord/\n");
  await git(source, ["add", "."]); await git(source, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "initial"]);
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
async function collect(source: AsyncIterable<AgentEvent>) { const result: AgentEvent[] = []; for await (const event of source) result.push(event); return result; }
function mock_driver(): AgentDriver & { calls: string[] } {
  const calls: string[] = [];
  return { name: "mock", configuration_hash: "a".repeat(64), calls,
    capabilities: { transport: "headless", evidence: "adapter", installation: "unchecked", workspace_isolation: "shared_lease", launch_options: [], native_resume: "supported", goal: "host", workflow_resume: "authorized_unexited_goal" },
    async *run(task) { calls.push(task.cwd); yield { type: "result", data: { text: "result" } }; },
    async *resume(session_id, task) { calls.push(session_id + ":" + task.cwd); yield { type: "result", data: { text: "resumed" } }; },
  };
}

describe("显式独立Git工作树", () => {
  it("登记核验兼容空格/中文/引用路径和Git默认quotePath", async () => {
    await git(source, ["config", "core.quotePath", "true"]);
    const target = join(directory, 'draft 空格 "quoted" \\literal');
    const workspace = await create_worktree(source, target);
    expect((await read_worktree(target))?.identity_hash).toBe(workspace.identity_hash);
    await expect(create_worktree(source, join(directory, "bad\npath"))).rejects.toThrow(/控制字符/);
  });
  it("base包含已跟踪的旧session时拒绝，不把旧授权复制进新工作单元", async () => {
    await mkdir(join(source, "cord/REQ-OLD"), { recursive: true }); await writeFile(join(source, "cord/REQ-OLD/events.jsonl"), "OLD_AUTHORIZATION\n");
    await git(source, ["add", "--force", "cord/REQ-OLD/events.jsonl"]);
    await git(source, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "old session"]);
    const target = join(directory, "draft"); await expect(create_worktree(source, target, "HEAD")).rejects.toThrow(/授权/);
    await expect(access(target)).rejects.toThrow();
  });
  it("固定commit创建detached工作树，源分支/源码不变，多个工作单元独立", async () => {
    const before = (await git(source, ["rev-parse", "HEAD"])).stdout;
    const first = await create_worktree(source, join(directory, "first"));
    const second = await create_worktree(source, join(directory, "second"));
    expect(first.head_commit).toBe(before); expect(second.head_commit).toBe(before);
    expect(first.git_directory).not.toBe(second.git_directory); expect(first.common_directory).toBe(second.common_directory);
    expect((await git(first.root, ["symbolic-ref", "-q", "HEAD"]).catch(error => ({ exitCode: error.exitCode }))).exitCode).toBe(1);
    await writeFile(join(first.root, "value.txt"), "first-draft");
    expect(await readFile(join(second.root, "value.txt"), "utf8")).toBe("initial");
    expect(await readFile(join(source, "value.txt"), "utf8")).toBe("initial");
    expect((await git(source, ["symbolic-ref", "--short", "HEAD"])).stdout).toBe("main");
  });

  it("dirty默认拒绝，显式base只检出commit，不复制未提交或ignored凭据/session", async () => {
    await writeFile(join(source, "value.txt"), "dirty"); await writeFile(join(source, ".secret"), "PRIVATE_CREDENTIAL");
    await mkdir(join(source, "cord")); await writeFile(join(source, "cord/events.jsonl"), "OLD_AUTHORIZATION");
    const destination = join(directory, "draft");
    await expect(create_worktree(source, destination)).rejects.toThrow(/未提交/); await expect(access(destination)).rejects.toThrow();
    const result = await create_worktree(source, destination, "HEAD");
    expect(await readFile(join(result.root, "value.txt"), "utf8")).toBe("initial");
    await expect(access(join(result.root, ".secret"))).rejects.toThrow(); await expect(access(join(result.root, "cord"))).rejects.toThrow();
    expect(await readFile(join(source, "value.txt"), "utf8")).toBe("dirty");
  });

  it.each(["existing", "inside-source", "inside-git", "alias-source", "option-ref", "missing-ref", "control-path"])("%s在创建前拒绝且不覆盖原文件", async mode => {
    let destination = join(directory, "draft"); let base: string | undefined;
    if (mode === "existing") { await mkdir(destination); await writeFile(join(destination, "keep"), "user-data"); }
    if (mode === "inside-source") destination = join(source, "draft");
    if (mode === "inside-git") destination = join(source, ".git/draft");
    if (mode === "alias-source") { await symlink(source, join(directory, "alias")); destination = join(directory, "alias/draft"); }
    if (mode === "option-ref") base = "--help";
    if (mode === "missing-ref") base = "unknown-commit";
    if (mode === "control-path") destination += "\ninvalid";
    await expect(create_worktree(source, destination, base)).rejects.toThrow();
    if (mode === "existing") expect(await readFile(join(destination, "keep"), "utf8")).toBe("user-data");
    else await expect(access(destination)).rejects.toThrow();
    expect(await readFile(join(source, "value.txt"), "utf8")).toBe("initial");
  });

  it("本次创建禁用checkout hook，继承Git路径环境不改变操作仓库", async () => {
    const marker = join(directory, "hook-ran"); const hook = join(source, ".git/hooks/post-checkout");
    await writeFile(hook, `#!/bin/sh\ntouch '${marker}'\n`); await chmod(hook, 0o755);
    const old = process.env["GIT_WORK_TREE"]; process.env["GIT_WORK_TREE"] = join(directory, "wrong");
    try {
      const result = await create_worktree(source, join(directory, "draft"));
      expect(await readFile(join(result.root, "value.txt"), "utf8")).toBe("initial"); await expect(access(marker)).rejects.toThrow();
    } finally { if (old === undefined) delete process.env["GIT_WORK_TREE"]; else process.env["GIT_WORK_TREE"] = old; }
  });

  it("实际CLI创建并输出可核验身份，拒绝多余参数且不启动server/agent", async () => {
    const cli = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
    const loader = fileURLToPath(new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url));
    const result = await execa(process.execPath, ["--import", loader, cli, "worktree", join(directory, "cli-draft"), "--base", "HEAD"], { cwd: source });
    const identity = JSON.parse(result.stdout); expect(identity).toMatchObject({ root: expect.stringContaining("cli-draft"), head_commit: expect.stringMatching(/^[0-9a-f]{40,64}$/) });
    const bad = await execa(process.execPath, ["--import", loader, cli, "worktree", join(directory, "bad"), "extra"], { cwd: source, reject: false });
    expect(bad.exitCode).not.toBe(0); await expect(access(join(directory, "bad"))).rejects.toThrow();
    const help = await execa(process.execPath, ["--import", loader, cli, "worktree", join(directory, "help"), "--help"], { cwd: source });
    expect(help.stdout).toContain("cord worktree"); await expect(access(join(directory, "help"))).rejects.toThrow();
  });
});

describe("工作树执行身份", () => {
  it("复制其他工作树gitfile不能冒称已登记工作树，物理目录替换拒绝原绑定", async () => {
    const workspace = await create_worktree(source, join(directory, "draft")); const raw = mock_driver(); const bound = bind_worktree_driver(raw, workspace);
    const forged = join(directory, "forged"); await mkdir(forged); await writeFile(join(forged, ".git"), await readFile(join(workspace.root, ".git")));
    await expect(read_worktree(forged)).rejects.toThrow(/引用|登记/);
    const second = await create_worktree(source, join(directory, "second")); const second_file = await readFile(join(second.root, ".git"));
    await writeFile(join(second.root, ".git"), await readFile(join(workspace.root, ".git")));
    await expect(read_worktree(second.root)).rejects.toThrow(/引用/); await writeFile(join(second.root, ".git"), second_file);
    const previous = workspace.root + ".previous"; await rename(workspace.root, previous); await mkdir(workspace.root);
    await writeFile(join(workspace.root, ".git"), await readFile(join(previous, ".git")));
    expect((await collect(bound.run({ cwd: workspace.root, prompt: "task" })))[0]).toMatchObject({ type: "error", data: { kind: "configuration" } });
    expect(raw.calls).toEqual([]);
    await rm(workspace.root, { recursive: true }); await rename(previous, workspace.root);
    expect((await collect(bound.run({ cwd: workspace.root, prompt: "repaired" }))).at(-1)?.type).toBe("result");
  });
  it("非法timeout/resume在工作树查询前拒绝，不派发底层调用", async () => {
    const workspace = await create_worktree(source, join(directory, "draft")); const raw = mock_driver(); const bound = bind_worktree_driver(raw, workspace);
    await rename(join(workspace.root, ".git"), join(workspace.root, ".git.saved"));
    expect((await collect(bound.run({ cwd: workspace.root, prompt: "task", timeout_ms: 0 })))[0]).toMatchObject({ type: "error", data: { message: expect.stringContaining("timeout_ms"), kind: "configuration" } });
    expect((await collect(bound.resume("--last", { cwd: workspace.root, prompt: "task" })))[0]).toMatchObject({ type: "error", data: { message: expect.stringContaining("session"), kind: "configuration" } });
    expect(raw.calls).toEqual([]);
  });
  it("doctor读取工作树公共Git配置，坏gitfile不能假报通过", async () => {
    const workspace = await create_worktree(source, join(directory, "draft")); await runInit(workspace.root);
    expect((await runDoctor(workspace.root)).ok).toBe(false);
    await git(source, ["config", "merge.cord-event-log.driver", "cord-merge-driver %O %A %B"]);
    expect((await runDoctor(workspace.root)).ok).toBe(true);
    await rename(join(workspace.root, ".git"), join(workspace.root, ".git.saved"));
    await writeFile(join(workspace.root, ".git"), "gitdir: /invalid\n");
    expect((await runDoctor(workspace.root)).checks.find(check => check.name === "merge_driver")).toMatchObject({ ok: false });
  });
  it("执行中gitfile被替换追加configuration错误，候选result不能冒称有效完成", async () => {
    const workspace = await create_worktree(source, join(directory, "draft")); const raw = mock_driver();
    raw.run = async function* () { await rename(join(workspace.root, ".git"), join(workspace.root, ".git.saved")); yield { type: "result", data: { text: "candidate" } }; };
    const events = await collect(bind_worktree_driver(raw, workspace).run({ cwd: workspace.root, prompt: "task" }));
    expect(events.map(event => event.type)).toEqual(["result", "error"]); expect(events.at(-1)).toMatchObject({ data: { kind: "configuration" } });
    await rename(join(workspace.root, ".git.saved"), join(workspace.root, ".git"));
  });
  it("主工作树/普通目录不冒称linked隔离，坏gitfile拒绝", async () => {
    expect(await read_worktree(source)).toBeNull(); expect(await read_worktree(directory)).toBeNull();
    await writeFile(join(directory, ".git"), "gitdir: /unavailable\n");
    await expect(read_worktree(directory)).rejects.toThrow();
  });

  it("包装配置绑定工作树，run和明确resume都在该cwd实际派发", async () => {
    const first = await create_worktree(source, join(directory, "first")); const second = await create_worktree(source, join(directory, "second"));
    const raw = mock_driver(); const bound = bind_worktree_driver(raw, first);
    expect(bound.capabilities?.workspace_isolation).toBe("worktree"); expect(raw.capabilities?.workspace_isolation).toBe("shared_lease");
    expect(bound.configuration_hash).not.toBe(raw.configuration_hash);
    expect(bound.configuration_hash).not.toBe(bind_worktree_driver(raw, second).configuration_hash);
    const original_root = first.root; first.root = second.root;
    expect((await collect(bound.run({ cwd: second.root, prompt: "changed-binding" })))[0]).toMatchObject({ type: "error", data: { kind: "configuration" } });
    expect(raw.calls).toEqual([]); first.root = original_root;
    expect(bind_worktree_driver(raw, null)).toBe(raw);
    expect((await collect(bound.run({ cwd: first.root, prompt: "task" }))).at(-1)?.type).toBe("result");
    expect((await collect(bound.resume("fixed-session", { cwd: first.root, prompt: "resume" }))).at(-1)?.type).toBe("result");
    expect(raw.calls).toEqual([first.root, "fixed-session:" + first.root]);
  });

  it.each(["cwd", "gitfile", "cancelled"])("%s错误不调用底层agent，修复后原绑定可用", async mode => {
    const workspace = await create_worktree(source, join(directory, "draft")); const raw = mock_driver(); const bound = bind_worktree_driver(raw, workspace);
    const controller = new AbortController();
    if (mode === "gitfile") await rename(join(workspace.root, ".git"), join(workspace.root, ".git.saved"));
    if (mode === "cancelled") controller.abort();
    const events = await collect(bound.run({ cwd: mode === "cwd" ? source : workspace.root, prompt: "PRIVATE_PROMPT", signal: controller.signal }));
    expect(raw.calls).toEqual([]); expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", data: { kind: mode === "cancelled" ? "agent" : "configuration" } });
    expect(JSON.stringify(events)).not.toContain("PRIVATE_PROMPT");
    if (mode === "gitfile") await rename(join(workspace.root, ".git.saved"), join(workspace.root, ".git"));
    await collect(bound.run({ cwd: workspace.root, prompt: "repaired" })); expect(raw.calls).toEqual([workspace.root]);
  });
});
