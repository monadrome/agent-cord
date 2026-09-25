import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AcpDriver } from "../../src/driver/acp.js";
import { HeadlessDriver, registerHeadlessCliTemplate } from "../../src/driver/headless.js";
import {
  detectAcpSupport,
  registerKnownAgent,
  resolveDriver,
} from "../../src/driver/registry.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-cli.mjs");

describe("resolveDriver", () => {
  it("裸名先探 ACP：kimi 有原生 acp 子命令 → AcpDriver", () => {
    const driver = resolveDriver("kimi");
    expect(driver).toBeInstanceOf(AcpDriver);
    expect(driver.name).toBe("acp:kimi");
    expect((driver as AcpDriver).bin).toBe("kimi");
    expect((driver as AcpDriver).args).toEqual(["acp"]);
  });

  it("ACP 探测为否时降级到裸 headless 模板", () => {
    const driver = resolveDriver("kimi", { supportsAcp: () => false });
    expect(driver).toBeInstanceOf(HeadlessDriver);
    expect(driver.name).toBe("headless:kimi");
  });

  it("claude / codex 无原生 ACP，默认走直连适配器（headless）", () => {
    const claude = resolveDriver("claude");
    const codex = resolveDriver("codex");
    expect(claude).toBeInstanceOf(HeadlessDriver);
    expect(codex).toBeInstanceOf(HeadlessDriver);
    expect((claude as HeadlessDriver).buildArgv({ prompt: "p", cwd: "/w" })[0]).toBe("claude");
    expect((codex as HeadlessDriver).buildArgv({ prompt: "p", cwd: "/w" })).toContain("--json");
  });

  it("显式前缀跳过探测", () => {
    const headless = resolveDriver("headless:kimi");
    expect(headless).toBeInstanceOf(HeadlessDriver);
    expect((headless as HeadlessDriver).buildArgv({ prompt: "p", cwd: "/w" })).toContain("--output-format");

    const acp = resolveDriver("acp:claude");
    expect(acp).toBeInstanceOf(AcpDriver);
    expect((acp as AcpDriver).bin).toBe("claude-agent-acp");

    const unknownAcp = resolveDriver("acp:some-other-agent");
    expect(unknownAcp).toBeInstanceOf(AcpDriver);
    expect((unknownAcp as AcpDriver).bin).toBe("some-other-agent");
    expect((unknownAcp as AcpDriver).args).toEqual(["acp"]);
  });

  it("解析不出来时给出可操作的报错", () => {
    expect(() => resolveDriver("nope")).toThrow(/no driver for "nope"/);
    expect(() => resolveDriver("nope")).toThrow(/known agents: /);
    expect(() => resolveDriver("headless:nope")).toThrow(/unknown headless CLI "nope"/);
    expect(() => resolveDriver("bogus:kimi")).toThrow(/unknown driver prefix "bogus"/);
    expect(() => resolveDriver("acp:")).toThrow(/invalid driver name/);
  });

  it("注册新 agent / 新模板后即可解析（新增 agent 零代码）", () => {
    registerKnownAgent("acme", { acp: { bin: "acme", args: ["acp"] }, headless: "acme-cli" });
    registerHeadlessCliTemplate({
      name: "acme-cli",
      bin: "acme-cli",
      args: ({ prompt, readonly }) => [...(readonly ? ["--read-only"] : []), "-p", prompt],
    });

    expect(resolveDriver("acme")).toBeInstanceOf(AcpDriver);
    expect(resolveDriver("acme", { supportsAcp: () => false })).toBeInstanceOf(HeadlessDriver);

    const byTemplate = resolveDriver("headless:acme-cli");
    expect(byTemplate).toBeInstanceOf(HeadlessDriver);
    expect((byTemplate as HeadlessDriver).buildArgv({ prompt: "p", cwd: "/w", readonly: true })).toEqual([
      "acme-cli",
      "--read-only",
      "-p",
      "p",
    ]);
  });
});

describe("detectAcpSupport", () => {
  it("从 --help 里认出 acp 子命令", async () => {
    await expect(detectAcpSupport(process.execPath, [fixture])).resolves.toBe(true);
  });

  it("二进制不存在时不抛异常，直接判否", async () => {
    await expect(detectAcpSupport("/nonexistent/cord-cli")).resolves.toBe(false);
  });
});
