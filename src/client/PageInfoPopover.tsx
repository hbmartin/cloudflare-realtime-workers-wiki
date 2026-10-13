import { useEffect, useRef, useState } from "react";
import { api, apiErrorMessage } from "./api";

type PageInfo = {
  id: string;
  createdAt: number;
  updatedAt: number;
  createdBy: { id: string; name: string } | null;
  lastEditedBy: { id: string; name: string } | null;
  contributors: { id: string; name: string; firstEditedAt: number; lastEditedAt: number }[];
  nextCursor: string | null;
  contributorHistorySince: number;
  wordCount: number | null;
  wordCountComplete: boolean;
  contributorHistoryComplete: boolean;
  contributorAttribution: "authenticated_uploaders";
};
export function PageInfoPopover({ pageId }: { pageId: string }) {
  return <PageInfoContent key={pageId} pageId={pageId} />;
}
function date(value: number) {
  return new Date(value).toLocaleString();
}
function PageInfoContent({ pageId }: { pageId: string }) {
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<PageInfo | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const load = async (cursor?: string) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError("");
    try {
      const result = await api<PageInfo>(
        `/api/pages/${encodeURIComponent(pageId)}/info${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
        { signal: controller.signal },
      );
      if (!controller.signal.aborted)
        setInfo((previous) => ({
          ...result,
          contributors:
            cursor && previous
              ? [
                  ...previous.contributors,
                  ...result.contributors.filter(
                    (person) => !previous.contributors.some((existing) => existing.id === person.id),
                  ),
                ]
              : result.contributors,
        }));
    } catch (cause) {
      if (!controller.signal.aborted) setError(apiErrorMessage(cause, "Page information could not be loaded."));
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  const close = () => {
    request.current?.abort();
    setBusy(false);
    setOpen(false);
  };
  return (
    <div className="page-info-popover">
      <button
        type="button"
        onClick={() => {
          if (open) close();
          else {
            setOpen(true);
            void load();
          }
        }}
        aria-expanded={open}
      >
        Page info
      </button>
      {open && (
        <dialog
          open
          aria-label="Page info"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              close();
            }
          }}
        >
          <button type="button" onClick={close}>
            Close page info
          </button>
          {info && (
            <>
              <p>
                Created {date(info.createdAt)} by {info.createdBy?.name ?? "Unknown member"}
              </p>
              <p>
                Last edited {date(info.updatedAt)} by {info.lastEditedBy?.name ?? "Unknown member"}
              </p>
              {info.wordCount !== null && (
                <p>
                  {info.wordCountComplete ? "" : "At least "}
                  {info.wordCount.toLocaleString()} words
                </p>
              )}
              <h3>Contributors</h3>
              <ul>
                {info.contributors.map((person) => (
                  <li key={person.id}>
                    {person.name} · {date(person.lastEditedAt)}
                  </li>
                ))}
              </ul>
              <small>
                {info.contributorHistoryComplete
                  ? "Contributor history is available since"
                  : "Partial contributor history, available since"}{" "}
                {date(info.contributorHistorySince)}.
              </small>
              <small>Offline edits are attributed to the member who synced them.</small>
              {info.nextCursor && (
                <button type="button" disabled={busy} onClick={() => void load(info.nextCursor!)}>
                  More contributors
                </button>
              )}
            </>
          )}
          {busy && <output>Loading page information…</output>}
          {error && (
            <p role="alert">
              {error}
              <button type="button" onClick={() => void load()}>
                Retry page info
              </button>
            </p>
          )}
        </dialog>
      )}
    </div>
  );
}
