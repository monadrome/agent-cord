/** SDLC 页面：已发布版本列表（归档/克隆）、版本 YAML 查看、模板库、草稿、校验/发布。 */
import { useCallback, useEffect, useState } from "react";
import type { ReactElement } from "react";
import type { SdlcSummary, SdlcTemplate, SdlcValidationResult } from "@agent-cord/server/contracts";
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
  const [templates, setTemplates] = useState<SdlcTemplate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sdlcId, setSdlcId] = useState("my-sdlc");
  const [yaml, setYaml] = useState(TEMPLATE_YAML);
  const [validation, setValidation] = useState<SdlcValidationResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ title: string; yaml: string } | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  /** 当前编辑器对应的草稿状态（当前 sdlcId 在列表里 has_draft） */
  const draftOwner = sdlcs?.find((item) => item.sdlc_id === sdlcId)?.has_draft ?? false;

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
    void api
      .listSdlcTemplates()
      .then((result) => setTemplates(result.templates))
      .catch(() => {
        // 模板库加载失败不阻断手写 YAML
      });
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

  const saveDraft = async (): Promise<void> => {
    setBusy(true);
    try {
      const saved = await api.saveSdlcDraft(sdlcId.trim(), yaml);
      setValidation(saved.validation);
      setNotice(
        saved.validation.ok
          ? `草稿已保存且校验通过（${sdlcId}）`
          : `草稿已保存（校验未通过：${saved.validation.issues.length} 个问题，可稍后继续）`,
      );
      await refresh();
      setError(null);
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  };

  const loadDraft = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await api.getSdlcDraft(sdlcId.trim());
      if (result.draft === null) {
        setNotice(`${sdlcId} 没有草稿`);
        return;
      }
      setYaml(result.draft.yaml);
      setValidation(null);
      setNotice("已载入草稿");
      setError(null);
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  };

  const loadTemplate = (templateId: string): void => {
    const template = templates.find((item) => item.id === templateId);
    if (template === undefined) return;
    setYaml(template.yaml);
    setValidation(null);
    setNotice(`已载入模板「${template.name}」：${template.description}（发布前请按需修改 metadata.id 与节点）`);
  };

  const cloneVersion = async (id: string, version: number): Promise<void> => {
    setPreviewBusy(true);
    try {
      const result = await api.getSdlcVersion(id, version);
      setYaml(result.yaml);
      setSdlcId(id);
      setValidation(null);
      setNotice(`已把 ${id} v${version} 载入编辑器：修改后发布会递增为新版本`);
      setError(null);
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setPreviewBusy(false);
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

  const toggleArchive = async (id: string, version: number, archived: boolean): Promise<void> => {
    setBusy(true);
    try {
      if (archived) {
        await api.unarchiveSdlcVersion(id, version);
        setNotice(`已取消归档 ${id} v${version}（可启动新 run）`);
      } else {
        await api.archiveSdlcVersion(id, version);
        setNotice(`已归档 ${id} v${version}（禁止启动新 run；在途/历史 run 不受影响）`);
      }
      await refresh();
      setError(null);
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <header className="page-head">
        <div>
          <p className="eyebrow">流程定义</p>
          <h1>SDLC 版本</h1>
          <p className="muted">发布版本不可原地修改；已启动的 run 绑定其发布的版本；归档版本禁止启动新 run。</p>
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
                              查看
                            </button>{" "}
                            <button
                              type="button"
                              className="btn"
                              disabled={previewBusy}
                              onClick={() => void cloneVersion(sdlc.sdlc_id, version.version)}
                            >
                              克隆到编辑器
                            </button>{" "}
                            <button
                              type="button"
                              className="btn"
                              disabled={busy}
                              onClick={() => void toggleArchive(sdlc.sdlc_id, version.version, version.status === "archived")}
                            >
                              {version.status === "archived" ? "取消归档" : "归档"}
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
          <div className="field-row">
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
              <span>从模板载入</span>
              <select
                className="select"
                value=""
                onChange={(event) => {
                  if (event.target.value !== "") loadTemplate(event.target.value);
                }}
              >
                <option value="">选择模板…</option>
                {templates.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.name} — {template.description}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="field">
            <span>
              YAML 定义
              {draftOwner ? (
                <>
                  {" "}
                  <span className="pill pill-warn">有草稿</span>{" "}
                  <button type="button" className="btn btn-plain" disabled={busy} onClick={() => void loadDraft()}>
                    载入草稿
                  </button>
                </>
              ) : null}
            </span>
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
            <button type="button" className="btn" disabled={busy} onClick={() => void saveDraft()}>
              存草稿
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
