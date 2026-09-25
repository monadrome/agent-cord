/** 控制台共用展示组件与格式化工具（不含任何业务状态推导，状态文案与徽章是纯映射）。 */
import type { ReactElement, ReactNode } from "react";
import type { RequirementStatus, RunStatus } from "@agent-cord/server/contracts";
import { ApiClientError } from "./api.js";

/** 需求状态徽章中文文案 */
export const REQUIREMENT_STATUS_TEXT: Record<RequirementStatus, string> = {
  idle: "待启动",
  running: "运行中",
  waiting_human: "等待人工",
  blocked: "被阻断",
  completed: "已完成",
};

export const RUN_STATUS_TEXT: Record<RunStatus, string> = {
  running: "运行中",
  waiting_human: "等待人工",
  completed: "已完成",
  blocked: "被阻断",
  failed: "失败",
};

export function formatTime(value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}:${pad(date.getSeconds())}`;
}

/** 错误 → 可读文案：ApiClientError 保留 code/message，details 是数组时逐条列出 */
export function describeError(error: unknown): string {
  if (error instanceof ApiClientError) {
    const lines = [`${error.message}（${error.code}）`];
    if (Array.isArray(error.details)) {
      for (const item of error.details) lines.push(`· ${typeof item === "string" ? item : JSON.stringify(item)}`);
    } else if (typeof error.details === "string") {
      lines.push(`· ${error.details}`);
    }
    return lines.join("\n");
  }
  return error instanceof Error ? error.message : "未知错误";
}

export function StatusBadge({ status }: { status: RequirementStatus }): ReactElement {
  return <span className={`badge badge-${status}`}>{REQUIREMENT_STATUS_TEXT[status]}</span>;
}

export function RunBadge({ status }: { status: RunStatus }): ReactElement {
  return <span className={`badge badge-run-${status}`}>{RUN_STATUS_TEXT[status]}</span>;
}

export function ErrorBanner({
  message,
  onClose,
}: {
  message: string | null;
  onClose?: () => void;
}): ReactElement | null {
  if (message === null || message === "") return null;
  return (
    <div className="banner banner-error" role="alert">
      <span className="banner-text">{message}</span>
      {onClose !== undefined ? (
        <button type="button" className="banner-close" onClick={onClose} aria-label="关闭提示">
          ×
        </button>
      ) : null}
    </div>
  );
}

export function NoticeBanner({ message }: { message: string | null }): ReactElement | null {
  if (message === null || message === "") return null;
  return (
    <div className="banner banner-notice">
      <span className="banner-text">{message}</span>
    </div>
  );
}

export function Section({
  title,
  extra,
  children,
}: {
  title: string;
  extra?: ReactNode;
  children: ReactNode;
}): ReactElement {
  return (
    <section className="section">
      <header className="section-head">
        <h2>{title}</h2>
        {extra !== undefined ? <div className="section-extra">{extra}</div> : null}
      </header>
      {children}
    </section>
  );
}

export function Empty({ text }: { text: string }): ReactElement {
  return <div className="empty">{text}</div>;
}
