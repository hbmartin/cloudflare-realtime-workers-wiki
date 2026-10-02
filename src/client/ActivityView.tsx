import { useCallback, useEffect, useRef, useState } from "react";
import { ACTIVITY_LABELS, CHANNEL_EVENT_TYPES, type ActivityItem, type ActivityResponse } from "../shared/activity";
import { TASK_STATUS_LABELS } from "../shared/tasks";
import type { Page, Space } from "../shared/types";
import { api, apiErrorMessage } from "./api";

export function ActivityView({
  spaces,
  pages,
  onSelect,
}: {
  spaces: Space[];
  pages: Page[];
  onSelect: (id: string) => void;
}) {
  const [mapping, setMapping] = useState(() => new URLSearchParams(location.search).get("mapping") ?? "");
  const [mode, setMode] = useState<"activity" | "open">("activity");
  const [space, setSpace] = useState("");
  const [page, setPage] = useState("");
  const [event, setEvent] = useState("");
  const [days, setDays] = useState(mapping ? "1" : "7");
  const [result, setResult] = useState<ActivityResponse>({ items: [], nextCursor: null });
  const [overview, setOverview] = useState<ActivityItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef(0);
  const load = useCallback(
    async (cursor?: string) => {
      const current = ++request.current;
      setBusy(true);
      setError("");
      if (!cursor) {
        setResult({ items: [], nextCursor: null });
        setOverview([]);
      }
      try {
        const q = new URLSearchParams({ mode, from: String(Date.now() - Number(days) * 86400_000) });
        if (space) q.set("space", space);
        if (page) q.set("page", page);
        if (event) q.set("event", event);
        if (mapping) q.set("mapping", mapping);
        if (cursor) q.set("cursor", cursor);
        const next = await api<ActivityResponse>(`/api/activity?${q}`);
        if (current !== request.current) return;
        setResult((old) => ({
          items: cursor ? [...old.items, ...next.items] : next.items,
          nextCursor: next.nextCursor,
        }));
        if (mapping && mode === "activity" && !cursor) {
          q.set("mode", "open");
          q.delete("event");
          const open = await api<ActivityResponse>(`/api/activity?${q}`);
          if (current === request.current) setOverview(open.items.slice(0, 10));
        } else if (!mapping || mode === "open") setOverview([]);
      } catch (cause) {
        if (current === request.current) setError(apiErrorMessage(cause, "Activity could not be loaded."));
      } finally {
        if (current === request.current) setBusy(false);
      }
    },
    [mode, days, space, page, event, mapping],
  );
  useEffect(() => {
    const requestState = request;
    const timer = setTimeout(() => void load(), 0);
    return () => {
      clearTimeout(timer);
      requestState.current++;
    };
  }, [load]);
  function entry(item: ActivityItem) {
    return (
      <li key={item.id}>
        <button onClick={() => onSelect(item.pageId)} disabled={item.departure}>
          {item.title}
        </button>
        <p>
          {item.eventType ? ACTIVITY_LABELS[item.eventType] : "No new activity"}
          {item.actorName ? ` · ${item.actorName}` : ""}
          {item.taskStatus ? ` · ${TASK_STATUS_LABELS[item.taskStatus]}` : ""} · {item.unresolvedThreads} unresolved
          threads
        </p>
        {item.excerpt && <p>{item.excerpt}</p>}
        <time dateTime={new Date(item.createdAt).toISOString()}>{new Date(item.createdAt).toLocaleString()}</time>
      </li>
    );
  }
  return (
    <section className="activity-view" aria-label="Workspace activity">
      <h1>Activity</h1>
      {mapping && (
        <p>
          Filtered to a Slack channel mapping.{" "}
          <button
            onClick={() => {
              setMapping("");
              const url = new URL(location.href);
              url.searchParams.delete("mapping");
              history.replaceState(null, "", url);
            }}
          >
            Show all workspace activity
          </button>
        </p>
      )}
      <div role="tablist" aria-label="Activity views">
        <button role="tab" aria-selected={mode === "activity"} onClick={() => setMode("activity")}>
          Activity
        </button>
        <button role="tab" aria-selected={mode === "open"} onClick={() => setMode("open")}>
          Open work
        </button>
      </div>
      <div className="slack-field-grid">
        <label>
          Space
          <select
            value={space}
            onChange={(e) => {
              setSpace(e.target.value);
              setPage("");
            }}
          >
            <option value="">All spaces</option>
            {spaces.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Page
          <select value={page} onChange={(e) => setPage(e.target.value)}>
            <option value="">All pages</option>
            {pages
              .filter((p) => !p.isTemplate && (!space || p.spaceId === space))
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
          </select>
        </label>
        {mode === "activity" && (
          <>
            <label>
              Event
              <select value={event} onChange={(e) => setEvent(e.target.value)}>
                <option value="">All events</option>
                {CHANNEL_EVENT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {ACTIVITY_LABELS[t]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              History
              <select value={days} onChange={(e) => setDays(e.target.value)}>
                <option value="1">Last day</option>
                <option value="7">Last seven days</option>
                <option value="30">Last 30 days</option>
              </select>
            </label>
          </>
        )}
      </div>
      <button disabled={busy} onClick={() => void load()}>
        Refresh
      </button>
      {error && <p role="alert">{error}</p>}
      {busy && <output>Loading activity…</output>}
      {!busy && !result.items.length && !error && (
        <p>{mode === "open" ? "No open work." : "No activity in this period."}</p>
      )}
      <ul className="activity-feed">{result.items.map(entry)}</ul>
      {result.nextCursor && (
        <button disabled={busy} onClick={() => void load(result.nextCursor!)}>
          Load more
        </button>
      )}
      {overview.length > 0 && (
        <section aria-label="Current open work">
          <h2>Current open work</h2>
          <ul className="activity-feed">{overview.map(entry)}</ul>
          <button onClick={() => setMode("open")}>View all open work</button>
        </section>
      )}
    </section>
  );
}
