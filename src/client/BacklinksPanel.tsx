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
  const [backlinks, setBacklinks] = useState<Backlink[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setError("");
    setBacklinks([]);
    void api<{ backlinks: Backlink[] }>(`/api/pages/${pageId}/backlinks`)
      .then((data) => {
        if (active) setBacklinks(data.backlinks);
      })
      .catch(() => {
        if (active) setError("Backlinks could not be loaded. Try again.");
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
