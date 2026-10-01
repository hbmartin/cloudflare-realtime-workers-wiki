import { useCallback, useEffect, useState } from "react";
import { api, apiErrorMessage } from "./api";

type Channel = { id: string; name: string; private: boolean };
export function SlackChannelPicker() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [selected, setSelected] = useState("");
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async (next?: string) => {
    setBusy(true);
    setError("");
    try {
      const result = await api<{ channels: Channel[]; nextCursor: string | null }>(
        `/api/slack/channel-directory${next ? `?cursor=${encodeURIComponent(next)}` : ""}`,
      );
      setChannels((old) => [...new Map([...old, ...result.channels].map((c) => [c.id, c])).values()]);
      if (result.nextCursor === next) throw new Error("Slack channel pagination did not advance.");
      setCursor(result.nextCursor);
      setLoaded(true);
    } catch (cause) {
      setError(apiErrorMessage(cause, "Slack channels could not be loaded."));
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);
  // Search progressively traverses the whole directory, rather than filtering only page one.
  useEffect(() => {
    if (!query || !loaded || !cursor || busy || error) return undefined;
    const timer = setTimeout(() => void load(cursor), 300);
    return () => clearTimeout(timer);
  }, [query, loaded, cursor, busy, error, load]);
  return (
    <div>
      <label>
        Search Slack channels
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search channel names" />
      </label>
      <label>
        Slack channel
        <select name="channelId" required value={selected} onChange={(e) => setSelected(e.target.value)}>
          <option value="">Choose a joined channel</option>
          {channels
            .filter((c) => c.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()) || c.id === selected)
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.private ? "Private " : ""}#{c.name}
              </option>
            ))}
        </select>
      </label>
      {busy && <output>Loading Slack channels…</output>}
      {error && (
        <p role="alert">
          {error}{" "}
          <button type="button" onClick={() => void load(cursor ?? undefined)}>
            Retry
          </button>
        </p>
      )}
      {cursor && !query && (
        <button type="button" disabled={busy} onClick={() => void load(cursor)}>
          Load more channels
        </button>
      )}
      {loaded && !channels.length && (
        <p>
          Invite the NoteFlare bot to a public or private channel.{" "}
          <button type="button" disabled={busy} onClick={() => void load()}>
            Refresh channels
          </button>
        </p>
      )}
    </div>
  );
}
