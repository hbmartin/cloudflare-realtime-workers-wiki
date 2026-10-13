import { useEffect, useState } from "react";
import { subscribeCardPreview, type CardPreviewState } from "./card-preview-pool";
import { useNearViewport } from "./near-viewport";

export function DiagramCard({
  account,
  pageId,
  viewId,
  alias,
}: {
  account: string;
  pageId: string;
  viewId: string | null;
  alias: string;
}) {
  const { ref: viewportRef, ready } = useNearViewport();
  const key = `${account}:${pageId}:${viewId ?? ""}`;
  const [loaded, setLoaded] = useState<{ key: string; state: CardPreviewState } | null>(null);
  const state: CardPreviewState = loaded?.key === key && ready ? loaded.state : { status: "loading", preview: null };
  useEffect(() => {
    if (!ready) return undefined;
    return subscribeCardPreview(account, pageId, viewId, (next) => setLoaded({ key, state: next }));
  }, [account, pageId, viewId, ready, key]);
  const preview = state.preview;
  return (
    <div className="diagram-card-preview nodrag nopan nowheel" ref={viewportRef}>
      {preview ? (
        <>
          <a
            href={`/?page=${encodeURIComponent(pageId)}${viewId ? `&view=${encodeURIComponent(viewId)}` : ""}`}
            onClick={(event) => event.stopPropagation()}
          >
            {alias || preview.page.title || "Untitled"}
          </a>
          {preview.table ? (
            <>
              <small>{preview.table.name}</small>
              <table aria-label="Table view preview">
                <thead>
                  <tr>
                    {preview.table.columns.slice(0, 3).map((column) => (
                      <th key={column.id}>{column.name}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.table.rows.map((row) => (
                    <tr key={row.id}>
                      {preview.table!.columns.slice(0, 3).map((column) => (
                        <td key={column.id}>{String(row.cells[column.id] ?? "")}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {preview.table.hasMore && <small>More rows in source view</small>}
            </>
          ) : (
            <p>{preview.text || "No text preview."}</p>
          )}
        </>
      ) : (
        <p>
          {state.status === "unavailable"
            ? "Linked page unavailable."
            : ready
              ? "Loading linked page…"
              : alias || "Linked page"}
        </p>
      )}
    </div>
  );
}
