/** ADR-0060：合作 ACP agent 的文件范围授权，不代替操作系统隔离。 */
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";
import { resolveSafeSessionFile, resolveSessionFile, statSessionDocument } from "../core/session-files.js";
import type { PermissionDecision } from "./acp.js";

const PathsSchema = z.array(z.string().min(1).max(500).refine(path => resolveSessionFile(".", path) !== null, "权限范围必须是规范相对路径，不能指向事实文件或管理目录")).max(64).default([]);
export const AcpPermissionPolicySchema = z.strictObject({ read: PathsSchema, edit: PathsSchema })
  .refine(value => value.read.length + value.edit.length > 0, "权限策略必须声明至少一个 read/edit 范围")
  .transform(value => ({ read: [...new Set(value.read)].sort(), edit: [...new Set(value.edit)].sort() }));
export type AcpPermissionPolicy = z.output<typeof AcpPermissionPolicySchema>;
export type AcpPermissionPolicyInput = z.input<typeof AcpPermissionPolicySchema>;

const CallSchema = z.object({ kind: z.enum(["read", "edit"]), locations: z.array(z.object({ path: z.string().min(1).max(4000) })).min(1).max(64) });
const OptionsSchema = z.array(z.object({ optionId: z.string().min(1).max(2000), kind: z.enum(["allow_once", "allow_always", "reject_once", "reject_always"]) })).min(1).max(64);

export async function decideAcpWorkspacePermission(request: RequestPermissionRequest, policy: AcpPermissionPolicy, cwd: string): Promise<PermissionDecision> {
  const cancelled = { cancelled: true } as const;
  const call = CallSchema.safeParse(request.toolCall);
  const options = OptionsSchema.safeParse(request.options);
  if (!call.success || !options.success || new Set(options.data.map(option => option.optionId)).size !== options.data.length) return cancelled;
  const once = options.data.find(option => option.kind === "allow_once");
  if (once === undefined) return cancelled;
  try {
    const root = resolve(cwd);
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink()) return cancelled;
    const canonical_root = await realpath(root);
    for (const location of call.data.locations) {
      const path = location.path;
      if (!isAbsolute(path) || path.includes("\0") || path.includes("\\") || path.split("/").some(part => part === "." || part === "..")) return cancelled;
      let file = relative(root, path);
      if (resolveSessionFile(root, file) === null) file = relative(canonical_root, path);
      if (resolveSessionFile(root, file) === null || !policy[call.data.kind].some(scope => file === scope || file.startsWith(scope + "/"))) return cancelled;
      await resolveSafeSessionFile(root, file);
      if (call.data.kind === "read" && await statSessionDocument(root, file) === null) return cancelled;
    }
    return { optionId: once.optionId };
  } catch { return cancelled; }
}
