import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Job, Space } from "../shared/types";
import { api, apiErrorMessage } from "./api";

export function ImportDialog({
  spaces,
  initialSpaceId,
  onClose,
  onQueued,
}: {
  spaces: Space[];
  initialSpaceId: string;
  onClose: () => void;
  onQueued: (job: Job) => void;
}) {
  const [spaceId, setSpaceId] = useState(initialSpaceId);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const closeButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeButton.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onClose]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!file) {
      setError("Choose a Markdown, HTML, or Notion ZIP file.");
      return;
    }
    setBusy(true);
    setError("");
    const form = new FormData();
    form.set("spaceId", spaceId);
    form.set("file", file);
    try {
      const result = await api<{ job: Job }>("/api/import-uploads", { method: "POST", body: form });
      onQueued(result.job);
    } catch (cause) {
      setError(apiErrorMessage(cause, "The import could not be uploaded."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="activity-scrim" aria-hidden="true" onClick={busy ? undefined : onClose} />
      <dialog className="export-dialog import-dialog" open aria-modal="true" aria-labelledby="import-title">
        <header>
          <div>
            <p className="eyebrow">Bring content in</p>
            <h2 id="import-title">Import notes</h2>
          </div>
          <button
            ref={closeButton}
            type="button"
            className="icon-button"
            aria-label="Close import"
            disabled={busy}
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <form onSubmit={(event) => void submit(event)}>
          <label className="import-field" htmlFor="import-file">
            <strong>File</strong>
            <input
              id="import-file"
              type="file"
              required
              accept=".md,.markdown,.html,.htm,.zip,text/markdown,text/html,application/zip"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
            <small>
              Markdown and HTML create one page. Notion ZIP exports can include nested pages, databases, and assets.
            </small>
          </label>
          <label className="import-field" htmlFor="import-space">
            <strong>Destination space</strong>
            <select id="import-space" value={spaceId} onChange={(event) => setSpaceId(event.target.value)}>
              {spaces.map((space) => (
                <option key={space.id} value={space.id} disabled={space.effectiveRole === "viewer"}>
                  {space.name}
                  {space.effectiveRole === "viewer" ? " (read only)" : ""}
                </option>
              ))}
            </select>
          </label>
          <p className="import-note">
            You’ll review page, table, asset, and warning counts before anything becomes visible.
          </p>
          {error && <p className="form-error">{error}</p>}
          <footer>
            <button type="button" className="quiet-button" disabled={busy} onClick={onClose}>
              Cancel
            </button>
            <button className="primary-small" disabled={busy || !file || !spaceId}>
              {busy ? "Uploading…" : "Upload and inspect"}
            </button>
          </footer>
        </form>
      </dialog>
    </>
  );
}
