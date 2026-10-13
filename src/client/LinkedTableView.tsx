import { useContext, useEffect, useState } from "react";
import { EditorFeatureContext } from "./editor-feature-context";
import { CollaborativeTablePage } from "./CollaborativeTablePage";
import { api, apiErrorMessage } from "./api";
import { useNearViewport } from "./near-viewport";
import type { SearchTitleSuggestion } from "../shared/types";
import { RenderBoundary } from "./RenderBoundary";

export function LinkedTableView({
  tablePageId,
  viewId,
  title,
  editable,
  update,
}: {
  tablePageId: string;
  viewId: string;
  title: string;
  editable: boolean;
  update: (props: { tablePageId: string; viewId: string; title: string }) => void;
}) {
  const context = useContext(EditorFeatureContext);
  const { ref: viewportRef, ready } = useNearViewport();
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<SearchTitleSuggestion[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    if (tablePageId || !query.trim() || !editable) return undefined;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void api<{ suggestions: SearchTitleSuggestion[] }>(
        `/api/search/titles?q=${encodeURIComponent(query)}&kind=table&limit=8`,
        { signal: controller.signal },
      )
        .then((result) => {
          if (!controller.signal.aborted) {
            setSuggestions(result.suggestions);
            setError("");
          }
        })
        .catch((cause) => {
          if (!controller.signal.aborted) setError(apiErrorMessage(cause, "Tables could not be loaded."));
        });
    }, 150);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [tablePageId, query, editable]);
  return (
    <section
      className="editor-linked-table"
      contentEditable={false}
      ref={viewportRef}
      aria-label={title || "Linked table view"}
    >
      {!tablePageId ? (
        editable ? (
          <>
            <label>
              Find a table
              <input aria-label="Find a table" value={query} onChange={(event) => setQuery(event.target.value)} />
            </label>
            {query.trim() &&
              suggestions.map(({ page }) => (
                <button
                  type="button"
                  key={page.id}
                  onClick={() => update({ tablePageId: page.id, viewId: "", title: page.title })}
                >
                  {page.title}
                </button>
              ))}
          </>
        ) : (
          <p>Linked table unavailable.</p>
        )
      ) : (
        <>
          <a href={`/?page=${encodeURIComponent(tablePageId)}`}>{title || "Open source table"}</a>
          {editable && (
            <button type="button" onClick={() => update({ tablePageId: "", viewId: "", title: "Linked table" })}>
              Change source table
            </button>
          )}
          {context && ready ? (
            <RenderBoundary resetKey={`${tablePageId}:${viewId}`}>
              <CollaborativeTablePage
                key={`${tablePageId}:${viewId}`}
                page={{ id: tablePageId, title, taskList: false }}
                member={editable ? context.member : { ...context.member, role: "viewer" }}
                onSelectPage={context.onSelectPage}
                queryBase={`/api/pages/${encodeURIComponent(context.hostId)}/linked-tables/${encodeURIComponent(tablePageId)}`}
                initialViewId={viewId}
                onViewChanged={(next) => {
                  if (editable) update({ tablePageId, viewId: next, title });
                }}
                embedded
              />
            </RenderBoundary>
          ) : (
            <p className="diagram-placeholder">Table preview</p>
          )}
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
