/** 自定义 wrapper 使用单次占位替换；不经 shell，不二次展开用户文本。 */
import type { HeadlessCliTemplate } from "./headless.js";

const placeholders = /\{\{([^{}]+)\}\}/g;
export function custom_headless_template(name: string, bin: string, args: readonly string[], resume_args?: readonly string[]): HeadlessCliTemplate {
  const checked = [...args]; const resume = resume_args === undefined ? undefined : [...resume_args];
  for (const list of [checked, ...(resume === undefined ? [] : [resume])]) {
    for (const arg of list) for (const match of arg.matchAll(placeholders)) {
      if (!["prompt", "model", "effort", "resume_session_id"].includes(match[1]!)) throw new Error("自定义 argv 含未知占位符");
    }
  }
  if (checked.some(arg => arg.includes("{{resume_session_id}}"))) throw new Error("session resume 占位符只能出现在 resume_args");
  if (resume !== undefined && !resume.some(arg => arg.includes("{{resume_session_id}}"))) throw new Error("resume_args 必须显式绑定 resume_session_id");
  const knobs = (["model", "effort"] as const).filter(key => checked.some(arg => arg.includes(`{{${key}}}`)));
  if (resume !== undefined && knobs.some(key => !resume.some(arg => arg.includes(`{{${key}}}`)))) throw new Error("resume_args 缺少启动模型/effort 映射");
  if (resume !== undefined && (["model", "effort"] as const).some(key => !knobs.includes(key) && resume.some(arg => arg.includes(`{{${key}}}`)))) throw new Error("resume_args 的模型/effort 映射必须与 args 一致");
  return { name, bin, knobs, supports_resume: resume !== undefined,
    args: input => (input.resume_session_id === undefined ? checked : resume!).map(arg => arg.replace(placeholders, (_match, key: string) => {
      const value = key === "prompt" ? input.prompt : key === "resume_session_id" ? input.resume_session_id : key === "model" ? input.model : input.effort;
      if (value === undefined) throw new Error(`自定义 argv 缺少启动值：${key}`);
      return value;
    })),
  };
}
