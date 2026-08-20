import { useEffect, useState } from "react";
import type { Backlink } from "../shared/types";
import { api } from "./api";

export function BacklinksPanel({
  pageId,
  revision,
  onSelect,
}: {
  pageId: string;
  revision: number;
  onSelect: (pageId: string) => void;
}) {
  const [result, setResult] = useState<{
    pageId: string;
    revision: number;
    backlinks: Backlink[];
    error: string;
  }>(() => ({ pageId, revision, backlinks: [], error: "" }));
  const currentResult = result.pageId === pageId && result.revision === revision;
  const backlinks = currentResult ? result.backlinks : [];
  const error = currentResult ? result.error : "";
  useEffect(() => {
    let active = true;
    void api<{ backlinks: Backlink[] }>(`/api/pages/${pageId}/backlinks`)
      .then((data) => {
        if (active) setResult({ pageId, revision, backlinks: data.backlinks, error: "" });
      })
      .catch(() => {
        if (active) {
          setResult({ pageId, revision, backlinks: [], error: "Backlinks could not be loaded. Try again." });
        }
      });
    return () => {
      active = false;
    };
  }, [pageId, revision]);
  return (
    <aside className="side-panel backlinks-panel">
      <h2>Backlinks</h2>
      <p className="muted">Pages that mention this page.</p>
      {error && <p className="form-error">{error}</p>}
      <div className="backlink-list">
        {backlinks.map((backlink) => (
          <button key={backlink.page.id} onClick={() => onSelect(backlink.page.id)}>
            <strong>
              {backlink.page.icon ?? "□"} {backlink.page.title}
            </strong>
            <span>{backlink.excerpt || "No preview yet."}</span>
          </button>
        ))}
        {!error && !backlinks.length && <p className="empty-copy">No pages link here yet.</p>}
      </div>
    </aside>
  );
}
