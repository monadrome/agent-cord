/** Agent 工作台仅消费公开配置投影，显式重载成功后替换清单。 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import { AlertTriangle, Bot, Check, FileCog, RefreshCw, Search } from "lucide-react";
import type { AgentCatalogView } from "@agent-cord/server/contracts";
import { api } from "../api.js";
import { describeError, Empty, ErrorBanner, NoticeBanner } from "../ui.js";

const SOURCE_TEXT = { workspace: "工作区", registry: "内置注册表" } as const;

export function Agents(): ReactElement {
  const [catalog, setCatalog] = useState<AgentCatalogView | null>(null);
  const [phase, setPhase] = useState<"loading" | "reloading" | "idle">("loading");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [source, setSource] = useState("all");
  const [protocol, setProtocol] = useState("all");
  const generation = useRef(0);
  const in_flight = useRef(false);

  const update = useCallback(async (reload: boolean): Promise<void> => {
    if (in_flight.current) return;
    in_flight.current = true;
    const operation = ++generation.current;
    setPhase(reload ? "reloading" : "loading");
    setError(null);
    setNotice(null);
    try {
      const result = reload ? await api.reloadAgents() : await api.listAgents();
      if (generation.current !== operation) return;
      setCatalog(result);
      if (reload) setNotice(`配置已重载，当前版本 ${result.revision}`);
    } catch (cause) {
      if (generation.current === operation) setError(describeError(cause));
    } finally {
      if (generation.current === operation) {
        in_flight.current = false;
        setPhase("idle");
      }
    }
  }, []);

  useEffect(() => {
    void update(false);
    return () => { generation.current += 1; in_flight.current = false; };
  }, [update]);

  const visible = useMemo(() => {
    const term = query.trim().toLowerCase();
    return catalog?.agents.filter((agent) =>
      (source === "all" || source === agent.source) &&
      (protocol === "all" || protocol === agent.kind) &&
      (term === "" || [agent.name, agent.template ?? "", agent.kind].some((value) => value.toLowerCase().includes(term))),
    ) ?? [];
  }, [catalog, query, source, protocol]);
  const busy = phase !== "idle";

  return (
    <div className="agent-workspace">
      <header className="page-head agent-page-head">
        <div className="agent-page-title">
          <Bot size={25} aria-hidden="true" />
          <div><h1>Agent</h1><p className="muted small">当前配置版本 {catalog?.revision ?? "..."}</p></div>
        </div>
        <div className="agent-actions">
          <span className="agent-tool">
            <button type="button" className="btn agent-icon-button" aria-label="刷新清单" aria-describedby="agent-refresh-tip" disabled={busy} onClick={() => void update(false)}>
              <RefreshCw size={18} className={phase === "loading" ? "agent-spinning" : undefined} aria-hidden="true" />
            </button>
            <span id="agent-refresh-tip" role="tooltip" className="agent-tooltip">刷新清单</span>
          </span>
          <span className="agent-tool">
            <button type="button" className="btn btn-primary agent-icon-button" aria-label="重载配置" aria-describedby="agent-reload-tip" disabled={busy} onClick={() => void update(true)}>
              <FileCog size={18} className={phase === "reloading" ? "agent-spinning" : undefined} aria-hidden="true" />
            </button>
            <span id="agent-reload-tip" role="tooltip" className="agent-tooltip">重载配置</span>
          </span>
        </div>
      </header>

      <ErrorBanner message={error} onClose={() => setError(null)} />
      <NoticeBanner message={notice} />

      {catalog !== null && (catalog.warnings.length > 0 || catalog.rejected.length > 0) ? (
        <section className="agent-diagnostics" aria-labelledby="agent-diagnostics-title">
          <header><AlertTriangle size={18} aria-hidden="true" /><h2 id="agent-diagnostics-title">配置诊断</h2><span>{catalog.rejected.length} 个已拒绝</span></header>
          {catalog.rejected.length > 0 ? <p className="agent-rejected">{catalog.rejected.map((name) => <code key={name}>{name}</code>)}</p> : null}
          <ul>{catalog.warnings.map((warning, index) => <li key={`${index}:${warning}`}>{warning}</li>)}</ul>
        </section>
      ) : null}

      <div className="agent-filters">
        <div className="field agent-search"><label htmlFor="agent-search">搜索</label><span className="agent-search-input"><Search size={17} aria-hidden="true" /><input id="agent-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="名称或模板" /></span></div>
        <div className="field"><label htmlFor="agent-source">来源</label><select id="agent-source" className="select" value={source} onChange={(event) => setSource(event.target.value)}><option value="all">全部来源</option><option value="workspace">工作区</option><option value="registry">内置注册表</option></select></div>
        <div className="field"><label htmlFor="agent-protocol">协议</label><select id="agent-protocol" className="select" value={protocol} onChange={(event) => setProtocol(event.target.value)}><option value="all">全部协议</option><option value="acp">ACP</option><option value="headless">Headless</option></select></div>
      </div>

      <section aria-labelledby="agent-list-title" aria-busy={busy}>
        <header className="agent-list-head"><h2 id="agent-list-title">已注册 Agent</h2><span className="muted small" aria-live="polite">{catalog === null ? "" : `${visible.length} / ${catalog.agents.length}`}</span></header>
        {catalog === null ? (
          busy ? <div className="agent-loading" role="status">正在读取配置...</div> : <Empty text="未能读取配置清单" />
        ) : visible.length === 0 ? (
          <Empty text={catalog.agents.length === 0 ? "当前没有已注册 Agent" : "没有匹配的 Agent"} />
        ) : (
          <>
            <div className="agent-columns" aria-hidden="true"><span>名称</span><span>来源</span><span>协议 / 模板</span><span>配置指纹</span></div>
            <ul className="agent-list">
              {visible.map((agent) => (
                <li key={agent.name} className="agent-row">
                  <div className="agent-name"><Check size={15} aria-hidden="true" /><strong className="mono">{agent.name}</strong></div>
                  <span className={`agent-source agent-source-${agent.source}`}>{SOURCE_TEXT[agent.source]}</span>
                  <div className="agent-protocol"><span>{agent.kind === "acp" ? "ACP" : "Headless"}</span>{agent.template !== null ? <code className="muted small">{agent.template}</code> : null}</div>
                  <div className="agent-identity"><code className="agent-config-hash" title={agent.configuration_hash ?? "未提供"}>{agent.configuration_hash?.slice(0, 12) ?? "未提供"}</code>
                    {agent.context_revision !== undefined ? <span className="agent-context-revision muted small">上下文 v{agent.context_revision}</span> : null}
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}
