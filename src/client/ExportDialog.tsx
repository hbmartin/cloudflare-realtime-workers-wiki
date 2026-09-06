import { useEffect, useState, type FormEvent } from "react";
import type { ExportFormat, Job, Page } from "../shared/types";
import { api, apiErrorMessage, json } from "./api";

export function ExportDialog({
  page,
  onClose,
  onQueued,
}: {
  page: Page;
  onClose: () => void;
  onQueued: (job: Job) => void;
}) {
  const [format, setFormat] = useState<ExportFormat>("markdown");
  const [portable, setPortable] = useState(true);
  const [pdfAvailable, setPdfAvailable] = useState(false);
  const [statusLoaded, setStatusLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    void api<{ pdf: { available: boolean } }>("/api/integrations/status", { signal: controller.signal })
      .then((status) => {
        setPdfAvailable(status.pdf.available);
        setStatusLoaded(true);
      })
      .catch(() => setStatusLoaded(true));
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      controller.abort();
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await api<{ job: Job }>(`/api/pages/${encodeURIComponent(page.id)}/exports`, {
        method: "POST",
        body: json({ format, portable: format === "pdf" ? false : portable }),
      });
      onQueued(result.job);
    } catch (cause) {
      setError(apiErrorMessage(cause, "The export could not be started."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="activity-scrim" aria-hidden="true" onClick={onClose} />
      <dialog className="export-dialog" open aria-modal="true" aria-labelledby="export-title">
        <header>
          <div>
            <p className="eyebrow">Download a copy</p>
            <h2 id="export-title">Export “{page.title}”</h2>
          </div>
          <button className="icon-button" aria-label="Close export" onClick={onClose} autoFocus>
            ×
          </button>
        </header>
        <form onSubmit={(event) => void submit(event)}>
          <fieldset>
            <legend>Format</legend>
            <label htmlFor="export-format-markdown">
              <input
                id="export-format-markdown"
                type="radio"
                name="format"
                value="markdown"
                checked={format === "markdown"}
                onChange={() => setFormat("markdown")}
              />
              <strong>Markdown</strong>
              <small>Portable plain text for other editors</small>
            </label>
            <label htmlFor="export-format-html">
              <input
                id="export-format-html"
                type="radio"
                name="format"
                value="html"
                checked={format === "html"}
                onChange={() => setFormat("html")}
              />
              <strong>HTML</strong>
              <small>Sanitized, styled web page</small>
            </label>
            <label htmlFor="export-format-pdf">
              <input
                id="export-format-pdf"
                type="radio"
                name="format"
                value="pdf"
                checked={format === "pdf"}
                disabled={!statusLoaded || !pdfAvailable}
                onChange={() => setFormat("pdf")}
              />
              <strong>PDF</strong>
              <small>{pdfAvailable ? "Print-ready single file" : "Unavailable until Browser Run is configured"}</small>
            </label>
          </fieldset>
          {format !== "pdf" && (
            <label className="portable-option" htmlFor="export-portable">
              <input
                id="export-portable"
                type="checkbox"
                checked={portable}
                onChange={(event) => setPortable(event.target.checked)}
              />
              <strong>Include attachments in a ZIP</strong>
              <small>Rewrites page links to portable relative asset paths.</small>
            </label>
          )}
          {error && <p className="form-error">{error}</p>}
          <footer>
            <button type="button" className="quiet-button" onClick={onClose}>
              Cancel
            </button>
            <button className="primary-small" disabled={busy}>
              {busy ? "Starting…" : "Start export"}
            </button>
          </footer>
        </form>
      </dialog>
    </>
  );
}
