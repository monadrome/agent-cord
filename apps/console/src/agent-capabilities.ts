/** 只核对公开配置身份，不从 UI 推断安装、模型可用性或协议能力。 */
import type { AgentCatalogView, AgentInspectionView } from "@agent-cord/server/contracts";

export const LAUNCH_OPTION_TEXT: Readonly<Record<string, string>> = {
  provider: "模型路由", model: "模型", effort: "推理强度", bare: "Bare", auto: "自动审批", mode: "协议模式",
  max_turns: "轮次上限", budget_usd: "费用上限", system_prompt: "系统提示", agent: "角色",
  agents_json: "角色定义", option_ids: "选项映射", config_options: "扩展配置",
};

export function launch_option_text(option: string): string {
  return Object.hasOwn(LAUNCH_OPTION_TEXT, option) ? LAUNCH_OPTION_TEXT[option]! : option;
}

export function inspection_matches_catalog(catalog: AgentCatalogView, name: string, inspection: AgentInspectionView): boolean {
  const agent = catalog.agents.find(entry => entry.name === name);
  return inspection.current === true && inspection.configuration_hash !== null && agent !== undefined
    && catalog.revision === inspection.revision && agent.configuration_hash === inspection.configuration_hash;
}
