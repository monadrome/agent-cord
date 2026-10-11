import { describe, expect, it } from "vitest";
import { readonlyToolViolation } from "../../src/coordinator/readonly-tool-policy.js";

describe("只读命令明确参数语义", () => {
  it("包装工具名不能把命令/路径正文写入拒绝原因", () => {
    const error = readonlyToolViolation("Bash(git diff --output=PRIVATE_OUTPUT)", { command: "git diff --output=PRIVATE_OUTPUT" });
    expect(error).toMatch(/不可核验/); expect(error).not.toContain("PRIVATE_OUTPUT");
  });
  it.each([
    "rg --pre touch --pre-glob '*.ts' pattern src", "rg --pre=touch pattern src", "rg --hostname-bin=touch pattern src",
    "git diff --output=PRIVATE_OUTPUT", "git log --output PRIVATE_OUTPUT", "git show --ext-diff HEAD", "git diff --textconv",
    "find src -fprint PRIVATE_OUTPUT", "find src -fprintf PRIVATE_OUTPUT pattern", "find src -execdir touch marker +",
    "file --compile", "cat --unknown-option file", "/tmp/git diff", "./rg pattern src", "/usr/bin/../tmp/git diff",
    "git diff --config-env=diff.external=PRIVATE_ENV", "grep --unknown-option pattern file", "__proto__", "git __proto__", "git constructor",
  ])("危险/未知选项或路径冒认拒绝：%s", command => {
    const error = readonlyToolViolation("command_execution", { command }); expect(error).toMatch(/不可核验/); expect(error).not.toContain("PRIVATE");
  });

  it.each([
    ["rg", "--pre", "touch", "pattern", "src"], ["git", "diff", "--output=PRIVATE_OUTPUT"], ["find", "src", "-fprint", "PRIVATE_OUTPUT"],
    ["cat", "--unknown-option", "file"], ["/tmp/git", "diff"],
  ])("structured危险argv不能因保留数组而放行：%j", (...argv: string[]) => {
    expect(readonlyToolViolation("command_execution", { argv })).toMatch(/不可核验/);
  });

  it.each([
    "git diff --stat -- src/a.ts", "git --no-pager log --oneline -n5", "git show --no-ext-diff --no-textconv HEAD",
    "rg -n -gsrc pattern src", "grep -n -e pattern src/a.ts", "find src -type f -name file.ts -print",
    "ls -lah src", "cat -n src/a.ts", "head -n 20 src/a.ts", "tail -n20 src/a.ts", "wc -l src/a.ts", "/usr/bin/git diff -- src/a.ts", "find -L src -type f -print",
  ])("常见明确读选项可用：%s", command => { expect(readonlyToolViolation("command_execution", { command })).toBeNull(); });

  it.each([
    ["rg", "--fixed-strings", "pattern with space; $(literal)", "src"], ["find", "src with space", "-name", "*.ts", "-print"],
    ["git", "diff", "--", "--output=literal-file"], ["cat", "--", "--unknown-option"], ["rg", "--", "--pre=literal-pattern", "src"],
  ])("structured argv保留空格/字面量和--后数据：%j", (...argv: string[]) => {
    expect(readonlyToolViolation("command_execution", { argv })).toBeNull();
  });

  it.each([
    { command: "git diff", argv: ["git", "diff", "--output=PRIVATE_OUTPUT"] }, { command: null, argv: ["git", "diff"] },
    { cmd: "git diff", shell_command: "rg --pre touch pattern" }, { argv: ["cat", "PRIVATE\nFILE"] }, { argv: [] }, { argv: ["rg", 1] },
    { argv: ["rg", "--glob"] }, { argv: ["find", "src", "-name"] },
  ])("矛盾/非法/缺参数不能回退安全输入：%j", input => { expect(readonlyToolViolation("command_execution", input)).toMatch(/不可核验/); });
});
