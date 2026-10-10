/** 独立协调工作台：只消费 server 的轮次、新鲜度与采用投影。 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { Bot, Check, ChevronRight, Play, RefreshCw, RotateCcw, Square, Undo2 } from "lucide-react";
import type { AgentCatalogView, CoordinationRoundView, GoalUsageView, SdlcSummary } from "@agent-cord/server/contracts";
import { api } from "../api.js";
import { describeError, Empty, ErrorBanner, formatTime, NoticeBanner } from "../ui.js";

const STATUS_TEXT: Record<CoordinationRoundView["status"], string> = {
  pending: "待派发", running: "协调中", ok: "已生成", failed: "失败", timeout: "超时", cancelled: "已取消", stale: "输入已变化",
};
const ACTION_TEXT = { advance: "推进流程", ask_human: "人工澄清", wait: "等待", complete: "完成" } as const;
const FAILURE_TEXT: Record<string, string> = { snapshot: "需求读取", configuration: "Agent 配置", driver: "Agent 运行", output: "结果校验", freshness: "输入核验", interrupted: "运行中断" };
const USAGE_STATUS = { not_started: "尚未计量", observed: "计量有效", unknown: "计量未知", exceeded: "已超限", invalid: "来源无效" } as const;

function GoalUsagePanel({ goals, error, onSource }: { goals: GoalUsageView[] | null; error: string | null; onSource: (source: "goal", id: string) => void }): ReactElement {
  return <section className="goal-usage-section" aria-labelledby="goal-usage-title">
    <header><h3 id="goal-usage-title">资源预算</h3><span className="muted small">当前 run</span></header>
    {error !== null ? <p className="coordination-warn" role="status">{error}</p> : goals === null ? <p className="muted" role="status">正在读取资源预算...</p>
      : goals.length === 0 ? <Empty text="当前流程未声明 usage 预算" /> : goals.map(goal => {
        const usage = goal.usage_totals;
        const rows = [
          { label: "输入 token", value: usage?.input_tokens, limit: goal.usage_budget.max_input_tokens, unknown: usage?.unknown_input_tasks },
          { label: "输出 token", value: usage?.output_tokens, limit: goal.usage_budget.max_output_tokens, unknown: usage?.unknown_output_tasks },
          { label: "费用 USD", value: usage?.cost_usd, limit: goal.usage_budget.max_cost_usd, unknown: usage?.unknown_cost_tasks },
        ];
        const number = (value: number | null | undefined) => value == null ? "未报告" : value.toLocaleString("en-US", { maximumFractionDigits: 12 });
        return <div key={goal.node_id} className="goal-usage-item">
          <div className="goal-usage-head"><strong className="mono">{goal.node_id}</strong><span className={`badge goal-usage-${goal.status}`}>{USAGE_STATUS[goal.status]}</span>
            {goal.event_id !== null ? <button type="button" className="link" aria-label={`打开 ${goal.node_id} 资源来源`} title="打开资源来源" onClick={() => onSource("goal", goal.event_id!)}><ChevronRight size={16} aria-hidden="true" /></button> : null}
          </div>
          {goal.run_id !== null ? <p className="muted small mono">run {goal.run_id}</p> : null}
          <table className="goal-usage-table"><thead><tr><th>指标</th><th>已观测</th><th>上限</th><th>未知任务</th></tr></thead><tbody>{rows.map(row =>
            <tr key={row.label}><th scope="row">{row.label}</th><td>{number(row.value)}</td><td>{row.limit === undefined ? "未限制" : number(row.limit)}</td><td>{row.unknown ?? "未核验"}</td></tr>)}</tbody></table>
          {goal.reason !== null ? <p className="coordination-warn small">{goal.reason}</p> : null}
        </div>;
      })}
  </section>;
}

interface Props {
  req_id: string;
  default_sdlc: string;
  event_seq: number;
  run_in_flight: boolean;
  onChanged: () => Promise<void>;
  onSource: (source: "document" | "ledger" | "workflow" | "verification" | "agent_task" | "goal" | "clarification", id: string) => void;
  onRun: () => void;
}

function ToolButton({ label, children, disabled, onClick }: { label: string; children: ReactNode; disabled: boolean; onClick: () => void }): ReactElement {
  const id = useId();
  return <span className="agent-tool"><button type="button" className="btn agent-icon-button" aria-label={label} aria-describedby={id} disabled={disabled} onClick={onClick}>{children}</button><span id={id} className="agent-tooltip" role="tooltip">{label}</span></span>;
}

function RoundBadge({ status }: { status: CoordinationRoundView["status"] }): ReactElement {
  return <span className={`badge coordination-status coordination-status-${status}`}>{STATUS_TEXT[status]}</span>;
}

export function CoordinationPanel({ req_id, default_sdlc, event_seq, run_in_flight, onChanged, onSource, onRun }: Props): ReactElement {
  const [catalog, set_catalog] = useState<AgentCatalogView | null>(null);
  const [sdlcs, set_sdlcs] = useState<SdlcSummary[]>([]);
  const [rounds, set_rounds] = useState<CoordinationRoundView[] | null>(null);
  const [goal_usage, set_goal_usage] = useState<GoalUsageView[] | null>(null);
  const [usage_error, set_usage_error] = useState<string | null>(null);
  const [selected_agent, set_selected_agent] = useState("");
  const [selected_sdlc, set_selected_sdlc] = useState(default_sdlc);
  const [timeout_seconds, set_timeout_seconds] = useState("120");
  const [selected_round, set_selected_round] = useState<string | null>(null);
  const [loading, set_loading] = useState(true);
  const [command, set_command] = useState<"start" | "cancel" | "adopt" | "answer" | "revoke" | "retry" | "retry_coordination" | null>(null);
  const [answer_choice, set_answer_choice] = useState("");
  const [load_error, set_load_error] = useState<string | null>(null);
  const [command_error, set_command_error] = useState<string | null>(null);
  const [notice, set_notice] = useState<string | null>(null);
  const mounted = useRef(false);
  const generation = useRef(0);
  const round_request = useRef(0);
  const round_loading = useRef(false);
  const command_loading = useRef(false);
  const default_sdlc_ref = useRef(default_sdlc);
  default_sdlc_ref.current = default_sdlc;

  const apply_rounds = useCallback((next: CoordinationRoundView[]) => {
    set_rounds(next);
    set_selected_round((previous) => next.some((round) => round.round_id === previous) ? previous : next[0]?.round_id ?? null);
  }, []);

  const load_rounds = useCallback(async (): Promise<void> => {
    if (round_loading.current) return;
    round_loading.current = true;
    const operation = ++round_request.current;
    const epoch = generation.current;
    try {
      const [result, usage] = await Promise.allSettled([api.listCoordination(req_id), api.getGoalUsage(req_id)]);
      if (mounted.current && generation.current === epoch && operation === round_request.current) {
        if (result.status === "fulfilled") apply_rounds(result.value.rounds); else set_load_error(describeError(result.reason));
        if (usage.status === "fulfilled") { set_goal_usage(usage.value.goals); set_usage_error(null); }
        else { set_goal_usage(null); set_usage_error(describeError(usage.reason)); }
      }
    } catch (cause) {
      if (mounted.current && generation.current === epoch) set_load_error(describeError(cause));
    } finally { if (generation.current === epoch) round_loading.current = false; }
  }, [req_id, apply_rounds]);

  const load_all = useCallback(async (): Promise<void> => {
    const epoch = generation.current;
    const operation = ++round_request.current;
    set_loading(true);
    const results = await Promise.allSettled([api.listAgents(), api.listSdlcs(), api.listCoordination(req_id), api.getGoalUsage(req_id)]);
    if (!mounted.current || generation.current !== epoch) return;
    const [agents_result, sdlcs_result, rounds_result, usage_result] = results;
    const errors: string[] = [];
    if (agents_result.status === "fulfilled") {
      set_catalog(agents_result.value);
      set_selected_agent((previous) => agents_result.value.agents.some((agent) => agent.name === previous) ? previous :
        agents_result.value.agents.find((agent) => agent.source === "workspace")?.name ?? agents_result.value.agents[0]?.name ?? "");
    } else errors.push(describeError(agents_result.reason));
    if (sdlcs_result.status === "fulfilled") {
      set_sdlcs(sdlcs_result.value.sdlcs);
      set_selected_sdlc((previous) => {
        const available = sdlcs_result.value.sdlcs.flatMap((sdlc) => sdlc.versions.filter((version) => version.status === "published").map((version) => `${sdlc.sdlc_id}@${version.version}`));
        return available.includes(previous) ? previous : available.includes(default_sdlc_ref.current) ? default_sdlc_ref.current :
          available.filter((value) => value.startsWith("simple-sdlc@")).at(-1) ?? available[0] ?? "";
      });
    } else errors.push(describeError(sdlcs_result.reason));
    if (rounds_result.status === "fulfilled") { if (operation === round_request.current) apply_rounds(rounds_result.value.rounds); }
    else errors.push(describeError(rounds_result.reason));
    if (operation === round_request.current) {
      if (usage_result.status === "fulfilled") { set_goal_usage(usage_result.value.goals); set_usage_error(null); }
      else { set_goal_usage(null); set_usage_error(describeError(usage_result.reason)); }
    }
    set_load_error(errors.length > 0 ? errors.join("\n") : null);
    set_loading(false);
  }, [req_id, apply_rounds]);

  useEffect(() => {
    mounted.current = true;
    generation.current += 1;
    set_goal_usage(null); set_usage_error(null);
    void load_all();
    return () => { mounted.current = false; generation.current += 1; round_loading.current = false; };
  }, [load_all]);
  useEffect(() => { if (rounds !== null) void load_rounds(); }, [event_seq, load_rounds]);
  useEffect(() => {
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load_rounds(); }, 2_000);
    const on_visible = () => { if (document.visibilityState === "visible") void load_rounds(); };
    document.addEventListener("visibilitychange", on_visible);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", on_visible); };
  }, [load_rounds]);

  const selected = rounds?.find((round) => round.round_id === selected_round) ?? rounds?.[0] ?? null;
  useEffect(() => { set_answer_choice(""); }, [selected?.round_id]);
  const pending = rounds?.find((round) => round.status === "pending" || round.status === "running");
  const seconds = Number(timeout_seconds);
  const busy = command !== null;
  const can_start = !loading && !busy && pending === undefined && selected_agent !== "" && selected_sdlc !== "" && Number.isInteger(seconds) && seconds >= 1 && seconds <= 600;

  const perform = async (kind: "start" | "cancel" | "adopt" | "answer" | "revoke" | "retry" | "retry_coordination"): Promise<void> => {
    if (command_loading.current) return;
    command_loading.current = true;
    set_command(kind);
    set_command_error(null);
    set_notice(null);
    const epoch = generation.current;
    try {
      if (kind === "start") {
        const [sdlc_id, version] = selected_sdlc.split("@");
        const result = await api.startCoordination(req_id, { agent: selected_agent, sdlc_id, sdlc_version: Number(version), timeout_ms: seconds * 1_000 });
        if (!mounted.current || generation.current !== epoch) return;
        set_rounds((previous) => [result.round, ...(previous ?? []).filter((round) => round.round_id !== result.round.round_id)]);
        set_selected_round(result.round.round_id);
        set_notice("协调已发起");
      } else if (selected !== null) {
        if (kind === "cancel") {
          await api.cancelCoordination(req_id, selected.round_id);
          if (mounted.current && generation.current === epoch) set_notice("协调已取消");
        } else if (kind === "answer") {
          await api.answerCoordination(req_id, selected.round_id, { choice: answer_choice });
          if (mounted.current && generation.current === epoch) set_notice("答复已记录");
        } else if (kind === "revoke" && selected.answer != null) {
          await api.revokeCoordinationAnswer(req_id, selected.round_id, { answer_event_id: selected.answer.event_id });
          if (mounted.current && generation.current === epoch) set_notice("答复已撤回");
        } else if (kind === "retry_coordination") {
          if (selected.coordination_retry?.available !== true || selected.coordination_retry.input_hash === null) return;
          const result = await api.retryCoordination(req_id, selected.round_id, selected.coordination_retry.input_hash);
          if (mounted.current && generation.current === epoch) {
            set_selected_round(result.round.round_id); set_notice("协调已重试");
          }
        } else if (kind === "retry") {
          if (selected.answer == null || selected.goal_retry?.available !== true || selected.goal_retry.input_hash == null) return;
          const result = await api.retryGoal(req_id, selected.round_id, { answer_event_id: selected.answer.event_id, input_hash: selected.goal_retry.input_hash });
          if (mounted.current && generation.current === epoch) set_notice(`Goal 已重新执行，run ${result.run.run_id}`);
        } else {
          const result = await api.adoptCoordination(req_id, selected.round_id);
          if (mounted.current && generation.current === epoch) set_notice(`已采用提议，SDLC run ${result.run.run_id} 已启动`);
        }
      }
      if (mounted.current && generation.current === epoch) { await load_rounds(); await onChanged(); }
    } catch (cause) {
      if (mounted.current && generation.current === epoch) { set_command_error(describeError(cause)); await load_rounds(); }
    } finally {
      command_loading.current = false;
      if (mounted.current && generation.current === epoch) set_command(null);
    }
  };

  return <div className="coordination-workspace">
    <header className="coordination-head"><h2><Bot size={19} aria-hidden="true" />协调</h2><ToolButton label="刷新协调" disabled={loading || busy} onClick={() => void load_all()}><RefreshCw size={18} className={loading ? "agent-spinning" : undefined} aria-hidden="true" /></ToolButton></header>
    <ErrorBanner message={load_error} onClose={() => set_load_error(null)} />
    <ErrorBanner message={command_error} onClose={() => set_command_error(null)} />
    <NoticeBanner message={notice} />
    <form className="coordination-controls" onSubmit={(event) => { event.preventDefault(); if (can_start) void perform("start"); }}>
      <div className="field coordination-agent-field"><label htmlFor="coordination-agent">协调 Agent</label><select id="coordination-agent" className="select" value={selected_agent} disabled={loading || busy} onChange={(event) => set_selected_agent(event.target.value)}>
        {catalog === null || catalog.agents.length === 0 ? <option value="">{loading ? "加载中..." : "没有可用 Agent"}</option> : null}
        {catalog?.agents.map((agent) => <option key={agent.name} value={agent.name}>{agent.name} · {agent.kind === "acp" ? "ACP" : "Headless"}</option>)}
      </select></div>
      <div className="field coordination-sdlc-field"><label htmlFor="coordination-sdlc">SDLC 版本</label><select id="coordination-sdlc" className="select" value={selected_sdlc} disabled={loading || busy} onChange={(event) => set_selected_sdlc(event.target.value)}>
        {selected_sdlc === "" ? <option value="">没有可用版本</option> : null}
        {sdlcs.flatMap((sdlc) => sdlc.versions.filter((version) => version.status === "published").map((version) => <option key={`${sdlc.sdlc_id}@${version.version}`} value={`${sdlc.sdlc_id}@${version.version}`}>{sdlc.name} v{version.version}</option>))}
      </select></div>
      <div className="field coordination-timeout-field"><label htmlFor="coordination-timeout">超时（秒）</label><input id="coordination-timeout" type="number" min="1" max="600" step="1" required value={timeout_seconds} disabled={busy} onChange={(event) => set_timeout_seconds(event.target.value)} /></div>
      <button type="submit" className="btn btn-primary coordination-start" disabled={!can_start}><Bot size={16} aria-hidden="true" />{command === "start" ? "发起中..." : pending !== undefined ? "协调进行中" : "发起协调"}</button>
    </form>

    <GoalUsagePanel goals={goal_usage} error={usage_error} onSource={onSource} />
    <div className="coordination-layout" aria-busy={loading && rounds === null}>
      <section className="coordination-history" aria-labelledby="coordination-history-title"><header><h3 id="coordination-history-title">轮次</h3><span className="muted small">{rounds?.length ?? 0}</span></header>
        {rounds === null ? <div className="coordination-loading" role="status">正在读取协调轮次...</div> : rounds.length === 0 ? <Empty text="还没有协调轮次" /> : <ul>{rounds.map((round) => <li key={round.round_id}><button type="button" className={round.round_id === selected?.round_id ? "coordination-round coordination-round-selected" : "coordination-round"} aria-pressed={round.round_id === selected?.round_id} onClick={() => set_selected_round(round.round_id)}>
          <span className="coordination-round-top"><RoundBadge status={round.status} />{round.answer != null ? <span className={round.answer.revoked_at ? "small muted" : "small ok-text"}>{round.answer.revoked_at ? "已撤回" : "已答复"}</span> : round.adopted_run_id !== null ? <span className="small ok-text">已采用</span> : round.current === false ? <span className="small coordination-warn">依据已变化</span> : null}</span>
          <strong>{round.proposal?.summary ?? round.agent}</strong><span className="muted small">{round.sdlc_id} v{round.sdlc_version} · {formatTime(round.requested_at)}</span>
        </button></li>)}</ul>}
      </section>
      <section className="coordination-detail" aria-labelledby="coordination-detail-title">
        <header className="coordination-detail-head"><h3 id="coordination-detail-title">{selected?.proposal !== null && selected?.proposal !== undefined ? "协调提议" : "轮次详情"}</h3><div>{selected !== null ? <><RoundBadge status={selected.status} />{selected.proposal !== null ? <span className="pill">Draft</span> : null}</> : null}</div></header>
        {selected === null ? <Empty text={rounds === null ? "加载中..." : "暂无提议"} /> : <>
          <dl className="coordination-context"><div><dt>Agent</dt><dd className="mono">{selected.agent}</dd></div><div><dt>SDLC</dt><dd>{selected.sdlc_id} v{selected.sdlc_version}</dd></div><div><dt>当前依据</dt><dd className={selected.current === false ? "coordination-warn" : selected.current === true ? "ok-text" : "muted"}>{selected.current === true ? "与当前输入一致" : selected.current === false ? "已变化" : "未验证"}</dd></div></dl>
          {selected.trigger === "goal_blocked" && selected.goal_event_id !== undefined ? <div className="coordination-evidence"><h4>Goal 自动升级</h4><button type="button" className="link mono" aria-label="打开 Goal 阻塞事件" title="打开 Goal 阻塞事件" onClick={() => onSource("goal", selected.goal_event_id!)}><span>{selected.node_id}</span><ChevronRight size={14} aria-hidden="true" /></button></div> : null}
          {selected.retry_of_round_id !== undefined ? <div className="coordination-evidence"><h4>重试来源</h4><button type="button" className="link mono" onClick={() => set_selected_round(selected.retry_of_round_id!)}><span>{selected.retry_of_round_id}</span><ChevronRight size={14} aria-hidden="true" /></button></div> : null}
          {selected.error !== null ? <div className="coordination-failure" role="status"><strong>{FAILURE_TEXT[selected.failure_stage ?? ""] ?? STATUS_TEXT[selected.status]}</strong><p>{selected.error}</p></div> : null}
          {selected.proposal !== null ? <div className="coordination-proposal"><p className="coordination-summary">{selected.proposal.summary}</p>
            <div className="coordination-action-title"><span className="pill">{ACTION_TEXT[selected.proposal.next_action.kind]}</span>{selected.proposal.next_action.kind === "advance" ? <strong className="mono">{selected.proposal.next_action.node_id}</strong> : null}</div>
            <p className="coordination-reason">{selected.proposal.next_action.reason}</p>
            {selected.proposal.next_action.kind === "ask_human" ? <div className="coordination-question"><h4>{selected.proposal.next_action.question}</h4>
              {selected.answer != null ? <div className={selected.answer.revoked_at ? "coordination-answer-receipt coordination-answer-revoked" : "coordination-answer-receipt"}>
                <div className="coordination-answer-receipt-head"><span className={selected.answer.revoked_at ? "muted" : "ok-text"}>{selected.answer.revoked_at ? <Undo2 size={16} aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}{selected.answer.revoked_at ? "已撤回" : "已答复"}</span>
                  {selected.answer.revoked_at === undefined ? <ToolButton label={command === "revoke" ? "撤回中..." : "撤回答复"} disabled={loading || busy || selected.answer_revocable !== true} onClick={() => void perform("revoke")}><Undo2 size={16} aria-hidden="true" /></ToolButton> : null}
                </div><strong>{selected.answer.choice}</strong><span className="muted small">{formatTime(selected.answer.answered_at)}</span>
                <button type="button" className="link mono" onClick={() => onSource("clarification", selected.answer!.event_id)} title="打开澄清答复事件"><span>{selected.answer.event_id}</span><ChevronRight size={14} aria-hidden="true" /></button>
                {selected.answer.revoked_at !== undefined && selected.answer.revocation_event_id !== undefined ? <div className="coordination-revocation-record"><span className="muted small">{formatTime(selected.answer.revoked_at)}</span><button type="button" className="link mono" onClick={() => onSource("clarification", selected.answer!.revocation_event_id!)} title="打开撤回事件"><span>{selected.answer.revocation_event_id}</span><ChevronRight size={14} aria-hidden="true" /></button></div> : null}
              </div> : <form className="coordination-answer-form" onSubmit={(event) => { event.preventDefault(); if (!loading && !busy && selected.answerable === true && answer_choice !== "") void perform("answer"); }}>
                <fieldset className="coordination-answer-options" role="radiogroup" aria-label="澄清选项" disabled={loading || busy || selected.answerable !== true}>
                  {selected.proposal.next_action.options.map((option) => <label key={option}><input type="radio" name={`answer-${selected.round_id}`} value={option} checked={answer_choice === option} onChange={() => set_answer_choice(option)} /><span>{option}</span></label>)}
                </fieldset>
                <div className="coordination-answer-actions"><button type="submit" className="btn btn-primary" disabled={loading || busy || selected.answerable !== true || answer_choice === ""}><Check size={16} aria-hidden="true" />{command === "answer" ? "记录中..." : "记录答复"}</button>
                  {selected.answerable !== true ? <span className="muted small">{selected.answer_reason ?? "当前问题不可答复，请重新协调"}</span> : null}
                </div>
              </form>}
            </div> : null}
            <div className="coordination-evidence"><h4>来源</h4><ul>{selected.proposal.next_action.evidence.map((evidence, index) => <li key={`${evidence.source}:${evidence.id}:${index}`}><span className="muted small">{evidence.source === "document" ? "文档" : evidence.source === "ledger" ? "共识" : evidence.source === "verification" ? "验证" : evidence.source === "agent_task" ? "任务" : evidence.source === "goal" ? "Goal" : evidence.source === "clarification" ? "澄清" : "节点"}</span>
              {evidence.source !== "document" || ["prd.md", "plan.md", "adr.md", "findings.md"].includes(evidence.id) ? <button type="button" className="link mono" onClick={() => onSource(evidence.source, evidence.id)}><span>{evidence.id}</span><ChevronRight size={14} aria-hidden="true" /></button> : <code className="mono">{evidence.id}</code>}
            </li>)}</ul></div>
            {selected.proposal.risks.length > 0 ? <div className="coordination-risks"><h4>风险</h4><ul>{selected.proposal.risks.map((risk, index) => <li key={index}>{risk}</li>)}</ul></div> : null}
          </div> : null}
          <details className="coordination-record"><summary>记录信息</summary><dl className="coordination-context"><div><dt>轮次</dt><dd className="mono">{selected.round_id}</dd></div><div><dt>需求基线</dt><dd className="mono">{selected.input_hash ?? "未生成"}</dd></div><div><dt>Agent 版本</dt><dd className="mono">{selected.agent_configuration_hash ?? "未提供"}</dd></div><div><dt>完成时间</dt><dd>{formatTime(selected.finished_at)}</dd></div></dl></details>
          <footer className="coordination-footer">
            {selected.coordination_retry?.available === true ? <button type="button" className="btn btn-plain coordination-retry" disabled={loading || busy || pending !== undefined} onClick={() => void perform("retry_coordination")}><RotateCcw size={16} aria-hidden="true" />{command === "retry_coordination" ? "重试中..." : "重试协调"}</button> : selected.coordination_retry?.child_round_id != null ? <button type="button" className="link mono" onClick={() => set_selected_round(selected.coordination_retry!.child_round_id!)}><span>查看重试轮次</span><ChevronRight size={14} aria-hidden="true" /></button> : selected.coordination_retry?.reason != null && ["failed", "timeout", "cancelled", "stale"].includes(selected.status) ? <span className="muted small">{selected.coordination_retry.reason}</span> : null}
            {selected.goal_retry?.run_id != null ? <div className="coordination-adopted"><span className="ok-text">Goal 已重新执行</span><button type="button" className="link mono" onClick={onRun}><span>run {selected.goal_retry.run_id}</span><ChevronRight size={14} aria-hidden="true" /></button></div>
              : selected.trigger === "goal_blocked" && selected.answer != null ? <div><div className="coordination-answer-actions">
                <button type="button" className="btn btn-primary" disabled={loading || busy || run_in_flight || selected.goal_retry?.available !== true} onClick={() => void perform("retry")}><Play size={16} aria-hidden="true" />{command === "retry" ? "启动中..." : "重新执行 Goal"}</button>
                {selected.goal_retry?.max_attempts != null && selected.goal_retry.timeout_ms != null ? <span className="muted small">新预算：{selected.goal_retry.max_attempts} 次 / {selected.goal_retry.timeout_ms % 60000 === 0 ? `${selected.goal_retry.timeout_ms / 60000} 分钟` : `${selected.goal_retry.timeout_ms / 1000} 秒`}</span> : null}
                {selected.goal_retry?.available !== true ? <span className="muted small">{selected.goal_retry?.reason ?? "当前无法重新执行"}</span> : null}
              </div></div> : null}
            {selected.status === "pending" || selected.status === "running" ? <ToolButton label="取消协调" disabled={busy} onClick={() => void perform("cancel")}><Square size={16} aria-hidden="true" /></ToolButton> : null}
            {selected.adopted_run_id !== null ? <div className="coordination-adopted"><span className="ok-text">已采用 · {formatTime(selected.adopted_at)}</span><button type="button" className="link mono" onClick={onRun}><span>run {selected.adopted_run_id}</span><ChevronRight size={14} aria-hidden="true" /></button></div> : selected.proposal?.next_action.kind === "advance" ? <>
              <button type="button" className="btn btn-primary coordination-adopt" disabled={busy || run_in_flight || !selected.adoptable} onClick={() => void perform("adopt")}><Play size={16} aria-hidden="true" />{command === "adopt" ? "采用中..." : "采用并启动 SDLC"}</button>
              {run_in_flight ? <span className="muted small">已有运行中的 SDLC</span> : !selected.adoptable && selected.adoption_reason !== null ? <span className="coordination-warn small">{selected.adoption_reason}</span> : null}
            </> : null}
          </footer>
        </>}
      </section>
    </div>
  </div>;
}
