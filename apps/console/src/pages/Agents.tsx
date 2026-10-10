/** Agent 工作台仅消费公开配置投影，显式重载成功后替换清单。 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import { AlertTriangle, Bot, ChevronDown, ChevronUp, FileCog, RefreshCw, Search, X } from "lucide-react";
import type { AgentCatalogView, AgentInspectionView } from "@agent-cord/server/contracts";
import { api } from "../api.js";
import { inspection_matches_catalog, launch_option_text } from "../agent-capabilities.js";
import { AgentCapabilityDetails } from "./AgentCapabilityDetails.js";
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
  const [capability, setCapability] = useState("all");
  const [selected, setSelected] = useState<AgentCatalogView["agents"][number] | null>(null);
  const [catalog_verified, setCatalogVerified] = useState(false);
  const [inspecting, setInspecting] = useState<string | null>(null);
  const [inspections, setInspections] = useState(new Map<string, AgentInspectionView>());
  const [inspection_modes, setInspectionModes] = useState(new Map<string, boolean>());
  const [inspection_errors, setInspectionErrors] = useState(new Map<string, { message: string; stage: "inspection" | "catalog" }>());
  const detail_id = useId();
  const generation = useRef(0);
  const in_flight = useRef(false);

  const update = useCallback(async (reload: boolean): Promise<void> => {
    if (in_flight.current) return;
    in_flight.current = true;
    const operation = ++generation.current;
    setPhase(reload ? "reloading" : "loading");
    setCatalogVerified(false);
    setError(null);
    setNotice(null);
    try {
      const result = reload ? await api.reloadAgents() : await api.listAgents();
      if (generation.current !== operation) return;
      setCatalog(result);
      setCatalogVerified(true);
      setInspectionErrors(previous => new Map([...previous].filter(([, value]) => value.stage !== "catalog")));
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

  const inspect = useCallback(async (name: string, readonly = false): Promise<void> => {
    if (in_flight.current) return;
    in_flight.current = true;
    const operation = ++generation.current;
    setInspecting(name);
    setNotice(null);
    setInspectionErrors(previous => { const next = new Map(previous); next.delete(name); return next; });
    try {
      const result = await api.inspectAgent(name, undefined, readonly ? { readonly: true } : {});
      if (generation.current !== operation) return;
      setInspections(previous => new Map(previous).set(name, result));
      setCatalogVerified(false);
      try {
        const latest = await api.listAgents();
        if (generation.current !== operation) return;
        setCatalog(latest); setCatalogVerified(true);
      } catch (cause) {
        if (generation.current === operation) setInspectionErrors(previous => new Map(previous).set(name, { message: `当前清单读取失败：${describeError(cause)}`, stage: "catalog" }));
      }
    } catch (cause) {
      if (generation.current === operation) setInspectionErrors(previous => new Map(previous).set(name, { message: describeError(cause), stage: "inspection" }));
    } finally {
      if (generation.current === operation) { in_flight.current = false; setInspecting(null); }
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
      (capability === "all" || (capability === "resume" ? agent.capabilities?.native_resume === "supported" : agent.capabilities?.launch_options.includes(capability))) &&
      (term === "" || [agent.name, agent.template ?? "", agent.kind].some((value) => value.toLowerCase().includes(term))),
    ) ?? [];
  }, [catalog, query, source, protocol, capability]);
  const available_options = useMemo(() => [...new Set(catalog?.agents.flatMap(agent => agent.capabilities?.launch_options ?? []) ?? [])].sort(), [catalog]);
  const busy = phase !== "idle" || inspecting !== null;
  const readonly_query = (agent: AgentCatalogView["agents"][number]) => agent.kind === "acp" && agent.capabilities?.readonly_configuration === "explicit" && inspection_modes.get(agent.name) === true;

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
        <div className="field"><label htmlFor="agent-capability">能力</label><select id="agent-capability" className="select" value={capability} onChange={event => setCapability(event.target.value)}><option value="all">全部能力</option><option value="resume">原生恢复已声明</option>{available_options.map(option => <option key={option} value={option}>{launch_option_text(option)}</option>)}</select></div>
      </div>

      <section aria-labelledby="agent-list-title" aria-busy={busy}>
        <header className="agent-list-head"><h2 id="agent-list-title">已注册 Agent</h2><span className="muted small" aria-live="polite">{catalog === null ? "" : `${visible.length} / ${catalog.agents.length}`}</span></header>
        {catalog === null ? (
          busy ? <div className="agent-loading" role="status">正在读取配置...</div> : <Empty text="未能读取配置清单" />
        ) : visible.length === 0 ? (
          <Empty text={catalog.agents.length === 0 ? "当前没有已注册 Agent" : "没有匹配的 Agent"} />
        ) : (
          <>
            <div className="agent-columns" aria-hidden="true"><span>名称</span><span>来源</span><span>协议 / 模板</span><span>配置指纹</span><span>能力</span></div>
            <ul className="agent-list">
              {visible.map((agent) => (
                <li key={agent.name} className={`agent-row ${selected?.name === agent.name ? "agent-row-selected" : ""}`}>
                  <div className="agent-name"><Bot size={15} aria-hidden="true" /><strong className="mono">{agent.name}</strong></div>
                  <span className={`agent-source agent-source-${agent.source}`}>{SOURCE_TEXT[agent.source]}</span>
                  <div className="agent-protocol"><span>{agent.kind === "acp" ? "ACP" : "Headless"}</span>{agent.template !== null ? <code className="muted small">{agent.template}</code> : null}</div>
                  <div className="agent-identity"><code className="agent-config-hash" title={agent.configuration_hash ?? "未提供"}>{agent.configuration_hash?.slice(0, 12) ?? "未提供"}</code>
                    {agent.context_revision !== undefined ? <span className="agent-context-revision muted small">上下文 v{agent.context_revision}</span> : null}
                    {agent.permission_policy !== undefined ? <span className="muted small" title="可写 ACP 任务按声明文件范围一次授权；只读任务仍拒绝权限请求">预授权：读 {agent.permission_policy.read_count} / 写 {agent.permission_policy.edit_count}</span> : null}
                  </div>
                  <span className="agent-tool agent-detail-toggle"><button type="button" className="btn agent-icon-button" aria-label={`查看能力 ${agent.name}`} aria-expanded={selected?.name === agent.name} aria-controls={selected?.name === agent.name ? detail_id : undefined} onClick={() => setSelected(previous => previous?.name === agent.name ? null : agent)}>
                    {selected?.name === agent.name ? <ChevronUp size={18} aria-hidden="true" /> : <ChevronDown size={18} aria-hidden="true" />}
                  </button><span role="tooltip" className="agent-tooltip">查看能力</span></span>
                  {selected?.name === agent.name ? <AgentCapabilityDetails id={detail_id} agent={agent} inspection={inspections.get(agent.name)}
                    current={catalog_verified && inspections.has(agent.name) && inspection_matches_catalog(catalog, agent.name, inspections.get(agent.name)!, readonly_query(agent))}
                    readonly={readonly_query(agent)} onReadonlyChange={value => setInspectionModes(previous => new Map(previous).set(agent.name, value))}
                    catalog_verified={catalog_verified} inspecting={inspecting === agent.name} disabled={busy} error={inspection_errors.get(agent.name)?.message ?? null} onInspect={() => void inspect(agent.name, readonly_query(agent))} /> : null}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
      {catalog !== null && selected !== null && !catalog.agents.some(agent => agent.name === selected.name) ? <section className="agent-removed-observation" aria-label="已移除 Agent 的历史查询">
        <header className="agent-detail-head"><h2 className="mono">{selected.name}</h2><span className="agent-result-stale">已移除</span><button type="button" className="btn agent-icon-button" aria-label="关闭历史查询" onClick={() => setSelected(null)}><X size={18} aria-hidden="true" /></button></header>
        <AgentCapabilityDetails id={detail_id} agent={selected} inspection={inspections.get(selected.name)} current={false} catalog_verified={catalog_verified}
          readonly={readonly_query(selected)} onReadonlyChange={() => undefined}
          inspecting={inspecting === selected.name} disabled={true} error={inspection_errors.get(selected.name)?.message ?? null} onInspect={() => undefined} />
      </section> : null}
    </div>
  );
}
