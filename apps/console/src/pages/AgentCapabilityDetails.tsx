import { useId } from "react";
import type { ReactElement } from "react";
import { ScanSearch } from "lucide-react";
import type { AgentCatalogView, AgentInspectionView } from "@agent-cord/server/contracts";
import { launch_option_text } from "../agent-capabilities.js";
import { ErrorBanner } from "../ui.js";
import { CliCapabilityObservation } from "./CliCapabilityObservation.js";

const RESUME_TEXT = { supported: "支持", unsupported: "不支持", negotiated: "需协议协商" } as const;
interface Props {
  id: string;
  agent: AgentCatalogView["agents"][number];
  inspection?: AgentInspectionView;
  current: boolean;
  catalog_verified: boolean;
  inspecting: boolean;
  disabled: boolean;
  error: string | null;
  onInspect(): void;
}

export function AgentCapabilityDetails({ id, agent, inspection, current, catalog_verified, inspecting, disabled, error, onInspect }: Props): ReactElement {
  const tip_id = useId(); const capabilities = agent.capabilities; const observation = agent.kind === "acp" ? inspection?.observation : null;
  const result_state = current ? "当前配置" : inspection?.current === false ? "旧配置结果"
    : !catalog_verified ? "清单未核验" : inspection?.current !== true ? "新鲜度未核验" : "旧配置结果";
  const cli_query = agent.kind === "headless" && capabilities?.inspection === "cli_help";
  const query_name = cli_query ? "CLI 能力" : "协议能力";
  const query_label = cli_query ? "查询 CLI 能力" : "查询协议能力";
  return <section id={id} className="agent-capability-detail" aria-label={`${agent.name} 能力详情`}>
    <header className="agent-detail-head"><h3>能力声明</h3><span className="muted small">适配器声明</span></header>
    {capabilities === undefined ? <p className="muted small">未提供能力声明</p> : <>
      <dl className="agent-capability-facts">
        <div><dt>原生会话恢复</dt><dd>{RESUME_TEXT[capabilities.native_resume]}</dd></div>
        <div><dt>Goal</dt><dd>宿主交付</dd></div>
        <div><dt>流程节点恢复</dt><dd>原授权未退出节点</dd></div>
        <div><dt>安装状态</dt><dd>未核验</dd></div>
      </dl>
      <h4>启动选项</h4>
      {capabilities.launch_options.length === 0 ? <p className="muted small">未声明启动选项</p> : <ul className="agent-launch-options">
        {capabilities.launch_options.map(option => <li key={option}><code>{option}</code><span>{launch_option_text(option)}</span></li>)}
      </ul>}
    </>}

    {agent.kind === "acp" || cli_query ? <div className="agent-protocol-observation">
      <header className="agent-detail-head"><h3>{cli_query ? "CLI 查询" : "协议查询"}</h3>
        <span className="agent-tool"><button type="button" className="btn agent-icon-button" aria-label={`${query_label} ${agent.name}`} aria-describedby={tip_id} disabled={disabled} onClick={onInspect}>
          <ScanSearch size={18} className={inspecting ? "agent-spinning" : undefined} aria-hidden="true" />
        </button><span id={tip_id} role="tooltip" className="agent-tooltip">{query_label}</span></span>
      </header>
      <ErrorBanner message={error} />
      {inspecting ? <p role="status" className="muted small">正在查询{query_name}...</p> : null}
      {cli_query && inspection?.cli_observation != null ? <CliCapabilityObservation inspection={inspection} current={current} result_state={result_state} historical={error !== null || inspecting} /> : null}
      {observation == null ? (!inspecting && error === null && inspection?.cli_observation == null ? <p className="muted small">尚未查询</p> : null) : <div className="agent-observation-result">
        <div className={`agent-result-state ${current ? "agent-result-current" : "agent-result-stale"}`} role="status">
          <strong>{error !== null || inspecting ? "上次查询" : "协议已协商"}</strong><span>{result_state}</span>
          <code title={inspection?.configuration_hash ?? "未提供"}>{inspection?.configuration_hash?.slice(0, 12) ?? "未提供"}</code>
          <span>配置版本 {inspection?.revision}</span>
        </div>
        <dl className="agent-capability-facts">
          <div><dt>ACP 版本</dt><dd>{observation.protocol_version}</dd></div>
          <div><dt>原生会话恢复</dt><dd>{observation.native_resume ? "支持" : "不支持"}</dd></div>
          <div><dt>模型访问</dt><dd>未核验</dd></div>
        </dl>
        <h4>协议模式</h4><p className="agent-mode-values mono">{observation.modes.length === 0 ? "未声明" : observation.modes.join(" / ")}</p>
        {observation.omitted_modes > 0 ? <p className="muted small">另有 {observation.omitted_modes} 个模式未展示</p> : null}
        <h4>配置选项</h4>
        {observation.config_options.length === 0 ? <p className="muted small">未声明配置选项</p> : <div className="agent-config-options">
          <table><thead><tr><th scope="col">选项 ID</th><th scope="col">类型</th><th scope="col">类别</th><th scope="col">候选值</th></tr></thead><tbody>
            {observation.config_options.map(option => <tr key={option.id}><td><code>{option.id}</code></td><td>{option.type === "boolean" ? "开关" : "选择"}</td><td data-label="类别"><code>{option.category ?? "未声明"}</code></td>
              <td data-label="候选值">{option.type === "boolean" ? "开 / 关" : option.values === undefined ? "未公开" : option.values.length === 0 ? "未展示" : <code>{option.values.join(" / ")}</code>}
                {(option.omitted_values ?? 0) > 0 ? <span className="agent-omitted-values muted small">另有 {option.omitted_values} 项未展示</span> : null}</td></tr>)}
          </tbody></table>
        </div>}
        {observation.omitted_options > 0 ? <p className="muted small">另有 {observation.omitted_options} 个配置选项未展示</p> : null}
      </div>}
    </div> : null}
  </section>;
}
