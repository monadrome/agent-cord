import type { ReactElement } from "react";
import type { AgentInspectionView } from "@agent-cord/server/contracts";
import { launch_option_text } from "../agent-capabilities.js";

const STATUS_TEXT = { passed: "帮助已读取", unavailable: "CLI 不可用", timeout: "查询超时", failed: "查询失败", unrecognized: "输出无法识别", cancelled: "查询已取消" } as const;
const CHECK_TEXT = { version: "版本", task_help: "任务帮助", resume_help: "恢复帮助" } as const;
interface Props {
  inspection: AgentInspectionView;
  current: boolean;
  result_state: string;
  historical: boolean;
}
export function CliCapabilityObservation({ inspection, current, result_state, historical }: Props): ReactElement | null {
  const observed = inspection.cli_observation;
  if (observed == null) return null;
  return <div className="agent-observation-result">
    <div className={`agent-result-state ${current && observed.status === "passed" ? "agent-result-current" : "agent-result-stale"}`} role="status">
      <strong>{historical ? "上次查询" : STATUS_TEXT[observed.status]}</strong>{historical ? <span>{STATUS_TEXT[observed.status]}</span> : null}<span>{result_state}</span><code title={inspection.configuration_hash ?? "未提供"}>{inspection.configuration_hash?.slice(0, 12) ?? "未提供"}</code><span>配置版本 {inspection.revision}</span>
    </div>
    <dl className="agent-capability-facts">
      <div><dt>CLI</dt><dd>{observed.profile}</dd></div><div><dt>版本</dt><dd><code>{observed.version ?? "未核验"}</code></dd></div>
      <div><dt>模型访问</dt><dd>未核验</dd></div><div><dt>原生恢复入口</dt><dd>{observed.native_resume === "advertised" ? "帮助已展示" : observed.native_resume === "unadvertised" ? "帮助未展示" : "未核验"}</dd></div>
    </dl>
    <h4>查询步骤</h4><ul className="agent-launch-options">{observed.checks.map(check => <li key={check.id}><span>{CHECK_TEXT[check.id]}</span><span>{check.status === "passed" ? "已读取" : STATUS_TEXT[check.status]}</span></li>)}</ul>
    <h4>启动选项</h4><div className="agent-config-options"><table><thead><tr><th scope="col">选项</th><th scope="col">配置</th><th scope="col">帮助证据</th></tr></thead><tbody>
      {observed.launch_options.map(option => <tr key={option.id}><td><code>{option.id}</code></td><td>{option.configured ? "已配置" : "未配置"}</td><td data-label="帮助证据">
        {option.advertised === true ? "帮助已展示" : option.advertised === false ? "帮助未展示" : "未核验"}<span className="agent-omitted-values muted small">{launch_option_text(option.id)}</span>
      </td></tr>)}
    </tbody></table></div>
    {observed.help_hash !== null ? <p className="agent-help-hash muted small">帮助指纹 <code title={observed.help_hash}>{observed.help_hash.slice(0, 12)}</code></p> : null}
  </div>;
}
