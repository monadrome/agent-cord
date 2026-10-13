import { describe, expect, it } from "vitest";
import { linux_bwrap_arguments } from "../../src/sandbox/linux-bwrap.js";

describe("Linux隐藏目录拒写", () => {
  it("最终遮罩只读而子挂载继续使用原权限，argv正文保持字面值", () => {
    const args = ["--tmpfs", "/home", "--bind", "/home/private", "/home/private", "--tmpfs", "/workspace/cord", "--setenv", "LITERAL", "--tmpfs", "--", "/bin/bash", "-c", "literal --tmpfs $(touch BAD)"];
    expect(linux_bwrap_arguments(args)).toEqual(["--tmpfs", "/home", "--bind", "/home/private", "/home/private", "--tmpfs", "/workspace/cord", "--setenv", "LITERAL", "--tmpfs", "--remount-ro", "/home", "--remount-ro", "/workspace/cord", "--", "/bin/bash", "-c", "literal --tmpfs $(touch BAD)"]);
    expect(linux_bwrap_arguments(["--tmpfs", "/code", "--bind", "/code", "/code", "--", "/bin/true"])).toEqual(["--tmpfs", "/code", "--bind", "/code", "/code", "--", "/bin/true"]);
  });
  it("有界NUL参数文件中的遮罩也拒写，版本探针兼容", () => {
    expect(linux_bwrap_arguments(["--new-session", "--args", "9", "--", "/bin/true"], fd => { expect(fd).toBe(9); return ["--tmpfs", "/tmp"]; })).toEqual(["--new-session", "--tmpfs", "/tmp", "--remount-ro", "/tmp", "--", "/bin/true"]);
    expect(linux_bwrap_arguments(["--version"])).toEqual(["--version"]);
  });
  it.each([["--unknown", "--", "/bin/true"], ["--tmpfs"], ["--tmpfs", "relative", "--", "/bin/true"], ["--args", "0", "--", "/bin/true"], ["--", "/bin/true\0bad"], ["--"]])("无效参数%j拒绝而不执行", args => {
    expect(() => linux_bwrap_arguments(args)).toThrow();
  });
  it("参数文件不能嵌套或改变命令边界，修复后可重新解析", () => {
    const args = ["--args", "9", "--", "/bin/true"];
    for (const profile of [["--args", "10"], ["--", "/bin/false"], Array(4097).fill("--new-session")]) expect(() => linux_bwrap_arguments(args, () => profile)).toThrow();
    expect(linux_bwrap_arguments(args, () => ["--tmpfs", "/tmp"])).toContain("--remount-ro");
  });
});
