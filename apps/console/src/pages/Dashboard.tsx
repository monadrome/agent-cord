/** 工作台（首屏）：需求统计、待审批决策、失败运行；数据全部来自 server 投影，前端只展示与转发命令。 */
import { useCallback, useEffect, useState } from "react";
import type { ReactElement } from "react";
import type { ApprovalItem, RequirementStatus } from "@agent-cord/server/contracts";
import { api } from "../api.js";
import type { DashboardResponse, DoctorResponse, HealthResponse } from "../api.js";
import {
  describeError,
  Empty,
  ErrorBanner,
  formatTime,
  REQUIREMENT_STATUS_TEXT,
  RunBadge,
  Section,
} from "../ui.js";

const POLL_MS = 5_000;
const STATUS_ORDER: readonly RequirementStatus[] = ["idle", "running", "waiting_human", "blocked", "completed"];

export function Dashboard({ onOpenRequirement }: { onOpenRequirement: (reqId: string) => void }): ReactElement {
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [doctor, setDoctor] = useState<DoctorResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deciding, setDeciding] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [dashboard, healthResult] = await Promise.all([api.dashboard(), api.health()]);
      setData(dashboard);
      setHealth(healthResult);
      setError(null);
    } catch (cause) {
      setError(describeError(cause));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const runDoctor = async (): Promise<void> => {
    setBusy(true);
    try {
      setDoctor(await api.doctor());
      setError(null);
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  };

  /** 人工 gate 决策：一次点击一个幂等键（重试同一动作时由 client 复用传入的 key） */
  const decide = async (item: ApprovalItem, choice: string): Promise<void> => {
    setDeciding(item.approval_id);
    try {
      await api.decideApproval(item.req_id, item.approval_id, choice);
      await refresh();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setDeciding(null);
    }
  };

  const byStatus = data?.requirements.by_status;

  return (
    <>
      <header className="page-head">
        <div>
          <p className="eyebrow">工作台</p>
          <h1>需求总览</h1>
          <p className="muted">
            事件流、流程时间线与人工审批的统一视图。
            {health !== null ? ` server ${health.version} · 运行 ${health.uptime_seconds}s · ${health.cord_root}` : ""}
          </p>
        </div>
        <div className="page-actions">
          <button type="button" className="btn" disabled={busy} onClick={() => void runDoctor()}>
            {busy ? "检查中…" : "运行 doctor"}
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void refresh()}>
            刷新
          </button>
        </div>
      </header>

      <ErrorBanner message={error} onClose={() => setError(null)} />

      <div className="metrics">
        <div className="metric metric-total">
          <span>需求总数</span>
          <strong>{data?.requirements.total ?? 0}</strong>
        </div>
        {STATUS_ORDER.map((status) => (
          <div key={status} className={`metric metric-${status}`}>
            <span>{REQUIREMENT_STATUS_TEXT[status]}</span>
            <strong>{byStatus?.[status] ?? 0}</strong>
          </div>
        ))}
      </div>

      {doctor !== null ? (
        <Section
          title="doctor 体检"
          extra={
            <span className={doctor.ok ? "ok-text" : "fail-text"}>
              {doctor.ok ? "全绿" : "存在问题"} · 需求 {doctor.sessions.length} 个
              {doctor.fixed.length > 0 ? ` · 修复 ${doctor.fixed.length} 项` : ""}
            </span>
          }
        >
          <ul className="check-list">
            {doctor.checks.map((check) => (
              <li key={check.name} className={check.ok ? "check-ok" : "check-fail"}>
                <span className="check-mark">{check.ok ? "✓" : "✕"}</span>
                <strong>{check.name}</strong>
                <span className="muted">{check.detail}</span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <Section title="待审批" extra={<span className="muted">{data?.pending_approvals.length ?? 0} 项</span>}>
        {data === null ? (
          <Empty text="加载中…" />
        ) : data.pending_approvals.length === 0 ? (
          <Empty text="没有挂起的人工 gate" />
        ) : (
          <ul className="approval-list">
            {data.pending_approvals.map((item) => (
              <li key={item.approval_id} className="approval-item">
                <div className="approval-head">
                  <button type="button" className="link" onClick={() => onOpenRequirement(item.req_id)}>
                    {item.req_id}
                  </button>
                  <span className="muted">
                    节点 {item.node_id} · gate {item.gate_id} · {item.kind === "human_confirm" ? "人工确认" : "升级裁决"} ·
                    挂起自 {formatTime(item.since)}
                  </span>
                </div>
                <p className="approval-question">{item.question}</p>
                {item.reason !== "" ? <p className="muted small">原因：{item.reason}</p> : null}
                <div className="approval-choices">
                  {item.options.map((choice) => (
                    <button
                      key={choice}
                      type="button"
                      className={choice.includes("拒绝") ? "btn btn-danger" : "btn"}
                      disabled={deciding === item.approval_id}
                      onClick={() => void decide(item, choice)}
                    >
                      {choice}
                    </button>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="失败运行" extra={<span className="muted">{data?.failed_runs.length ?? 0} 个</span>}>
        {data === null ? (
          <Empty text="加载中…" />
        ) : data.failed_runs.length === 0 ? (
          <Empty text="没有失败的 run" />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>需求</th>
                <th>run</th>
                <th>SDLC</th>
                <th>状态</th>
                <th>开始时间</th>
                <th>错误</th>
              </tr>
            </thead>
            <tbody>
              {data.failed_runs.map((run) => (
                <tr key={run.run_id}>
                  <td>
                    <button type="button" className="link" onClick={() => onOpenRequirement(run.req_id)}>
                      {run.req_id}
                    </button>
                  </td>
                  <td className="mono small">{run.run_id}</td>
                  <td>
                    {run.sdlc_id} v{run.sdlc_version}
                  </td>
                  <td>
                    <RunBadge status={run.status} />
                  </td>
                  <td>{formatTime(run.started_at)}</td>
                  <td className="muted small">{run.error ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </>
  );
}
