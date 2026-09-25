/** 需求列表 + 创建表单：列表字段全部来自 server 的需求摘要投影。 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent, ReactElement } from "react";
import type { RequirementSummary } from "@agent-cord/server/contracts";
import { api } from "../api.js";
import { describeError, Empty, ErrorBanner, formatTime, Section, StatusBadge } from "../ui.js";

const POLL_MS = 5_000;

export function Requirements({ onOpenRequirement }: { onOpenRequirement: (reqId: string) => void }): ReactElement {
  const [items, setItems] = useState<RequirementSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await api.listRequirements();
      setItems(result.requirements);
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

  return (
    <>
      <header className="page-head">
        <div>
          <p className="eyebrow">需求</p>
          <h1>需求列表</h1>
          <p className="muted">每个需求对应 cord/&lt;req-id&gt;/ 文件夹：快照文档、账本与事件流。</p>
        </div>
        <div className="page-actions">
          <button type="button" className="btn btn-primary" onClick={() => void refresh()}>
            刷新
          </button>
        </div>
      </header>

      <ErrorBanner message={error} onClose={() => setError(null)} />

      <CreateRequirementForm onCreated={onOpenRequirement} />

      <Section title="全部需求" extra={<span className="muted">{items?.length ?? 0} 个</span>}>
        {items === null ? (
          <Empty text="加载中…" />
        ) : items.length === 0 ? (
          <Empty text="还没有需求，先用上面的表单创建一个" />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>标题</th>
                <th>状态</th>
                <th>当前节点</th>
                <th>待审批</th>
                <th>事件数</th>
                <th>最近活动</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.req_id}>
                  <td>
                    <button type="button" className="link" onClick={() => onOpenRequirement(item.req_id)}>
                      {item.title}
                    </button>
                    <div className="muted small mono">{item.req_id}</div>
                  </td>
                  <td>
                    <StatusBadge status={item.status} />
                  </td>
                  <td>{item.current_node ?? "—"}</td>
                  <td>{item.pending_approvals > 0 ? <span className="pill pill-warn">{item.pending_approvals}</span> : 0}</td>
                  <td>{item.event_count}</td>
                  <td>{formatTime(item.last_event_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </>
  );
}

function CreateRequirementForm({ onCreated }: { onCreated: (reqId: string) => void }): ReactElement {
  const [title, setTitle] = useState("");
  const [reqId, setReqId] = useState("");
  const [prd, setPrd] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 同一次填写（未改动输入）的重试复用同一幂等键，避免重复产生 session.created 事件 */
  const keyRef = useRef<string | null>(null);

  const invalidateKey = (): void => {
    keyRef.current = null;
  };

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (title.trim() === "") return;
    const key = keyRef.current ?? globalThis.crypto.randomUUID();
    keyRef.current = key;
    setBusy(true);
    setError(null);
    try {
      const input = {
        title: title.trim(),
        ...(reqId.trim() !== "" ? { req_id: reqId.trim() } : {}),
        ...(prd.trim() !== "" ? { prd } : {}),
      };
      const created = await api.createRequirement(input, key);
      keyRef.current = null;
      setTitle("");
      setReqId("");
      setPrd("");
      onCreated(created.requirement.req_id);
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="新建需求" extra={<span className="muted">标题必填；req_id 留空由 server 生成</span>}>
      <form className="form" onSubmit={(event) => void submit(event)}>
        <ErrorBanner message={error} onClose={() => setError(null)} />
        <div className="field-row">
          <label className="field">
            <span>标题 *</span>
            <input
              value={title}
              onChange={(event) => {
                setTitle(event.target.value);
                invalidateKey();
              }}
              placeholder="例如：支持团队级审批"
              maxLength={200}
              required
            />
          </label>
          <label className="field">
            <span>需求编号（可选）</span>
            <input
              value={reqId}
              onChange={(event) => {
                setReqId(event.target.value);
                invalidateKey();
              }}
              placeholder="字母数字、-、_，1-64 位"
            />
          </label>
        </div>
        <label className="field">
          <span>PRD（可选）</span>
          <textarea
            className="mono"
            rows={6}
            value={prd}
            onChange={(event) => {
              setPrd(event.target.value);
              invalidateKey();
            }}
            placeholder="# PRD&#10;&#10;目标、范围与验收标准…"
          />
        </label>
        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={busy || title.trim() === ""}>
            {busy ? "创建中…" : "创建需求"}
          </button>
        </div>
      </form>
    </Section>
  );
}
