/** SDLC 页面：已发布版本列表、版本 YAML 查看、校验/发布表单（发布前必须校验通过）。 */
import { useCallback, useEffect, useState } from "react";
import type { ReactElement } from "react";
import type { SdlcSummary, SdlcValidationResult } from "@agent-cord/server/contracts";
import { api } from "../api.js";
import { describeError, Empty, ErrorBanner, formatTime, NoticeBanner, Section } from "../ui.js";

const TEMPLATE_YAML = `apiVersion: agent-cord.dev/v1alpha1
kind: Workflow
metadata:
  id: my-sdlc
  name: 我的流程
spec:
  nodes:
    - id: intake
      artifact: prd.md
      gates:
        - id: evidence
          role: { initiators: [], approvers: [] }
          attach: { node: intake, when: post, triggers: [] }
          checks: [{ ref: anchors-present }]
          pass: { require: all, human_confirm: false }
          on_fail: block
`;

export function Sdlcs(): ReactElement {
  const [sdlcs, setSdlcs] = useState<SdlcSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sdlcId, setSdlcId] = useState("my-sdlc");
  const [yaml, setYaml] = useState(TEMPLATE_YAML);
  const [validation, setValidation] = useState<SdlcValidationResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ title: string; yaml: string } | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const result = await api.listSdlcs();
      setSdlcs(result.sdlcs);
      setError(null);
    } catch (cause) {
      setError(describeError(cause));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const validate = async (): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      const result = await api.validateSdlc(sdlcId.trim() || "my-sdlc", yaml);
      setValidation(result.validation);
      setNotice(result.validation.ok ? "校验通过，可以发布" : "校验未通过，请按 issues 修正后重试");
      setError(null);
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  };

  const publish = async (): Promise<void> => {
    if (validation === null || !validation.ok) return;
    setBusy(true);
    try {
      const published = await api.publishSdlc(sdlcId.trim(), yaml);
      setNotice(`已发布 ${published.sdlc_id} v${published.version}（content_hash ${published.content_hash.slice(0, 12)}…）`);
      setValidation(null);
      await refresh();
      setError(null);
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  };

  const showVersion = async (id: string, version: number): Promise<void> => {
    setPreviewBusy(true);
    try {
      const result = await api.getSdlcVersion(id, version);
      setPreview({ title: `${result.sdlc_id} v${result.version} · ${result.content_hash}`, yaml: result.yaml });
      setError(null);
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setPreviewBusy(false);
    }
  };

  return (
    <>
      <header className="page-head">
        <div>
          <p className="eyebrow">流程定义</p>
          <h1>SDLC 版本</h1>
          <p className="muted">发布版本不可原地修改；已启动的 run 绑定其发布的版本。</p>
        </div>
        <div className="page-actions">
          <button type="button" className="btn btn-primary" onClick={() => void refresh()}>
            刷新
          </button>
        </div>
      </header>

      <ErrorBanner message={error} onClose={() => setError(null)} />
      <NoticeBanner message={notice} />

      <Section title="已发布版本" extra={<span className="muted">{sdlcs?.length ?? 0} 个 SDLC</span>}>
        {sdlcs === null ? (
          <Empty text="加载中…" />
        ) : sdlcs.length === 0 ? (
          <Empty text="没有任何 SDLC" />
        ) : (
          <ul className="sdlc-list">
            {sdlcs.map((sdlc) => (
              <li key={sdlc.sdlc_id} className="sdlc-item">
                <div className="sdlc-head">
                  <strong>{sdlc.name}</strong>
                  <span className="muted small mono">{sdlc.sdlc_id}</span>
                  {sdlc.builtin ? <span className="pill">内置</span> : null}
                  {sdlc.has_draft ? <span className="pill pill-warn">有草稿</span> : null}
                </div>
                {sdlc.versions.length === 0 ? (
                  <Empty text="没有发布版本" />
                ) : (
                  <table className="table">
                    <thead>
                      <tr>
                        <th>版本</th>
                        <th>状态</th>
                        <th>content_hash</th>
                        <th>发布时间</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {sdlc.versions.map((version) => (
                        <tr key={version.version}>
                          <td>v{version.version}</td>
                          <td>{version.status === "published" ? "已发布" : "已归档"}</td>
                          <td className="mono small">{version.content_hash}</td>
                          <td>{formatTime(version.published_at)}</td>
                          <td>
                            <button
                              type="button"
                              className="btn"
                              disabled={previewBusy}
                              onClick={() => void showVersion(sdlc.sdlc_id, version.version)}
                            >
                              查看 YAML
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {preview !== null ? (
        <Section
          title="版本 YAML"
          extra={
            <button type="button" className="btn" onClick={() => setPreview(null)}>
              关闭
            </button>
          }
        >
          <div className="muted small mono">{preview.title}</div>
          <pre className="payload mono">{preview.yaml}</pre>
        </Section>
      ) : null}

      <Section title="校验 / 发布" extra={<span className="muted">校验通过（issues 为空）才允许发布</span>}>
        <div className="form">
          <label className="field">
            <span>SDLC 标识 *（小写字母数字与 -）</span>
            <input
              value={sdlcId}
              onChange={(event) => {
                setSdlcId(event.target.value);
                setValidation(null);
              }}
              placeholder="my-sdlc"
            />
          </label>
          <label className="field">
            <span>YAML 定义</span>
            <textarea
              className="editor mono"
              rows={18}
              value={yaml}
              onChange={(event) => {
                setYaml(event.target.value);
                setValidation(null);
              }}
              spellCheck={false}
            />
          </label>
          <div className="form-actions">
            <button type="button" className="btn" disabled={busy} onClick={() => void validate()}>
              {busy ? "处理中…" : "校验"}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || validation === null || !validation.ok}
              onClick={() => void publish()}
            >
              发布
            </button>
            {validation !== null ? (
              <span className={validation.ok ? "ok-text" : "fail-text"}>
                {validation.ok ? `校验通过 · content_hash ${validation.content_hash?.slice(0, 12) ?? "—"}…` : "校验未通过"}
              </span>
            ) : null}
          </div>
          {validation !== null && validation.issues.length > 0 ? (
            <ul className="issues">
              {validation.issues.map((issue, index) => (
                <li key={`${index}-${issue}`}>{issue}</li>
              ))}
            </ul>
          ) : null}
        </div>
      </Section>
    </>
  );
}
