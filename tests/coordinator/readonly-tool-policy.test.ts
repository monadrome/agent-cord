import { describe, expect, it } from "vitest";
import { readonlyToolViolation } from "../../src/coordinator/readonly-tool-policy.js";

describe("只读工具审计", () => {
  it("允许明确的读工具", () => {
    for (const name of ["Read", "read_file", "Glob", "git_diff"]) expect(readonlyToolViolation(name, { path: "src/a.ts" })).toBeNull();
  });

  it("允许可核验的无副作用命令，拒绝 shell 控制语法", () => {
    expect(readonlyToolViolation("command_execution", { command: "git diff -- src/a.ts" })).toBeNull();
    expect(readonlyToolViolation("Bash(git diff:*)", { command: "git diff -- src/a.ts" })).toBeNull();
    expect(readonlyToolViolation("command_execution", { command: "git diff; rm -rf ." })).toMatch(/不可核验/);
    expect(readonlyToolViolation("command_execution", {})).toMatch(/不可核验/);
  });

  it("未知、写入和危险 git 参数均 fail-closed", () => {
    expect(readonlyToolViolation("Write", { file_path: "src/a.ts" })).toMatch(/写工具/);
    expect(readonlyToolViolation("file_change", {})).toMatch(/写工具/);
    expect(readonlyToolViolation("mystery_tool", {})).toMatch(/未知工具/);
    expect(readonlyToolViolation("command_execution", { command: "git -c core.pager=cat diff" })).toMatch(/不可核验/);
  });
});
