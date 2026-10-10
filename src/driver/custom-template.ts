/** 自定义 wrapper 使用单次占位替换；不经 shell，不二次展开用户文本。 */
import type { HeadlessCliTemplate } from "./headless.js";

const placeholders = /\{\{([^{}]+)\}\}/g;
export interface CustomReadonlyArgs {
  readonly_args?: readonly string[];
  readonly_resume_args?: readonly string[];
}
export function custom_headless_template(name: string, bin: string, args: readonly string[], resume_args?: readonly string[], mode_args: CustomReadonlyArgs = {}): HeadlessCliTemplate {
  const checked = [...args]; const resume = resume_args === undefined ? undefined : [...resume_args];
  const readonly_args = mode_args.readonly_args === undefined ? undefined : [...mode_args.readonly_args];
  const readonly_resume_args = mode_args.readonly_resume_args === undefined ? undefined : [...mode_args.readonly_resume_args];
  if (readonly_resume_args !== undefined && (readonly_args === undefined || resume === undefined)) throw new Error("readonly_resume_args 必须同时声明readonly_args与resume_args");
  const branches = [checked, ...[resume, readonly_args, readonly_resume_args].filter((value): value is string[] => value !== undefined)];
  for (const list of branches) {
    for (const arg of list) for (const match of arg.matchAll(placeholders)) {
      if (!["prompt", "model", "effort", "resume_session_id", "readonly"].includes(match[1]!)) throw new Error("自定义 argv 含未知占位符");
    }
  }
  const uses = (branch: readonly string[], key: string) => branch.some(arg => arg.includes(`{{${key}}}`));
  for (const branch of [checked, ...(readonly_args === undefined ? [] : [readonly_args])]) {
    if (uses(branch, "resume_session_id")) throw new Error("session resume 占位符只能出现在resume_args/readonly_resume_args");
  }
  for (const branch of [resume, readonly_resume_args]) {
    if (branch !== undefined && !uses(branch, "resume_session_id")) throw new Error("resume_args/readonly_resume_args必须显式绑定resume_session_id");
  }
  const knobs = (["model", "effort"] as const).filter(key => uses(checked, key));
  for (const branch of branches.slice(1)) {
    if ((["model", "effort"] as const).some(key => uses(branch, key) !== knobs.includes(key))) throw new Error("自定义完整分支的模型/effort映射必须与args一致");
    if (uses(checked, "prompt") && !uses(branch, "prompt")) throw new Error("自定义完整分支缺少prompt映射");
  }
  const supports_readonly_resume = resume !== undefined && (readonly_args === undefined ? uses(resume, "readonly") : readonly_resume_args !== undefined);
  return { name, bin, knobs, supports_resume: resume !== undefined, supports_readonly: readonly_args !== undefined || uses(checked, "readonly"), supports_readonly_resume,
    args: input => {
      const branch = input.resume_session_id === undefined ? input.readonly && readonly_args !== undefined ? readonly_args : checked
        : input.readonly ? readonly_resume_args ?? (supports_readonly_resume ? resume : undefined) : resume;
      if (branch === undefined) throw new Error("自定义wrapper缺少当前模式的原生恢复映射");
      return branch.map(arg => arg.replace(placeholders, (_match, key: string) => {
        const value = key === "readonly" ? String(input.readonly) : key === "prompt" ? input.prompt : key === "resume_session_id" ? input.resume_session_id : key === "model" ? input.model : input.effort;
        if (value === undefined) throw new Error(`自定义 argv 缺少启动值：${key}`);
        return value;
      }));
    },
  };
}
