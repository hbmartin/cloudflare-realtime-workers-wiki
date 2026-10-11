import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { AiConversation } from "../shared/ai";
import { api, apiErrorMessage } from "./api";

const HISTORY_DELETED_EVENT = "notes:writing-history-deleted";
type HistoryDeleted = { kind: "single"; id: string; pageId: string } | { kind: "all" };

export function WritingHistory({
  pageId,
  onOpen,
  refreshVersion = 0,
}: {
  pageId?: string;
  onOpen: (conversation: AiConversation) => void;
  refreshVersion?: number;
}) {
  const [query, setQuery] = useState("");
  const [deleting, setDeleting] = useState(false),
    [deletionState, setDeletionState] = useState({ pageId, query, revision: 0, error: "" });
  if (deletionState.pageId !== pageId || deletionState.query !== query)
    setDeletionState({ pageId, query, revision: deletionState.revision + 1, error: "" });
  const deletionError = deletionState.error;
  const [history, setHistory] = useState({
    pageId,
    query,
    refreshVersion,
    items: [] as AiConversation[],
    cursor: null as string | null,
    error: "",
    loading: true,
  });
  const sameScope = history.pageId === pageId && history.query === query;
  const items = sameScope ? history.items : [],
    cursor = sameScope ? history.cursor : null,
    error = sameScope ? history.error : "",
    loading = deleting || history.loading || !sameScope || history.refreshVersion !== refreshVersion;
  const pagination = useRef({ pageId, query, pages: 1, requestedPages: 1 }),
    request = useRef<AbortController | null>(null),
    reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null),
    deletion = useRef(false),
    mounted = useRef(true);
  const load = useCallback(
    async (appendCursor?: string) => {
      if (reloadTimer.current !== null) clearTimeout(reloadTimer.current);
      reloadTimer.current = null;
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      if (appendCursor) pagination.current.requestedPages = pagination.current.pages + 1;
      setHistory((current) => {
        const keepScope = current.pageId === pageId && current.query === query;
        return {
          pageId,
          query,
          refreshVersion,
          items: keepScope ? current.items : [],
          cursor: keepScope ? current.cursor : null,
          error: "",
          loading: true,
        };
      });
      try {
        const refreshedItems: AiConversation[] = [];
        let nextCursor = appendCursor ?? null,
          pages = 0;
        const depth = appendCursor ? 1 : pagination.current.requestedPages;
        do {
          const params = new URLSearchParams({
            q: query,
            ...(pageId ? { pageId } : {}),
            ...(nextCursor ? { cursor: nextCursor } : {}),
          });
          const result = await api<{ conversations: AiConversation[]; nextCursor: string | null }>(
            `/api/ai/conversations?${params}`,
            { signal: controller.signal },
          );
          if (controller.signal.aborted) return;
          refreshedItems.push(...result.conversations);
          nextCursor = result.nextCursor;
          pages++;
        } while (nextCursor && pages < depth);
        setHistory((current) => ({
          ...current,
          items: [
            ...new Map(
              (appendCursor ? [...current.items, ...refreshedItems] : refreshedItems).map((item) => [item.id, item]),
            ).values(),
          ],
          cursor: nextCursor,
          error: "",
        }));
        pagination.current.pages = appendCursor ? pagination.current.pages + pages : pages;
        pagination.current.requestedPages = pagination.current.pages;
      } catch (cause) {
        if (!controller.signal.aborted) {
          if (appendCursor) pagination.current.requestedPages = pagination.current.pages;
          setHistory((current) => ({
            ...current,
            error: apiErrorMessage(
              cause,
              appendCursor ? "More conversations could not be loaded." : "History needs a network connection.",
            ),
          }));
        }
      } finally {
        if (request.current === controller) {
          request.current = null;
          setHistory((current) => ({ ...current, loading: false }));
        }
      }
    },
    [pageId, query, refreshVersion],
  );
  useLayoutEffect(() => {
    mounted.current = true;
    if (pagination.current.pageId !== pageId || pagination.current.query !== query)
      pagination.current = { pageId, query, pages: 1, requestedPages: 1 };
    const refresh = (event: Event) => {
      const { detail } = event as CustomEvent<HistoryDeleted>;
      if (!pageId || detail.kind === "all" || detail.pageId === pageId) void load();
    };
    window.addEventListener(HISTORY_DELETED_EVENT, refresh);
    reloadTimer.current = setTimeout(() => void load(), 200);
    return () => {
      mounted.current = false;
      window.removeEventListener(HISTORY_DELETED_EVENT, refresh);
      if (reloadTimer.current !== null) clearTimeout(reloadTimer.current);
      reloadTimer.current = null;
      request.current?.abort();
      request.current = null;
    };
  }, [load, pageId, query]);
  async function remove(conversation?: AiConversation) {
    if (loading || request.current || deletion.current) return;
    const revision = deletionState.revision;
    const detail: HistoryDeleted = conversation
      ? { kind: "single", id: conversation.id, pageId: conversation.pageId }
      : { kind: "all" };
    deletion.current = true;
    setDeleting(true);
    setDeletionState((current) => ({ ...current, error: "" }));
    try {
      await api(`/api/ai/conversations${conversation ? `/${conversation.id}` : ""}`, { method: "DELETE" });
      window.dispatchEvent(new CustomEvent<HistoryDeleted>(HISTORY_DELETED_EVENT, { detail }));
    } catch (cause) {
      if (mounted.current)
        setDeletionState((current) =>
          current.revision === revision
            ? { ...current, error: apiErrorMessage(cause, "History could not be deleted.") }
            : current,
        );
    } finally {
      deletion.current = false;
      if (mounted.current) setDeleting(false);
    }
  }
  function more() {
    if (cursor && !loading && !request.current) void load(cursor);
  }
  return (
    <section className="writing-history" aria-label="Private writing history">
      <h2>{pageId ? "This document's writing history" : "My writing library"}</h2>
      <p className="muted">Private to you. Conversations expire after 30 days without opening or writing.</p>
      <label>
        Search your conversations
        <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} />
      </label>
      {deletionError && (
        <div role="alert" className="form-error">
          {deletionError}
          <button
            aria-label="Dismiss deletion error"
            onClick={() => setDeletionState((current) => ({ ...current, error: "" }))}
          >
            Dismiss
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {loading && <output aria-live="polite">Loading conversations…</output>}
      {!loading && !items.length && <p>No conversations found.</p>}
      <ul>
        {items.map((item) => (
          <li key={item.id}>
            <button disabled={item.locked} onClick={() => onOpen(item)}>
              {item.title}
            </button>
            {item.locked && <span> Access to a source is unavailable.</span>}
            <small>Expires {new Date(item.expiresAt).toLocaleDateString()}</small>
            <button disabled={loading} aria-label={`Delete ${item.title}`} onClick={() => void remove(item)}>
              Delete
            </button>
          </li>
        ))}
      </ul>
      {cursor && (
        <button disabled={loading} onClick={more}>
          Load more conversations
        </button>
      )}
      {!pageId && (
        <button
          className="text-danger"
          disabled={loading || !items.length}
          onClick={() => {
            if (confirm("Delete all your writing conversations?")) void remove();
          }}
        >
          Delete all my conversations
        </button>
      )}
    </section>
  );
}
