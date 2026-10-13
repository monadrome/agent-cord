/** ADR-0104：隐藏目录也必须拒写；不改runtime生成的shell文本。 */
import { constants } from "node:fs";
import { access, realpath, stat, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";

export function linux_bwrap_arguments(input: string[], read_profile: (fd: number) => string[] = () => { throw new Error("缺少参数文件"); }): string[] {
  const args = [...input];
  if (args.length === 1 && args[0] === "--version") return args;
  const arities: Record<string, number> = { "--new-session": 0, "--die-with-parent": 0, "--unshare-user": 0, "--unshare-pid": 0, "--unshare-net": 0,
    "--cap-add": 1, "--cap-drop": 1, "--unsetenv": 1, "--setenv": 2, "--bind": 2, "--ro-bind": 2, "--dev-bind": 2, "--dev": 1, "--proc": 1, "--tmpfs": 1 };
  const masks = new Set<string>(); let profiles = 0;
  for (let i = 0; i < args.length;) {
    const flag = args[i]!;
    if (flag === "--") {
      if (i + 1 >= args.length || args.length + masks.size * 2 > 4096 || args.some(arg => arg.includes("\0"))) throw new Error("无效沙箱参数");
      return [...args.slice(0, i), ...[...masks].flatMap(path => ["--remount-ro", path]), ...args.slice(i)];
    }
    if (flag === "--args") {
      const fd = args[i + 1];
      if (++profiles > 1 || fd === undefined || !/^\d+$/.test(fd) || Number(fd) < 3 || Number(fd) > 1024) throw new Error("无效参数文件");
      const words = read_profile(Number(fd));
      if (words.length > 4096 || words.includes("--")) throw new Error("无效参数文件");
      args.splice(i, 2, ...words); continue;
    }
    const arity = Object.hasOwn(arities, flag) ? arities[flag] : undefined;
    if (arity === undefined || i + arity >= args.length) throw new Error("未知或缺失沙箱参数");
    if (["--tmpfs", "--bind", "--ro-bind", "--dev-bind", "--dev", "--proc"].includes(flag)) {
      const path = args[i + arity]!;
      if (!path.startsWith("/") || path.includes("\0")) throw new Error("无效挂载路径");
      if (flag === "--tmpfs") masks.add(path); else masks.delete(path);
    }
    i += arity + 1;
  }
  throw new Error("缺少沙箱命令边界");
}

export async function prepare_linux_bwrap(scratch: string, quote: (args: string[]) => string): Promise<string> {
  let binary: string | undefined;
  for (const directory of (process.env["PATH"] ?? "").split(delimiter)) {
    if (!directory.startsWith("/")) continue;
    const path = join(directory, "bwrap");
    try { await access(path, constants.X_OK); if ((await stat(path)).isFile()) { binary = await realpath(path); break; } } catch {}
  }
  if (binary === undefined) throw new Error("缺少bubblewrap");
  // 包装器在宿主先读取参数；agent启动后不能改变已采用的权限配置。
  const bootstrap = `try {
    const fs = require('node:fs');
    const args = (${linux_bwrap_arguments.toString()})(process.argv.slice(1), fd => {
      if (fs.fstatSync(fd).size > 1024 * 1024) throw new Error('参数文件过大');
      const text = fs.readFileSync(fd, 'utf8');
      if (!text.endsWith('\\0')) throw new Error('参数文件边界无效');
      return text.slice(0, -1).split('\\0');
    });
    const result = require('node:child_process').spawnSync(${JSON.stringify(binary)}, args, {stdio: 'inherit', shell: false});
    process.exit(result.error === undefined && result.signal === null ? result.status ?? 1 : 1);
  } catch { process.stderr.write('Linux沙箱参数核验失败\\n'); process.exit(1); }`;
  const path = join(scratch, "readonly-bwrap");
  await writeFile(path, `#!/bin/sh\nexec ${quote([process.execPath, "-e", bootstrap, "--"])} "$@"\n`, { flag: "wx", mode: 0o500 });
  return path;
}
