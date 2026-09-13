import { useEffect, useRef, useState } from "react";
import { isJobActive } from "../shared/job-state";
import type { ImportPreview, Job, Space } from "../shared/types";

const DATE_TIME_FORMAT = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
type ImportGroup = NonNullable<ImportPreview["groups"]>[number];

function defaultGroupSpace(group: ImportGroup, spaces: Space[], jobSpaceId: string | null) {
  const exact = spaces.find(
    (space) =>
      space.name.toLocaleLowerCase() === group.name.toLocaleLowerCase() &&
      space.visibility === group.suggestedVisibility,
  );
  if (exact) return exact.id;
  const uploadSpace = spaces.find((space) => space.id === jobSpaceId);
  if (group.key === "Imported") return uploadSpace?.id ?? "";
  if (group.suggestedVisibility !== "workspace") return "";
  return uploadSpace?.visibility === "workspace" ? uploadSpace.id : "";
}

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

function ImportConfirmation({
  job,
  spaces = [],
  pending,
  onConfirm,
}: {
  job: Job;
  spaces?: Space[];
  pending: boolean;
  onConfirm: (job: Job, groupSpaceIds: Record<string, string>) => void;
}) {
  const preview = job.result?.preview;
  const [mapping, setMapping] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      (preview?.groups ?? []).map((group) => [group.key, defaultGroupSpace(group, spaces, job.spaceId)]),
    ),
  );
  const touchedGroups = useRef(new Set<string>());
  useEffect(() => {
    setMapping((current) => {
      let changed = false;
      const next = { ...current };
      for (const group of preview?.groups ?? []) {
        if (touchedGroups.current.has(group.key) || next[group.key]) continue;
        const destination = defaultGroupSpace(group, spaces, job.spaceId);
        if (!destination) continue;
        next[group.key] = destination;
        changed = true;
      }
      return changed ? next : current;
    });
  }, [job.spaceId, preview, spaces]);
  if (!preview) return null;
  const groups = preview.groups ?? [];
  const incomplete = groups.some((group) => !mapping[group.key]);
  return (
    <div className="import-confirmation">
      <dl className="import-preview">
        <div>
          <dt>Pages</dt>
          <dd>{preview.pages}</dd>
        </div>
        <div>
          <dt>Roots</dt>
          <dd>{preview.roots ?? preview.pages}</dd>
        </div>
        <div>
          <dt>Nested</dt>
          <dd>{preview.nested ?? 0}</dd>
        </div>
        <div>
          <dt>Tables</dt>
          <dd>{preview.tables}</dd>
        </div>
        <div>
          <dt>Assets</dt>
          <dd>{preview.assets}</dd>
        </div>
        <div>
          <dt>Links fixed</dt>
          <dd>{preview.resolvedLinks ?? 0}</dd>
        </div>
        <div>
          <dt>Links missing</dt>
          <dd>{preview.unresolvedLinks ?? 0}</dd>
        </div>
        <div>
          <dt>Max depth</dt>
          <dd>{preview.maxDepth ?? 0}</dd>
        </div>
      </dl>
      {groups.map((group) => (
        <label className="import-space-mapping" key={group.key}>
          <span>
            {group.name} ({group.pages} pages, {group.roots} roots)
          </span>
          <select
            aria-label={`Destination space for ${group.name}`}
            value={mapping[group.key] ?? ""}
            onChange={(event) => {
              touchedGroups.current.add(group.key);
              setMapping((current) => ({ ...current, [group.key]: event.target.value }));
            }}
          >
            <option value="">Choose a space</option>
            {spaces.map((space) => (
              <option value={space.id} key={space.id}>
                {space.name} ({space.visibility === "private" ? "Private" : "Workspace"})
              </option>
            ))}
          </select>
        </label>
      ))}
      <button className="primary-small" disabled={pending || incomplete} onClick={() => onConfirm(job, mapping)}>
        {pending ? "Starting…" : "Confirm import"}
      </button>
    </div>
  );
}

export function ActivitiesTray({
  jobs,
  spaces = [],
  loading,
  error,
  pendingJobId,
  onClose,
  onRefresh,
  onCancel,
  onCleanup,
  onRetry,
  onConfirm,
  onOpenResult,
}: {
  jobs: Job[];
  spaces?: Space[];
  loading: boolean;
  error: string;
  pendingJobId: string | null;
  onClose: () => void;
  onRefresh: () => void;
  onCancel: (job: Job) => void;
  onCleanup: (job: Job) => void;
  onRetry: (job: Job) => void;
  onConfirm: (job: Job, groupSpaceIds: Record<string, string>) => void;
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
              const active = isJobActive(job);
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
                  {job.status === "awaiting_confirmation" && job.result?.preview && (
                    <ImportConfirmation job={job} spaces={spaces} pending={pending} onConfirm={onConfirm} />
                  )}
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
                      {job.cleanupPending ? (
                        <button className="quiet-button" disabled={pending} onClick={() => onCleanup(job)}>
                          {pending ? "Cleaning up…" : "Retry cleanup"}
                        </button>
                      ) : active ? (
                        <button className="quiet-button" disabled={pending} onClick={() => onCancel(job)}>
                          {pending ? "Canceling…" : "Cancel"}
                        </button>
                      ) : null}
                      {(job.status === "failed" || job.status === "canceled") && !job.cleanupPending && (
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
