import { useCallback, useEffect, useState } from "react";
import { api, apiErrorMessage, json } from "./api";

type Connection = {
  id: string;
  clientId: string;
  name: string;
  scopes: string[];
  createdAt: number;
  revokedAt: number | null;
};

export function OAuthConnectionsSettings({ owner }: { owner: boolean }) {
  const [enabled, setEnabled] = useState(false);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async (cursor?: string) => {
    try {
      const [workspace, grants] = await Promise.all([
        cursor ? Promise.resolve(null) : api<{ enabled: boolean }>("/api/oauth/workspace"),
        api<{ connections: Connection[]; nextCursor: string | null }>(
          `/api/oauth/connections${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
        ),
      ]);
      if (workspace) setEnabled(workspace.enabled);
      setConnections((current) =>
        cursor
          ? [...new Map([...current, ...grants.connections].map((connection) => [connection.id, connection])).values()]
          : grants.connections,
      );
      setNextCursor(grants.nextCursor ?? null);
      setError("");
    } catch (cause) {
      setError(apiErrorMessage(cause, "Connections could not be loaded."));
    }
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function changeEnabled(next: boolean) {
    setBusy(true);
    try {
      await api("/api/oauth/workspace", { method: "POST", body: json({ enabled: next }) });
      setEnabled(next);
      if (!next) {
        const revokedAt = Date.now();
        setConnections((current) => current.map((entry) => ({ ...entry, revokedAt: entry.revokedAt ?? revokedAt })));
      }
      setError("");
    } catch (cause) {
      setError(apiErrorMessage(cause, "MCP access could not be updated."));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(connection: Connection) {
    if (!confirm(`Disconnect ${connection.name}?`)) return;
    setBusy(true);
    try {
      await api<void>(`/api/oauth/connections/${encodeURIComponent(connection.id)}`, { method: "DELETE" });
      setConnections((current) =>
        current.map((entry) => (entry.id === connection.id ? { ...entry, revokedAt: Date.now() } : entry)),
      );
      setError("");
    } catch (cause) {
      setError(apiErrorMessage(cause, "The connection could not be revoked."));
    } finally {
      setBusy(false);
    }
  }

  async function loadMore() {
    if (!nextCursor) return;
    setBusy(true);
    try {
      await load(nextCursor);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="settings-section" aria-labelledby="mcp-connections-title">
      <h2 id="mcp-connections-title">Connected MCP clients</h2>
      <p>Clients use your current workspace and page permissions. Disconnecting one stops its next request.</p>
      {owner && (
        <>
          <label>
            <input
              type="checkbox"
              checked={enabled}
              disabled={busy}
              onChange={(event) => void changeEnabled(event.currentTarget.checked)}
            />
            Allow MCP connections in this workspace
          </label>
          <p>
            Disabling MCP disconnects all clients in this workspace. After re-enabling it, each client must reconnect.
          </p>
        </>
      )}
      {error && <p role="alert">{error}</p>}
      {connections.length === 0 ? (
        <p>No clients connected.</p>
      ) : (
        <ul>
          {connections.map((connection) => (
            <li key={connection.id}>
              <strong>{connection.name}</strong> · {connection.scopes.join(", ")}
              {connection.revokedAt ? (
                <span> · Disconnected</span>
              ) : (
                <button type="button" disabled={busy} onClick={() => void revoke(connection)}>
                  Disconnect
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {nextCursor && (
        <button type="button" disabled={busy} onClick={() => void loadMore()}>
          Load more connections
        </button>
      )}
    </section>
  );
}
