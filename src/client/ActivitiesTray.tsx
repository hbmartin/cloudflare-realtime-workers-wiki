import { useEffect, useRef } from "react";
import type { Job } from "../shared/types";

const ACTIVE_STATUSES = new Set<Job["status"]>(["queued", "running", "awaiting_confirmation", "canceling"]);
const DATE_TIME_FORMAT = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

function jobTitle(job: Job) {
  return {
    import: "Import",
    export: "Export",
    template_clone: "Template copy",
    comment_migration: "Comment migration",
    search_reindex: "Search reindex",
  }[job.type];
}

function timestamp(value: number) {
  return DATE_TIME_FORMAT.format(value);
}

export function ActivitiesTray({
  jobs,
  loading,
  error,
  pendingJobId,
  onClose,
  onRefresh,
  onCancel,
  onRetry,
  onOpenResult,
}: {
  jobs: Job[];
  loading: boolean;
  error: string;
  pendingJobId: string | null;
  onClose: () => void;
  onRefresh: () => void;
  onCancel: (job: Job) => void;
  onRetry: (job: Job) => void;
  onOpenResult: (job: Job) => void;
}) {
  const closeButton = useRef<HTMLButtonElement>(null);
  const tray = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButton.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab" || !tray.current) return;
      const controls = Array.from(
        tray.current.querySelectorAll<HTMLElement>(
          "button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled)",
        ),
      );
      if (!controls.length) return;
      const first = controls[0]!;
      const last = controls.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.setTimeout(() => {
        if (previousFocus?.isConnected) previousFocus.focus();
      });
    };
  }, [onClose]);

  return (
    <>
      <div className="activity-scrim" aria-hidden="true" onClick={onClose} />
      <dialog ref={tray} className="activities-tray" open aria-modal="true" aria-labelledby="activities-title">
        <header>
          <div>
            <p className="eyebrow">Background work</p>
            <h2 id="activities-title">Activities</h2>
          </div>
          <button ref={closeButton} className="icon-button" aria-label="Close activities" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="activities-toolbar">
          <span>{jobs.length ? `${jobs.length} recent job${jobs.length === 1 ? "" : "s"}` : "Recent jobs"}</span>
          <button className="quiet-button" disabled={loading} onClick={onRefresh}>
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
        {error ? (
          <div className="activity-error" role="alert">
            <p>{error}</p>
            <button className="quiet-button" onClick={onRefresh}>
              Try again
            </button>
          </div>
        ) : jobs.length ? (
          <ol className="activity-list">
            {jobs.map((job) => {
              const active = ACTIVE_STATUSES.has(job.status);
              const total = Math.max(0, job.progress.total);
              const percent = total
                ? Math.min(100, Math.round((job.progress.current / total) * 100))
                : active
                  ? 8
                  : 100;
              const pending = pendingJobId === job.id;
              return (
                <li key={job.id}>
                  <div className="activity-heading">
                    <strong>{jobTitle(job)}</strong>
                    <span className={`job-status status-${job.status}`}>{job.status.replaceAll("_", " ")}</span>
                  </div>
                  <p>{job.progress.label || "Waiting to start"}</p>
                  {active && (
                    <progress
                      className="job-progress"
                      aria-label={`${jobTitle(job)} progress`}
                      max={100}
                      value={percent}
                    />
                  )}
                  {job.error && <p className="activity-job-error">{job.error.message}</p>}
                  {job.warnings.map((warning) => (
                    <p className="activity-warning" key={warning}>
                      {warning}
                    </p>
                  ))}
                  <div className="activity-meta">
                    <time dateTime={new Date(job.createdAt).toISOString()}>{timestamp(job.createdAt)}</time>
                    <span className="activity-actions">
                      {job.status === "succeeded" && job.result?.pageId && (
                        <button className="quiet-button" disabled={pending} onClick={() => onOpenResult(job)}>
                          Open page
                        </button>
                      )}
                      {job.hasDownload && (
                        <a className="quiet-button" href={`/api/jobs/${encodeURIComponent(job.id)}/download`}>
                          Download
                        </a>
                      )}
                      {active && job.status !== "canceling" && (
                        <button className="quiet-button" disabled={pending} onClick={() => onCancel(job)}>
                          {pending ? "Canceling…" : "Cancel"}
                        </button>
                      )}
                      {(job.status === "failed" || job.status === "canceled") && (
                        <button className="quiet-button" disabled={pending} onClick={() => onRetry(job)}>
                          {pending ? "Retrying…" : "Retry"}
                        </button>
                      )}
                    </span>
                  </div>
                </li>
              );
            })}
          </ol>
        ) : (
          <div className="activity-empty">
            <span aria-hidden="true">↻</span>
            <h3>No background work yet</h3>
            <p>Imports, exports, templates, and maintenance jobs will appear here.</p>
          </div>
        )}
      </dialog>
    </>
  );
}
