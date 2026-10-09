import { useCallback, useEffect, useState } from "react";
import type { AiSettings, AiStatus } from "../shared/ai";
import { api, apiErrorMessage, json } from "./api";

export function WritingSettings({ owner }: { owner: boolean }) {
  const [status, setStatus] = useState<AiStatus | null>(null),
    [settings, setSettings] = useState<AiSettings | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [saved, setSaved] = useState(false);
  const load = useCallback(async () => {
    const result = await api<AiStatus>("/api/ai/status");
    setStatus(result);
    setSettings(result.settings);
  }, []);
  useEffect(() => {
    const abort = new AbortController();
    void api<AiStatus>("/api/ai/status", { signal: abort.signal })
      .then((result) => {
        if (!abort.signal.aborted) {
          setStatus(result);
          setSettings(result.settings);
        }
      })
      .catch((cause) => {
        if (!abort.signal.aborted) setError(apiErrorMessage(cause, "Writing settings are unavailable."));
      });
    return () => abort.abort();
  }, []);
  async function connect() {
    setBusy(true);
    try {
      const result = await api<{ url: string }>("/api/ai/chatgpt/connect", { method: "POST" });
      window.location.assign(result.url);
    } catch (cause) {
      setError(apiErrorMessage(cause, "ChatGPT could not be connected."));
      setBusy(false);
    }
  }
  async function disconnect() {
    setBusy(true);
    try {
      await api("/api/ai/chatgpt", { method: "DELETE" });
      await load();
      setError("");
    } catch (cause) {
      setError(apiErrorMessage(cause, "The connection could not be removed."));
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    setBusy(true);
    setSaved(false);
    try {
      await api("/api/ai/settings", { method: "POST", body: json(settings) });
      await load();
      setError("");
      setSaved(true);
    } catch (cause) {
      setError(apiErrorMessage(cause, "Writing settings could not be saved."));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="settings-card writing-settings">
      <h2>AI writing</h2>
      <p>Connect your ChatGPT plan for writing inside NoteFlare. Your NoteFlare sign-in stays the same.</p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {saved && <output aria-live="polite">Writing settings saved.</output>}
      {status?.connected ? (
        <>
          <p>Connected: {status.accountLabel}</p>
          <button disabled={busy} onClick={() => void disconnect()}>
            Disconnect ChatGPT
          </button>
        </>
      ) : (
        <button disabled={busy || !status?.chatgptConfigured} onClick={() => void connect()}>
          Connect ChatGPT
        </button>
      )}
      {status && !status.chatgptConfigured && (
        <p className="muted">ChatGPT plan connections are awaiting installation setup.</p>
      )}
      {owner && settings && (
        <fieldset disabled={busy}>
          <legend>Workspace writing controls</legend>
          <label>
            <input
              type="checkbox"
              checked={settings.enabled}
              onChange={(event) => setSettings({ ...settings, enabled: event.target.checked })}
            />
            Enable AI writing
          </label>
          <label>
            <input
              type="checkbox"
              checked={settings.apiEnabled}
              onChange={(event) => setSettings({ ...settings, apiEnabled: event.target.checked })}
            />
            Allow workspace API funding for all members
          </label>
          {status && !status.apiConfigured && (
            <p className="muted">
              The operator must configure the workspace API credential before API funding is available.
            </p>
          )}
          <label>
            Started API requests per member per UTC day
            <input
              type="number"
              min={0}
              max={10000}
              value={settings.dailyQuota}
              onChange={(event) => setSettings({ ...settings, dailyQuota: Number(event.target.value) })}
            />
          </label>
          {(["chatgpt", "api"] as const).map((funding) => (
            <fieldset key={funding}>
              <legend>{funding === "chatgpt" ? "ChatGPT plan" : "Workspace API"} quality modes</legend>
              {(["fast", "best"] as const).map((quality) => (
                <div key={quality}>
                  <label>
                    {quality === "fast" ? "Fast" : "Best"} model
                    <input
                      value={settings.models[funding][quality].id}
                      placeholder="Leave blank to disable this mode"
                      onChange={(event) =>
                        setSettings({
                          ...settings,
                          models: {
                            ...settings.models,
                            [funding]: {
                              ...settings.models[funding],
                              [quality]: { ...settings.models[funding][quality], id: event.target.value },
                            },
                          },
                        })
                      }
                    />
                  </label>
                  <label>
                    {quality === "fast" ? "Fast" : "Best"} context character limit
                    <input
                      type="number"
                      min={1000}
                      max={250000}
                      value={settings.models[funding][quality].maxCharacters}
                      onChange={(event) =>
                        setSettings({
                          ...settings,
                          models: {
                            ...settings.models,
                            [funding]: {
                              ...settings.models[funding],
                              [quality]: {
                                ...settings.models[funding][quality],
                                maxCharacters: Number(event.target.value),
                              },
                            },
                          },
                        })
                      }
                    />
                  </label>
                </div>
              ))}
            </fieldset>
          ))}
          <button onClick={() => void save()}>Save writing settings</button>
        </fieldset>
      )}
    </section>
  );
}
