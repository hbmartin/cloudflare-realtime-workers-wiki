import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AiConversation } from "../shared/ai";
import { api, apiErrorMessage } from "./api";

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
    [deletionError, setDeletionError] = useState("");
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
    error = deletionError || (sameScope ? history.error : ""),
    loading = deleting || history.loading || !sameScope || history.refreshVersion !== refreshVersion;
  const pagination = useRef({ pageId, query, pages: 1 }),
    request = useRef<AbortController | null>(null),
    deletion = useRef(false),
    mounted = useRef(true);
  const load = useCallback(
    async (appendCursor?: string) => {
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      if (pagination.current.pageId !== pageId || pagination.current.query !== query)
        pagination.current = { pageId, query, pages: 1 };
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
        const depth = appendCursor ? 1 : pagination.current.pages;
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
      } catch (cause) {
        if (!controller.signal.aborted)
          setHistory((current) => ({
            ...current,
            error: apiErrorMessage(
              cause,
              appendCursor ? "More conversations could not be loaded." : "History needs a network connection.",
            ),
          }));
      } finally {
        if (request.current === controller) {
          request.current = null;
          setHistory((current) => ({ ...current, loading: false }));
        }
      }
    },
    [pageId, query, refreshVersion],
  );
  const latestLoad = useRef(load);
  useLayoutEffect(() => {
    latestLoad.current = load;
  }, [load]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => void load(), 200);
    return () => {
      clearTimeout(timer);
      request.current?.abort();
      request.current = null;
    };
  }, [load]);
  async function remove(id?: string) {
    if (loading || request.current || deletion.current) return;
    deletion.current = true;
    setDeleting(true);
    setDeletionError("");
    try {
      await api(`/api/ai/conversations${id ? `/${id}` : ""}`, { method: "DELETE" });
      if (mounted.current) await latestLoad.current();
    } catch (cause) {
      if (mounted.current) setDeletionError(apiErrorMessage(cause, "History could not be deleted."));
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
            <button disabled={loading} aria-label={`Delete ${item.title}`} onClick={() => void remove(item.id)}>
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
