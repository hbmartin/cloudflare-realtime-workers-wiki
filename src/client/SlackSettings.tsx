import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import type { NotificationEventType, Page, Space } from "../shared/types";
import { api, apiErrorMessage, json } from "./api";

const EVENT_OPTIONS: Array<{ value: NotificationEventType; label: string }> = [
  { value: "mention", label: "Mentions" },
  { value: "reply", label: "Comment replies" },
  { value: "thread_resolved", label: "Resolved threads" },
  { value: "thread_reopened", label: "Reopened threads" },
  { value: "page_edit", label: "Page edits" },
];

type SlackStatus = {
  available: boolean;
  missing: string[];
  installation: {
    teamId: string;
    teamName: string;
    botUserId: string;
    scopes: string[];
    connected: boolean;
    createdAt: number;
    updatedAt: number;
  } | null;
  linked: boolean;
};

type ChannelSubscription = {
  id: string;
  spaceId: string;
  pageId: string | null;
  channelId: string;
  channelName: string;
  eventTypes: NotificationEventType[];
  cadence: "immediate" | "digest";
};

function removeLinkToken() {
  const url = new URL(window.location.href);
  url.searchParams.delete("slackLink");
  url.searchParams.delete("slack");
  history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

export function SlackSettings({ owner, spaces, pages }: { owner: boolean; spaces: Space[]; pages: Page[] }) {
  const [status, setStatus] = useState<SlackStatus | null>(null);
  const [subscriptions, setSubscriptions] = useState<ChannelSubscription[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(() => new URLSearchParams(window.location.search).has("slackLink"));
  const [spaceId, setSpaceId] = useState(spaces[0]?.id ?? "");
  const resolvedSpaceId = spaces.some((space) => space.id === spaceId) ? spaceId : (spaces[0]?.id ?? "");

  const load = useCallback(async () => {
    try {
      const nextStatus = await api<SlackStatus>("/api/slack/status");
      setStatus(nextStatus);
      if (owner && nextStatus.installation?.connected) {
        const result = await api<{ subscriptions: ChannelSubscription[] }>("/api/slack/channels");
        setSubscriptions(result.subscriptions);
      } else {
        setSubscriptions([]);
      }
      setError("");
    } catch (cause) {
      setError(apiErrorMessage(cause, "Slack settings could not be loaded."));
    }
  }, [owner]);

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get("slackLink");
    if (!token) {
      const timer = window.setTimeout(() => void load(), 0);
      return () => window.clearTimeout(timer);
    }
    void api("/api/slack/link", { method: "POST", body: json({ token }) })
      .then(() => {
        setNotice("Your Notes and Slack accounts are linked.");
        removeLinkToken();
        return load();
      })
      .catch((cause) => setError(apiErrorMessage(cause, "The Slack account link could not be completed.")))
      .finally(() => setBusy(false));
    return undefined;
  }, [load]);

  const eligiblePages = useMemo(
    () => pages.filter((page) => page.spaceId === resolvedSpaceId && !page.isTemplate && page.archivedAt === null),
    [pages, resolvedSpaceId],
  );

  async function install() {
    setBusy(true);
    setError("");
    try {
      const result = await api<{ url: string }>("/api/slack/oauth/start");
      window.location.assign(result.url);
    } catch (cause) {
      setError(apiErrorMessage(cause, "Slack authorization could not be started."));
      setBusy(false);
    }
  }

  async function disconnect() {
    if (
      !confirm("Disconnect Slack from this workspace? Existing channel mappings and account links will stop working.")
    ) {
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api("/api/slack/disconnect", { method: "POST" });
      setNotice("Slack was disconnected.");
      await load();
    } catch (cause) {
      setError(apiErrorMessage(cause, "Slack could not be disconnected."));
    } finally {
      setBusy(false);
    }
  }

  async function addSubscription(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const eventTypes = EVENT_OPTIONS.filter(({ value }) => values.has(`event:${value}`)).map(({ value }) => value);
    setBusy(true);
    setError("");
    try {
      await api("/api/slack/channels", {
        method: "POST",
        body: json({
          spaceId: resolvedSpaceId,
          pageId: String(values.get("pageId") ?? "") || null,
          channelId: String(values.get("channelId") ?? ""),
          channelName: String(values.get("channelName") ?? ""),
          cadence: String(values.get("cadence") ?? "immediate"),
          eventTypes,
        }),
      });
      form.reset();
      setNotice("Slack channel mapping saved.");
      await load();
    } catch (cause) {
      setError(apiErrorMessage(cause, "The Slack channel mapping could not be saved."));
    } finally {
      setBusy(false);
    }
  }

  async function removeSubscription(id: string) {
    setBusy(true);
    setError("");
    try {
      await api(`/api/slack/channels/${encodeURIComponent(id)}`, { method: "DELETE" });
      setSubscriptions((current) => current.filter((subscription) => subscription.id !== id));
      setNotice("Slack channel mapping removed.");
    } catch (cause) {
      setError(apiErrorMessage(cause, "The Slack channel mapping could not be removed."));
    } finally {
      setBusy(false);
    }
  }

  const connected = status?.installation?.connected === true;
  return (
    <section className="slack-settings" aria-labelledby="slack-settings-title">
      <div className="slack-settings-heading">
        <div>
          <p className="eyebrow">Integration</p>
          <h2 id="slack-settings-title">Slack</h2>
        </div>
        {owner && status?.available && !connected && (
          <button className="primary-small" disabled={busy} onClick={() => void install()}>
            Add to Slack
          </button>
        )}
        {owner && connected && (
          <button className="quiet-button" disabled={busy} onClick={() => void disconnect()}>
            Disconnect
          </button>
        )}
      </div>

      {!status && !error && <p className="muted">Checking Slack configuration…</p>}
      {status && !status.available && (
        <output className="channel-status">
          Slack is unavailable until an operator configures the app credentials. Notes notifications remain available
          in-app.
        </output>
      )}
      {status?.available && !connected && (
        <p className="muted">
          {owner
            ? "Install the workspace app to enable private search, safe link previews, channel updates, and personal notifications."
            : "A workspace owner must install the Slack app before accounts can be linked."}
        </p>
      )}
      {connected && (
        <div className="slack-connection-summary">
          <span aria-hidden="true">✓</span>
          <div>
            <strong>{status.installation!.teamName}</strong>
            <p>{status.linked ? "Your Slack account is linked." : "In Slack, run /notes link to link your account."}</p>
          </div>
        </div>
      )}
      {notice && <output className="slack-notice">{notice}</output>}
      {error && (
        <div className="activity-job-error" role="alert">
          {error} <button onClick={() => void load()}>Retry</button>
        </div>
      )}

      {owner && connected && (
        <>
          <form className="slack-channel-form" onSubmit={addSubscription}>
            <h3>Channel updates</h3>
            <p className="muted">
              Map a channel to a whole space or one page. Private page previews require a mapping.
            </p>
            <div className="slack-field-grid">
              <label>
                Space
                <select value={resolvedSpaceId} onChange={(event) => setSpaceId(event.target.value)} required>
                  {spaces.map((space) => (
                    <option key={space.id} value={space.id}>
                      {space.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Page scope
                <select key={resolvedSpaceId} name="pageId" defaultValue="">
                  <option value="">Every page in this space</option>
                  {eligiblePages.map((page) => (
                    <option key={page.id} value={page.id}>
                      {page.title}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Channel ID
                <input name="channelId" placeholder="C0123456789" maxLength={30} required />
              </label>
              <label>
                Channel name
                <input name="channelName" placeholder="product-notes" maxLength={100} required />
              </label>
              <label>
                Cadence
                <select name="cadence" defaultValue="immediate">
                  <option value="immediate">Immediate</option>
                  <option value="digest">Daily digest at 09:00 UTC</option>
                </select>
              </label>
            </div>
            <fieldset className="slack-event-options">
              <legend>Events</legend>
              {EVENT_OPTIONS.map((option) => (
                <label key={option.value}>
                  <input name={`event:${option.value}`} type="checkbox" defaultChecked /> {option.label}
                </label>
              ))}
            </fieldset>
            <button className="primary-small" disabled={busy || !resolvedSpaceId}>
              {busy ? "Saving…" : "Save channel mapping"}
            </button>
          </form>

          <div className="slack-channel-list">
            {subscriptions.map((subscription) => {
              const space = spaces.find((candidate) => candidate.id === subscription.spaceId);
              const page = subscription.pageId ? pages.find((candidate) => candidate.id === subscription.pageId) : null;
              return (
                <article key={subscription.id}>
                  <div>
                    <strong>#{subscription.channelName || subscription.channelId}</strong>
                    <p>
                      {space?.name ?? "Unavailable space"}
                      {page ? ` / ${page.title}` : " / all pages"} · {subscription.cadence}
                    </p>
                  </div>
                  <button
                    className="text-danger"
                    disabled={busy}
                    aria-label={`Remove #${subscription.channelName || subscription.channelId}`}
                    onClick={() => void removeSubscription(subscription.id)}
                  >
                    Remove
                  </button>
                </article>
              );
            })}
            {!subscriptions.length && <p className="empty-copy">No Slack channels are mapped yet.</p>}
          </div>
        </>
      )}
    </section>
  );
}
