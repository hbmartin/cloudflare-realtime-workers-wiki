import { useCallback, useEffect, useState } from "react";
import type { AiConversation } from "../shared/ai";
import { api, apiErrorMessage } from "./api";

export function WritingHistory({
  pageId,
  onOpen,
}: {
  pageId?: string;
  onOpen: (conversation: AiConversation) => void;
}) {
  const [query, setQuery] = useState(""),
    [items, setItems] = useState<AiConversation[]>([]),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      try {
        const params = new URLSearchParams({ q: query, ...(pageId ? { pageId } : {}) });
        const result = await api<{ conversations: AiConversation[]; nextCursor: string | null }>(
          `/api/ai/conversations?${params}`,
          { signal },
        );
        setItems(result.conversations);
        setCursor(result.nextCursor);
        setError("");
      } catch (cause) {
        if (!signal?.aborted) setError(apiErrorMessage(cause, "History needs a network connection."));
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [pageId, query],
  );
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => void load(controller.signal), 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [load]);
  async function remove(id?: string) {
    try {
      await api(`/api/ai/conversations${id ? `/${id}` : ""}`, { method: "DELETE" });
      await load();
    } catch (cause) {
      setError(apiErrorMessage(cause, "History could not be deleted."));
    }
  }
  async function more() {
    if (!cursor) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({ q: query, cursor, ...(pageId ? { pageId } : {}) });
      const result = await api<{ conversations: AiConversation[]; nextCursor: string | null }>(
        `/api/ai/conversations?${params}`,
      );
      setItems((current) => [...current, ...result.conversations]);
      setCursor(result.nextCursor);
    } catch (cause) {
      setError(apiErrorMessage(cause, "More conversations could not be loaded."));
    } finally {
      setLoading(false);
    }
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
            <button aria-label={`Delete ${item.title}`} onClick={() => void remove(item.id)}>
              Delete
            </button>
          </li>
        ))}
      </ul>
      {cursor && (
        <button disabled={loading} onClick={() => void more()}>
          Load more conversations
        </button>
      )}
      {!pageId && (
        <button
          className="text-danger"
          disabled={!items.length}
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
