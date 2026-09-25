/**
 * 需求详情：状态 / 运行控制 + tab 子视图（概览 / 文档 / 账本 / 投票 / 事件 / 审批）。
 * 状态、时间线、账本、审批一律来自 server 投影接口；前端只转发命令与展示。
 * 事件 tab 用 SSE 实时订阅（组件卸载时关闭 EventSource），新事件到达时刷新概览与审批。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactElement } from "react";
import type {
  ApprovalItem,
  GateState,
  LedgerEntryView,
  LedgerView,
  RequirementDetail as RequirementDetailView,
  SnapshotDocName,
  StreamedEvent,
  TimelineNode,
  TimelineView,
  VoteSummary,
} from "@agent-cord/server/contracts";
import { api, ApiClientError, SNAPSHOT_DOCS } from "../api.js";
import {
  describeError,
  Empty,
  ErrorBanner,
  formatTime,
  NoticeBanner,
  RunBadge,
  Section,
  StatusBadge,
} from "../ui.js";
import { MarkdownPreview } from "../markdown.js";

export const DETAIL_TABS = ["overview", "docs", "ledger", "votes", "events", "approvals"] as const;
export type DetailTab = (typeof DETAIL_TABS)[number];
export const DETAIL_TAB_TEXT: Record<DetailTab, string> = {
  overview: "概览",
  docs: "文档",
  ledger: "账本",
  votes: "投票",
  events: "事件",
  approvals: "审批",
};

const NODE_STATUS_TEXT: Record<TimelineNode["status"], string> = {
  pending: "待执行",
  entered: "执行中",
  exited: "已完成",
};

const GATE_RESULT_TEXT: Record<"pass" | "block" | "warn", string> = {
  pass: "通过",
  block: "阻断",
  warn: "警告",
};

const GATE_ACTION_TEXT: Record<"continue" | "escalate" | "stop", string> = {
  continue: "继续",
  escalate: "升级人工",
  stop: "停止",
};

const LEDGER_STATUS_TEXT: Record<LedgerEntryView["status"], string> = {
  provisional: "暂定",
  confirmed: "已确认",
  overturned: "已推翻",
};

const CONFIDENCE_TEXT: Record<LedgerEntryView["confidence_source"], string> = {
  vote_agreement: "投票一致",
  human_confirmation: "人工确认",
  evidence_direct: "证据直取",
};

const ACTOR_KIND_TEXT: Record<StreamedEvent["actor"]["kind"], string> = {
  human: "人工",
  agent: "代理",
  system: "系统",
};

interface Props {
  reqId: string;
  tab: DetailTab;
  onTab: (tab: DetailTab) => void;
  onBack: () => void;
}

export function RequirementDetail({ reqId, tab, onTab, onBack }: Props): ReactElement {
  const [detail, setDetail] = useState<RequirementDetailView | null>(null);
  const [timeline, setTimeline] = useState<TimelineView | null>(null);
  const [approvals, setApprovals] = useState<ApprovalItem[]>([]);
  const [ledger, setLedger] = useState<LedgerView | null>(null);
  const [votes, setVotes] = useState<VoteSummary[]>([]);
  const [events, setEvents] = useState<StreamedEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [runBusy, setRunBusy] = useState(false);
  const [deciding, setDeciding] = useState<string | null>(null);

  const loadProjections = useCallback(async () => {
    try {
      const [detailResult, timelineResult, approvalsResult, ledgerResult, votesResult] = await Promise.all([
        api.getRequirement(reqId),
        api.getTimeline(reqId),
        api.getApprovals(reqId),
        api.getLedger(reqId),
        api.getVotes(reqId),
      ]);
      setDetail(detailResult.requirement);
      setTimeline(timelineResult.timeline);
      setApprovals(approvalsResult.approvals);
      setLedger(ledgerResult.ledger);
      setVotes(votesResult.votes);
      setError(null);
    } catch (cause) {
      setError(describeError(cause));
    }
  }, [reqId]);

  useEffect(() => {
    setDetail(null);
    setTimeline(null);
    setLedger(null);
    setApprovals([]);
    setVotes([]);
    setEvents([]);
    void loadProjections();
  }, [loadProjections]);

  // 事件快照（REST）+ 实时增量（SSE）：SSE 不可用时至少还有快照
  useEffect(() => {
    let cancelled = false;
    void api
      .getEvents(reqId, 0)
      .then((result) => {
        if (!cancelled) setEvents((prev) => mergeEvents(prev, result.events));
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(describeError(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [reqId]);

  useEffect(() => {
    let pending: number | null = null;
    const close = api.subscribeEvents(
      reqId,
      (event) => {
        setStreamError(null);
        setEvents((prev) => mergeEvents(prev, [event]));
        // 新事件到达 → 概览 / 审批 / 账本等投影刷新（去抖，执行器连续落盘时只刷一次）
        if (pending === null) {
          pending = window.setTimeout(() => {
            pending = null;
            void loadProjections();
          }, 400);
        }
      },
      (cause) => setStreamError(describeError(cause)),
    );
    return () => {
      if (pending !== null) window.clearTimeout(pending);
      close();
    };
  }, [reqId, loadProjections]);

  const startRun = async (): Promise<void> => {
    setRunBusy(true);
    setRunError(null);
    try {
      await api.startRun(reqId);
      setNotice("已启动 run，进度会从事件流实时更新");
      await loadProjections();
    } catch (cause) {
      if (cause instanceof ApiClientError && cause.status === 409) {
        setRunError(`已有在途 run：${cause.message}（等待其结束或先处理挂起的审批）`);
      } else {
        setRunError(describeError(cause));
      }
    } finally {
      setRunBusy(false);
    }
  };

  const decide = async (item: ApprovalItem, choice: string): Promise<void> => {
    setDeciding(item.approval_id);
    setRunError(null);
    try {
      await api.decideApproval(item.req_id, item.approval_id, choice);
      setNotice(`已提交决策「${choice}」，等待事件流确认`);
      await loadProjections();
    } catch (cause) {
      setRunError(describeError(cause));
    } finally {
      setDeciding(null);
    }
  };

  const activeRun = detail?.active_run ?? null;
  const runInFlight = activeRun !== null && (activeRun.status === "running" || activeRun.status === "waiting_human");

  return (
    <>
      <button type="button" className="btn btn-plain" onClick={onBack}>
        ‹ 返回需求列表
      </button>

      <header className="page-head">
        <div>
          <p className="eyebrow mono">{reqId}</p>
          <h1>{detail?.title ?? "加载中…"}</h1>
          <p className="muted">
            {detail !== null ? (
              <>
                事件 {detail.event_count} 条 · 当前节点 {detail.current_node ?? "—"} · 最近活动{" "}
                {formatTime(detail.last_event_at)} · 创建于 {formatTime(detail.created_at)}
              </>
            ) : null}
          </p>
        </div>
        <div className="page-actions">
          {detail !== null ? <StatusBadge status={detail.status} /> : null}
          <button
            type="button"
            className="btn btn-primary"
            disabled={runBusy || runInFlight}
            onClick={() => void startRun()}
          >
            {runInFlight ? "运行中…" : runBusy ? "启动中…" : "启动默认 SDLC run"}
          </button>
        </div>
      </header>

      <ErrorBanner message={error} onClose={() => setError(null)} />
      <ErrorBanner message={runError} onClose={() => setRunError(null)} />
      <ErrorBanner message={streamError} onClose={() => setStreamError(null)} />
      <NoticeBanner message={notice} />

      <nav className="tabs" aria-label="详情子视图">
        {DETAIL_TABS.map((item) => (
          <button
            key={item}
            type="button"
            className={item === tab ? "tab tab-active" : "tab"}
            onClick={() => onTab(item)}
          >
            {DETAIL_TAB_TEXT[item]}
            {item === "approvals" && approvals.length > 0 ? <span className="pill pill-warn">{approvals.length}</span> : null}
            {item === "events" ? <span className="pill">{events.length}</span> : null}
          </button>
        ))}
      </nav>

      {tab === "overview" ? <OverviewTab timeline={timeline} activeRun={activeRun} /> : null}
      {tab === "docs" ? <DocsTab reqId={reqId} docs={detail?.docs ?? null} /> : null}
      {tab === "ledger" ? <LedgerTab ledger={ledger} /> : null}
      {tab === "votes" ? <VotesTab votes={votes} /> : null}
      {tab === "events" ? <EventsTab events={events} /> : null}
      {tab === "approvals" ? (
        <ApprovalsTab approvals={approvals} deciding={deciding} onDecide={(item, choice) => void decide(item, choice)} />
      ) : null}
    </>
  );
}

/** 事件合并：SSE 可能与 REST 快照重叠，按 seq 去重并保持因果序 */
function mergeEvents(prev: StreamedEvent[], incoming: StreamedEvent[]): StreamedEvent[] {
  const bySeq = new Map<number, StreamedEvent>();
  for (const event of prev) bySeq.set(event.seq, event);
  for (const event of incoming) bySeq.set(event.seq, event);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

// ---------------------------------------------------------------------------
// 概览
// ---------------------------------------------------------------------------

function OverviewTab({
  timeline,
  activeRun,
}: {
  timeline: TimelineView | null;
  activeRun: RequirementDetailView["active_run"];
}): ReactElement {
  if (timeline === null) return <Empty text="加载中…" />;
  // 在途 run 优先（active_run 来自需求详情，timeline.run 是最近一次 run 登记）
  const run = activeRun ?? timeline.run;
  return (
    <>
      <Section
        title="流程时间线"
        extra={
          <span className="muted">
            {timeline.sdlc_id} v{timeline.sdlc_version ?? "—"} · {timeline.nodes.filter((node) => node.status === "exited").length}/
            {timeline.nodes.length} 节点已完成
          </span>
        }
      >
        {timeline.nodes.length === 0 ? (
          <Empty text="尚未启动 run，没有节点状态" />
        ) : (
          <ol className="stepper">
            {timeline.nodes.map((node) => (
              <TimelineNodeCard key={node.node_id} node={node} />
            ))}
          </ol>
        )}
      </Section>

      <Section title="运行实例">
        {run === null ? (
          <Empty text="没有 run 记录" />
        ) : (
          <dl className="kv">
            <div>
              <dt>run_id</dt>
              <dd className="mono">{run.run_id}</dd>
            </div>
            <div>
              <dt>状态</dt>
              <dd>
                <RunBadge status={run.status} />
              </dd>
            </div>
            <div>
              <dt>SDLC</dt>
              <dd>
                {run.sdlc_id} v{run.sdlc_version}
              </dd>
            </div>
            <div>
              <dt>开始时间</dt>
              <dd>{formatTime(run.started_at)}</dd>
            </div>
            <div>
              <dt>结束时间</dt>
              <dd>{formatTime(run.finished_at)}</dd>
            </div>
            {run.error !== null ? (
              <div>
                <dt>错误</dt>
                <dd className="fail-text">{run.error}</dd>
              </div>
            ) : null}
          </dl>
        )}
      </Section>
    </>
  );
}

function TimelineNodeCard({ node }: { node: TimelineNode }): ReactElement {
  return (
    <li className={`node-card node-${node.status}`}>
      <div className="node-head">
        <strong className="mono">{node.node_id}</strong>
        <span className={`badge badge-node-${node.status}`}>{NODE_STATUS_TEXT[node.status]}</span>
      </div>
      {node.artifact !== null ? <div className="muted small mono">产物 {node.artifact}</div> : null}
      <div className="muted small">
        进入 {formatTime(node.entered_at)}
        <br />
        离开 {formatTime(node.exited_at)}
      </div>
      {node.gates.length > 0 ? (
        <ul className="gate-list">
          {node.gates.map((gate) => (
            <GateLine key={`${gate.gate_id}-${gate.phase}`} gate={gate} />
          ))}
        </ul>
      ) : (
        <div className="muted small">无 gate</div>
      )}
      {node.depends_on.length > 0 ? <div className="muted small">依赖 {node.depends_on.join(" / ")}</div> : null}
    </li>
  );
}

function GateLine({ gate }: { gate: GateState }): ReactElement {
  const status = gate.waiting
    ? "等待人工"
    : gate.result === null
      ? "未运行"
      : GATE_RESULT_TEXT[gate.result];
  return (
    <li className={gate.waiting ? "gate gate-waiting" : gate.result === "block" ? "gate gate-block" : "gate"}>
      <div className="gate-head">
        <span className="mono">{gate.gate_id}</span>
        <span className="muted small">{gate.phase === "pre" ? "前置" : "后置"} gate</span>
        <span className="gate-status">{status}</span>
      </div>
      <div className="muted small">
        动作 {gate.action === null ? "—" : GATE_ACTION_TEXT[gate.action]} · 人工确认{" "}
        {gate.human_confirmed ? "是" : "否"}
      </div>
      {gate.reason !== null && gate.reason !== "" ? <div className="small gate-reason">原因：{gate.reason}</div> : null}
    </li>
  );
}

// ---------------------------------------------------------------------------
// 文档
// ---------------------------------------------------------------------------

function DocsTab({ reqId, docs }: { reqId: string; docs: Record<SnapshotDocName, boolean> | null }): ReactElement {
  const [doc, setDoc] = useState<SnapshotDocName>("prd");
  const [content, setContent] = useState("");
  const [saved, setSaved] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setNotice(null);
    setError(null);
    void api
      .readDoc(reqId, doc)
      .then((result) => {
        if (cancelled) return;
        setContent(result.content);
        setSaved(result.content);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        // 文档尚未生成：允许人直接编写并保存（living 文档）
        if (cause instanceof ApiClientError && cause.status === 404) {
          setContent("");
          setSaved("");
          setNotice("文档尚未生成，可直接编写并保存");
        } else {
          setError(describeError(cause));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reqId, doc]);

  const dirty = content !== saved;

  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      await api.writeDoc(reqId, doc, content);
      setSaved(content);
      setNotice(`${doc}.md 已保存`);
      setError(null);
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title="快照文档"
      extra={
        <span className="muted">{docs === null ? "" : SNAPSHOT_DOCS.filter((name) => docs[name]).join(" / ") || "尚无文档"}</span>
      }
    >
      <div className="tabs tabs-sub">
        {SNAPSHOT_DOCS.map((name) => (
          <button
            key={name}
            type="button"
            className={name === doc ? "tab tab-active" : "tab"}
            onClick={() => setDoc(name)}
          >
            {name}.md
            {docs !== null && !docs[name] ? <span className="muted small"> · 未生成</span> : null}
          </button>
        ))}
      </div>
      <ErrorBanner message={error} onClose={() => setError(null)} />
      <NoticeBanner message={notice} />
      <div className="doc-workspace">
        <div className="doc-pane">
          <div className="doc-pane-title">Markdown 原文</div>
          <textarea
            className="editor mono"
            rows={18}
            value={content}
            disabled={loading}
            onChange={(event) => setContent(event.target.value)}
            placeholder={loading ? "加载中…" : "在此编写文档内容（Markdown）"}
            aria-label={`${doc}.md 内容`}
          />
        </div>
        <div className="doc-pane">
          <div className="doc-pane-title">渲染预览</div>
          {loading ? <div className="markdown-empty">加载中…</div> : <MarkdownPreview source={content} />}
        </div>
      </div>
      <div className="form-actions">
        <button type="button" className="btn btn-primary" disabled={busy || !dirty} onClick={() => void save()}>
          {busy ? "保存中…" : "保存"}
        </button>
        {dirty ? <span className="muted small">有未保存的修改</span> : <span className="muted small">已与磁盘一致</span>}
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// 账本
// ---------------------------------------------------------------------------

function LedgerTab({ ledger }: { ledger: LedgerView | null }): ReactElement {
  const [filter, setFilter] = useState<"all" | LedgerEntryView["status"]>("all");
  if (ledger === null) return <Empty text="加载中…" />;
  const entries = ledger.entries.filter((entry) => filter === "all" || entry.status === filter);
  const counts = {
    provisional: ledger.entries.filter((entry) => entry.status === "provisional").length,
    confirmed: ledger.entries.filter((entry) => entry.status === "confirmed").length,
    overturned: ledger.entries.filter((entry) => entry.status === "overturned").length,
  };
  return (
    <Section
      title="共识账本"
      extra={
        <span className="muted mono">
          reducer {ledger.reducer_version} · output_hash {ledger.output_hash.slice(0, 12)}…
        </span>
      }
    >
      <div className="tabs tabs-sub">
        <button type="button" className={filter === "all" ? "tab tab-active" : "tab"} onClick={() => setFilter("all")}>
          全部 <span className="pill">{ledger.entries.length}</span>
        </button>
        {(["provisional", "confirmed", "overturned"] as const).map((status) => (
          <button
            key={status}
            type="button"
            className={filter === status ? "tab tab-active" : "tab"}
            onClick={() => setFilter(status)}
          >
            {LEDGER_STATUS_TEXT[status]} <span className="pill">{counts[status]}</span>
          </button>
        ))}
      </div>
      {entries.length === 0 ? (
        <Empty text="该筛选下没有账本条目" />
      ) : (
        <ul className="entry-list">
          {entries.map((entry) => (
            <li key={entry.entry_id} className={entry.conflict ? "entry entry-conflict" : "entry"}>
              <div className="entry-head">
                <strong>{entry.title}</strong>
                <span className={`badge badge-ledger-${entry.status}`}>{LEDGER_STATUS_TEXT[entry.status]}</span>
                {entry.conflict ? <span className="badge badge-conflict">冲突</span> : null}
              </div>
              <div className="muted small mono">{entry.entry_id}</div>
              <div className="muted small">
                置信来源 {CONFIDENCE_TEXT[entry.confidence_source]}
                {entry.vote_record_id !== null ? ` · 投票记录 ${entry.vote_record_id}` : ""}
                {entry.superseded_by !== null ? ` · 被取代于 ${entry.superseded_by}` : ""}
              </div>
              {entry.overturn_reason !== null ? <div className="small fail-text">推翻原因：{entry.overturn_reason}</div> : null}
              <div className="anchors">
                <span className="muted small">证据锚点（{entry.anchors.length}）</span>
                {entry.anchors.length === 0 ? (
                  <div className="fail-text small">无锚点</div>
                ) : (
                  <ul>
                    {entry.anchors.map((anchor, index) => (
                      <li key={`${anchor.kind}-${anchor.anchor}-${index}`}>
                        <span className="pill">{anchor.kind}</span>
                        <span className="mono small">{anchor.anchor}</span>
                        {anchor.line_hint !== undefined ? <span className="muted small"> · 行 {anchor.line_hint}</span> : null}
                        {anchor.snapshot?.commit !== undefined ? (
                          <span className="muted small mono"> · {anchor.snapshot.commit}</span>
                        ) : null}
                        {anchor.snapshot?.content_hash !== undefined ? (
                          <span className="muted small mono"> · {anchor.snapshot.content_hash.slice(0, 12)}…</span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// 投票
// ---------------------------------------------------------------------------

function VotesTab({ votes }: { votes: VoteSummary[] }): ReactElement {
  return (
    <Section title="盲评投票" extra={<span className="muted">{votes.length} 条记录</span>}>
      {votes.length === 0 ? (
        <Empty text="暂无投票记录（当前 SDLC 的 gate 未使用投票）" />
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>vote_id</th>
              <th>决策</th>
              <th>账本条目</th>
              <th>锚点重合度</th>
              <th>时间</th>
            </tr>
          </thead>
          <tbody>
            {votes.map((vote) => (
              <tr key={vote.vote_id}>
                <td className="mono small">{vote.vote_id}</td>
                <td>{vote.decision}</td>
                <td className="mono small">{vote.entry_id ?? "—"}</td>
                <td>{vote.anchor_overlap === null ? "—" : vote.anchor_overlap.toFixed(2)}</td>
                <td>{formatTime(vote.at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// 事件（SSE 实时）
// ---------------------------------------------------------------------------

function EventsTab({ events }: { events: StreamedEvent[] }): ReactElement {
  const [expanded, setExpanded] = useState<readonly number[]>([]);
  const newestFirst = useMemo(() => [...events].sort((a, b) => b.seq - a.seq), [events]);

  const toggle = (seq: number): void => {
    setExpanded((prev) => (prev.includes(seq) ? prev.filter((item) => item !== seq) : [...prev, seq]));
  };

  return (
    <Section
      title="事件流（SSE 实时）"
      extra={<span className="muted">{events.length} 条 · 最新在前</span>}
    >
      {newestFirst.length === 0 ? (
        <Empty text="暂无事件" />
      ) : (
        <ul className="event-list">
          {newestFirst.map((event) => {
            const open = expanded.includes(event.seq);
            return (
              <li key={event.event_id} className="event">
                <button type="button" className="event-row" onClick={() => toggle(event.seq)} aria-expanded={open}>
                  <span className="event-seq">#{event.seq}</span>
                  <span className="event-type mono">{event.type}</span>
                  <span className="muted small">
                    {ACTOR_KIND_TEXT[event.actor.kind]} · {event.actor.id}
                  </span>
                  <span className="muted small">{formatTime(event.timestamp)}</span>
                  <span className="event-toggle">{open ? "收起" : "展开"}</span>
                </button>
                {open ? <pre className="payload mono">{JSON.stringify(event.payload, null, 2)}</pre> : null}
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// 审批
// ---------------------------------------------------------------------------

function ApprovalsTab({
  approvals,
  deciding,
  onDecide,
}: {
  approvals: ApprovalItem[];
  deciding: string | null;
  onDecide: (item: ApprovalItem, choice: string) => void;
}): ReactElement {
  return (
    <Section title="人工 gate 审批" extra={<span className="muted">{approvals.length} 项待处理</span>}>
      {approvals.length === 0 ? (
        <Empty text="没有挂起的人工 gate" />
      ) : (
        <ul className="approval-list">
          {approvals.map((item) => (
            <li key={item.approval_id} className="approval-item">
              <div className="approval-head">
                <strong>{item.question}</strong>
                <span className="muted small">
                  节点 {item.node_id} · gate {item.gate_id} · 工作流 {item.workflow_id} ·{" "}
                  {item.kind === "human_confirm" ? "人工确认" : "升级裁决"} · 挂起自 {formatTime(item.since)}
                </span>
              </div>
              {item.reason !== "" ? <p className="muted small">原因：{item.reason}</p> : null}
              <div className="approval-choices">
                {item.options.map((choice) => (
                  <button
                    key={choice}
                    type="button"
                    className={choice.includes("拒绝") ? "btn btn-danger" : "btn"}
                    disabled={deciding === item.approval_id}
                    onClick={() => onDecide(item, choice)}
                  >
                    {choice}
                  </button>
                ))}
              </div>
              <div className="muted small mono">approval_id {item.approval_id}</div>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
