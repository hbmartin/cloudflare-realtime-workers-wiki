import { slackAuthErrorMessage } from "./slack-auth-errors";
import { SlackChannelPicker } from "./SlackChannelPicker";
import { ACTIVITY_LABELS, CHANNEL_EVENT_TYPES } from "../shared/activity";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import type {
  Page,
  SlackChannelSubscription as ChannelSubscription,
  SlackStatus,
  SlackCleanupHealth,
  SlackVerificationSummary,
  Space,
} from "../shared/types";
import { api, apiErrorMessage, authClient, json } from "./api";

function initialSlackOAuthError() {
  const params = new URLSearchParams(window.location.search);
  const oauthError = params.get("error");
  if (!oauthError) return "";
  const known: Record<string, string> = {
    slack_scope_missing:
      "Ask the workspace owner to reauthorize Slack with users:read, then connect your identity again.",
    slack_member_removed: "Use an active member account from the connected Slack workspace.",
    slack_guest_forbidden: "Use a full member account from the connected Slack workspace.",
    slack_external_forbidden: "Use a member account from the connected Slack workspace, rather than Slack Connect.",
  };
  const message =
    slackAuthErrorMessage(oauthError, known) ??
    (oauthError.toLowerCase().includes("link")
      ? "Slack could not be connected to this account. Sign in normally and try again."
      : "Slack authorization could not be completed.");
  const url = new URL(window.location.href);
  for (const key of ["error", "error_description", "slackAuth"]) url.searchParams.delete(key);
  history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  return message;
}

export function SlackSettings({ owner, spaces, pages }: { owner: boolean; spaces: Space[]; pages: Page[] }) {
  const [status, setStatus] = useState<SlackStatus | null>(null);
  const [cleanup, setCleanup] = useState<SlackCleanupHealth | null>(null);
  const [subscriptions, setSubscriptions] = useState<ChannelSubscription[]>([]);
  const [orphanedFailures, setOrphanedFailures] = useState<
    Array<{
      id: string;
      channelName: string;
      failedDeliveries: number;
    }>
  >([]);
  const [error, setError] = useState(initialSlackOAuthError);
  const [notice, setNotice] = useState("");
  const [verification, setVerification] = useState<Record<string, SlackVerificationSummary>>({});
  const [pickerVersion, setPickerVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [currentTime, setCurrentTime] = useState(() => Date.now());
  const [snoozeHours, setSnoozeHours] = useState<Record<string, "" | "1" | "8" | "24">>({});
  const [spaceId, setSpaceId] = useState(spaces[0]?.id ?? "");
  const resolvedSpaceId = spaces.some((space) => space.id === spaceId) ? spaceId : (spaces[0]?.id ?? "");

  useEffect(() => {
    const timer = window.setInterval(() => setCurrentTime(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const load = useCallback(async () => {
    try {
      const nextStatus = await api<SlackStatus>("/api/slack/status");
      setStatus(nextStatus);
      setCurrentTime(Date.now());
      if (owner && nextStatus.installation?.connected) {
        const result = await api<{ subscriptions: ChannelSubscription[] }>("/api/slack/channels");
        setSubscriptions(result.subscriptions);
      } else {
        setSubscriptions([]);
        if (!owner) setOrphanedFailures([]);
      }
      if (owner) {
        const health = await api<{
          cleanup?: SlackCleanupHealth;
          orphanedFailures: Array<{
            id: string;
            channelName: string;
            failedDeliveries: number;
          }>;
        }>("/api/slack/delivery-health");
        setOrphanedFailures(health.orphanedFailures ?? []);
        setCleanup(health.cleanup ?? null);
      }
    } catch (cause) {
      setError(apiErrorMessage(cause, "Slack settings could not be loaded."));
    }
  }, [owner]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
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

  async function deliveryHealthAction(path: string, successMessage: string) {
    setBusy(true);
    setError("");
    try {
      await api(path, { method: "POST" });
      setNotice(successMessage);
      await load();
    } catch (cause) {
      setError(apiErrorMessage(cause, "Slack delivery health could not be updated."));
    } finally {
      setBusy(false);
    }
  }

  async function linkIdentity() {
    setBusy(true);
    setError("");
    try {
      const result = await authClient.linkSocial({
        provider: "slack",
        callbackURL: "/?view=settings&slack=verified",
        errorCallbackURL: "/?view=settings&slackAuth=callback",
      });
      if (result.error) {
        setError(result.error.message || "Slack identity could not be connected.");
        setBusy(false);
      }
    } catch (cause) {
      setError(apiErrorMessage(cause, "Slack identity could not be connected. Try again."));
      setBusy(false);
    }
  }

  async function disconnectIdentity() {
    setBusy(true);
    setError("");
    try {
      await api("/api/slack/identity", { method: "DELETE" });
      setNotice("Slack access was disconnected. Your Slack sign-in remains available.");
      await load();
    } catch (cause) {
      setError(apiErrorMessage(cause, "Slack access could not be disconnected."));
    } finally {
      setBusy(false);
    }
  }

  async function addSubscription(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const eventTypes = CHANNEL_EVENT_TYPES.filter((value) => values.has(`event:${value}`));
    setBusy(true);
    setError("");
    try {
      await api("/api/slack/channels", {
        method: "POST",
        body: json({
          spaceId: resolvedSpaceId,
          pageId: String(values.get("pageId") ?? "") || null,
          channelId: String(values.get("channelId") ?? ""),
          cadence: String(values.get("cadence") ?? "immediate"),
          eventTypes,
          digestTime: String(values.get("digestTime") ?? "09:00"),
          ...(values.get("digestTimezone") ? { digestTimezone: String(values.get("digestTimezone")) } : {}),
          digestOpenWork: values.has("digestOpenWork"),
        }),
      });
      form.reset();
      setPickerVersion((value) => value + 1);
      setNotice("Slack channel mapping saved.");
      await load();
    } catch (cause) {
      setError(apiErrorMessage(cause, "The Slack channel mapping could not be saved."));
    } finally {
      setBusy(false);
    }
  }

  async function toggleMirror(subscription: ChannelSubscription) {
    setBusy(true);
    setError("");
    try {
      await api(`/api/slack/channels/${encodeURIComponent(subscription.id)}/mirror`, {
        method: "PATCH",
        body: json({ mirrorEnabled: !subscription.mirrorEnabled }),
      });
      setNotice(
        subscription.mirrorEnabled ? "Thread mirroring disabled." : "Channel validated and thread mirroring enabled.",
      );
      await load();
    } catch (cause) {
      setError(apiErrorMessage(cause, "Thread mirroring could not be changed."));
    } finally {
      setBusy(false);
    }
  }

  async function verifyNotifications(subscription: ChannelSubscription, repair = false) {
    setBusy(true);
    setError("");
    try {
      const previous = verification[subscription.id];
      const summary = await api<SlackVerificationSummary>(
        `/api/slack/channels/${encodeURIComponent(subscription.id)}/${repair ? "repair-notifications" : "verify-recovery"}`,
        { method: "POST", body: json(!repair && previous?.nextCursor ? { cursor: previous.nextCursor } : {}) },
      );
      setVerification((current) => ({ ...current, [subscription.id]: summary }));
      const progress = `Checked ${summary.checked}: ${summary.confirmed} confirmed, ${summary.blocked} blocked, ${summary.pending} pending, ${summary.paused} paused.`;
      setNotice(
        `${repair ? "Channel access repaired. " : ""}${progress}${summary.nextCursor ? " Continue verification to check remaining deliveries." : ""}${summary.retryAt ? ` Slack requests can resume after ${new Date(summary.retryAt).toLocaleTimeString()}.` : ""}`,
      );
      await load();
    } catch (cause) {
      setError(apiErrorMessage(cause, "Slack verification could not be completed."));
    } finally {
      setBusy(false);
    }
  }

  async function pauseChannel(
    subscription: ChannelSubscription,
    mode: "mute" | "unmute" | "snooze",
    hours?: 1 | 8 | 24,
  ) {
    setBusy(true);
    setError("");
    try {
      await api(`/api/slack/channels/${encodeURIComponent(subscription.id)}/pause`, {
        method: "PATCH",
        body: json({ mode, ...(hours ? { hours } : {}) }),
      });
      setNotice(
        mode === "unmute"
          ? "Channel updates resumed."
          : mode === "mute"
            ? "Channel updates muted."
            : `Channel updates snoozed for ${hours} hours.`,
      );
      if (mode === "snooze") setSnoozeHours((current) => ({ ...current, [subscription.id]: "" }));
      await load();
    } catch (cause) {
      setError(apiErrorMessage(cause, "Channel controls could not be changed."));
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
  const identityState = status?.identity.state ?? "unlinked";
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
          <div>
            {status.reauthorization?.required && (
              <button className="primary-small" disabled={busy} onClick={() => void install()}>
                Reauthorize Slack
              </button>
            )}
            <button className="quiet-button" disabled={busy} onClick={() => void disconnect()}>
              Disconnect
            </button>
          </div>
        )}
      </div>

      {!status && !error && <p className="muted">Checking Slack configuration…</p>}
      {status && !status.available && (
        <output className="channel-status">
          Slack is unavailable until an operator configures the app credentials. NoteFlare notifications remain
          available in-app.
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
            {identityState === "verified" ? (
              <p>Your Slack identity is verified.</p>
            ) : (
              <p>Connect your Slack identity to enable personal notifications.</p>
            )}
          </div>
        </div>
      )}
      {connected &&
        status?.installation?.capabilities?.identity.available &&
        (identityState !== "verified" || status.identity?.reauthorizationRequired) && (
          <button className="primary-small" disabled={busy} onClick={() => void linkIdentity()}>
            Connect Slack identity
          </button>
        )}
      {status?.identity?.reauthorizationRequired && <p>Verify your account protection and reconnect Slack access.</p>}
      {connected && identityState === "verified" && (
        <button disabled={busy} onClick={() => void disconnectIdentity()}>
          Disconnect Slack access
        </button>
      )}
      {connected && status?.installation?.authError && (
        <output className="channel-status">
          Slack bot authentication failed.{" "}
          {owner
            ? "Reauthorize the workspace app to resume delivery."
            : "Ask an owner to reauthorize the workspace app."}
        </output>
      )}
      {owner && connected && status.installation?.scopeHealth && (
        <div className="slack-scope-health">
          <h3>Bot scope health</h3>
          <p>Granted: {status.installation!.scopeHealth.granted.join(", ") || "none"}</p>
          <p>Missing: {status.installation!.scopeHealth.missing.join(", ") || "none"}</p>
        </div>
      )}
      {notice && <output className="slack-notice">{notice}</output>}
      {error && (
        <div className="activity-job-error" role="alert">
          {error}{" "}
          <button
            onClick={() => {
              setError("");
              void load();
            }}
          >
            Retry
          </button>
        </div>
      )}

      {owner && connected && (
        <>
          {status?.round2?.channels && (
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
                <SlackChannelPicker key={pickerVersion} />
                <label>
                  Cadence
                  <select name="cadence" defaultValue="immediate">
                    <option value="immediate">Immediate</option>
                    <option value="digest">Daily digest</option>
                  </select>
                </label>
              </div>
              {status?.round2?.channels && (
                <div className="slack-field-grid">
                  <label>
                    Daily send time
                    <input type="time" name="digestTime" defaultValue="09:00" required />
                  </label>
                  <label>
                    Digest timezone
                    <input
                      name="digestTimezone"
                      defaultValue={status.round2.defaultTimezone ?? ""}
                      placeholder="Operator default timezone"
                      maxLength={100}
                    />
                  </label>
                  <label>
                    <input type="checkbox" name="digestOpenWork" defaultChecked /> Include unresolved comments and
                    unfinished tasks
                  </label>
                  {!status.round2.defaultTimezone && (
                    <p>The operator must configure a default timezone before enabling digests.</p>
                  )}
                </div>
              )}
              <fieldset className="slack-event-options">
                <legend>Events</legend>
                {CHANNEL_EVENT_TYPES.map((value) => ({ value, label: ACTIVITY_LABELS[value] })).map((option) => (
                  <label key={option.value}>
                    <input name={`event:${option.value}`} type="checkbox" defaultChecked /> {option.label}
                  </label>
                ))}
              </fieldset>
              <button className="primary-small" disabled={busy || !resolvedSpaceId || !status?.round2?.channels}>
                {busy ? "Saving…" : "Save channel mapping"}
              </button>
            </form>
          )}

          <div className="slack-channel-list">
            {subscriptions.map((subscription) => {
              const space = spaces.find((candidate) => candidate.id === subscription.spaceId);
              const page = subscription.pageId ? pages.find((candidate) => candidate.id === subscription.pageId) : null;
              const paused =
                (subscription.mutedAt !== null && subscription.mutedAt !== undefined) ||
                (subscription.snoozedUntil ?? 0) > currentTime;
              const pauseLabel = paused ? "Unmute" : "Mute";
              return (
                <article key={subscription.id}>
                  <div>
                    <strong>#{subscription.channelName || subscription.channelId}</strong>
                    <p>
                      {space?.name ?? "Unavailable space"}
                      {page ? ` / ${page.title}` : " / all pages"} · {subscription.cadence}
                    </p>
                    <p>{subscription.mirrorEnabled ? "Thread mirror enabled" : "One-way notifications"}</p>
                    {status?.round2?.channels && <SlackMappingEditor subscription={subscription} onSaved={load} />}
                    {subscription.nextDigestAt && subscription.cadence === "digest" && (
                      <p>
                        Next digest: {new Date(subscription.nextDigestAt).toLocaleString()} (
                        {subscription.digestTimezone})
                      </p>
                    )}
                    {subscription.mutedAt !== null && subscription.mutedAt !== undefined ? (
                      <p>Muted until you unmute this mapping.</p>
                    ) : subscription.snoozedUntil !== null &&
                      subscription.snoozedUntil !== undefined &&
                      subscription.snoozedUntil > currentTime ? (
                      <p>Snoozed until {new Date(subscription.snoozedUntil).toLocaleString()}.</p>
                    ) : null}
                    {subscription.validationState === "invalid" && (
                      <p>
                        Channel validation failed:{" "}
                        {subscription.validationError?.replaceAll("_", " ") ?? "channel unavailable"}. Delivery resumes
                        automatically when access is restored.
                      </p>
                    )}
                    {subscription.notificationBlockedAt && (
                      <output>
                        Channel delivery is paused because the bot cannot use this channel. Access is checked every 15
                        minutes.
                      </output>
                    )}
                    {subscription.controlsError === "no_authorized_owner" && (
                      <output>
                        Snooze ended, but no current workspace owner can refresh the Slack thread controls.
                      </output>
                    )}
                    {Boolean(subscription.blockedDeliveries) && (
                      <output>
                        {subscription.blockedDeliveries} deliveries need reconciliation. Unconfirmed messages stay
                        blocked to prevent duplicates.
                      </output>
                    )}
                    {Boolean(subscription.waitingDeliveries) && (
                      <p>{subscription.waitingDeliveries} thread replies are waiting their turn.</p>
                    )}
                    {Boolean(subscription.failedDeliveries) && (
                      <output>{subscription.failedDeliveries} deliveries failed.</output>
                    )}
                  </div>
                  {(Boolean(subscription.blockedDeliveries) || verification[subscription.id]?.nextCursor) && (
                    <button
                      disabled={busy || (verification[subscription.id]?.retryAt ?? 0) > currentTime}
                      onClick={() => void verifyNotifications(subscription)}
                    >
                      {verification[subscription.id]?.nextCursor
                        ? "Continue verification"
                        : "Verify and resume delivery"}
                    </button>
                  )}
                  {Boolean(subscription.failedDeliveries) && (
                    <button
                      disabled={busy}
                      onClick={() =>
                        void deliveryHealthAction(
                          `/api/slack/delivery-health/${encodeURIComponent(subscription.id)}/acknowledge`,
                          "Delivery failures acknowledged.",
                        )
                      }
                    >
                      Clear failures
                    </button>
                  )}
                  <button
                    disabled={busy || (!subscription.mirrorEnabled && status?.identity?.state !== "verified")}
                    aria-label={`${subscription.mirrorEnabled ? "Disable" : "Enable"} thread mirror for #${subscription.channelName || subscription.channelId}`}
                    onClick={() => void toggleMirror(subscription)}
                  >
                    {subscription.mirrorEnabled ? "Disable mirror" : "Validate and enable mirror"}
                  </button>
                  {subscription.notificationBlockedAt && (
                    <button
                      disabled={busy || (verification[subscription.id]?.retryAt ?? 0) > currentTime}
                      onClick={() => void verifyNotifications(subscription, true)}
                    >
                      Verify and resume notifications
                    </button>
                  )}
                  <button
                    disabled={busy}
                    aria-label={`${pauseLabel} #${subscription.channelName || subscription.channelId}`}
                    onClick={() => void pauseChannel(subscription, paused ? "unmute" : "mute")}
                  >
                    {pauseLabel}
                  </button>
                  <select
                    aria-label={`Snooze updates for #${subscription.channelName || subscription.channelId}`}
                    value={snoozeHours[subscription.id] ?? ""}
                    disabled={busy}
                    onChange={(event) =>
                      setSnoozeHours((current) => ({
                        ...current,
                        [subscription.id]: event.target.value as "" | "1" | "8" | "24",
                      }))
                    }
                  >
                    <option value="">Snooze…</option>
                    <option value="1">1 hour</option>
                    <option value="8">8 hours</option>
                    <option value="24">24 hours</option>
                  </select>
                  <button
                    disabled={busy || !snoozeHours[subscription.id]}
                    aria-label={`Apply snooze for #${subscription.channelName || subscription.channelId}`}
                    onClick={() => {
                      const hours = Number(snoozeHours[subscription.id]);
                      if (hours === 1 || hours === 8 || hours === 24) void pauseChannel(subscription, "snooze", hours);
                    }}
                  >
                    Apply snooze
                  </button>
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
      {owner && cleanup && cleanup.paused > 0 && (
        <article>
          <h3>Thumbnail cleanup paused</h3>
          {cleanup.pausedByReason.map(({ reason, count }) => (
            <p key={reason}>
              {count} {count === 1 ? "file is" : "files are"} waiting.{" "}
              {reason === "missing_scope"
                ? "Reauthorize Slack with files:write to resume cleanup."
                : reason === "cleanup_credentials_unavailable"
                  ? "Reconnect the original Slack workspace and bot to resume cleanup."
                  : "Reauthorize Slack to resume cleanup; files with an unverifiable original identity require manual attention."}
            </p>
          ))}
        </article>
      )}
      {owner &&
        orphanedFailures.map((group) => (
          <article key={group.id}>
            <output>
              {group.id.startsWith("slack-file-cleanup:")
                ? `${group.failedDeliveries} thumbnail cleanup ${group.failedDeliveries === 1 ? "failure needs" : "failures need"} manual attention.`
                : `${group.failedDeliveries} delivery failures for removed mapping #${group.channelName}.`}
            </output>
            <button
              disabled={busy}
              onClick={() =>
                void deliveryHealthAction(
                  `/api/slack/delivery-health/${encodeURIComponent(group.id)}/acknowledge`,
                  "Delivery failures acknowledged.",
                )
              }
            >
              Clear failures
            </button>
          </article>
        ))}
    </section>
  );
}

function SlackMappingEditor({
  subscription,
  onSaved,
}: {
  subscription: ChannelSubscription;
  onSaved: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      await api(`/api/slack/channels/${encodeURIComponent(subscription.id)}`, {
        method: "PATCH",
        body: json({
          cadence: String(data.get("cadence")),
          digestTime: String(data.get("digestTime")),
          ...(data.get("digestTimezone") ? { digestTimezone: String(data.get("digestTimezone")) } : {}),
          digestOpenWork: data.has("digestOpenWork"),
          eventTypes: [
            ...CHANNEL_EVENT_TYPES.filter((t) => data.has(`event:${t}`)),
            ...subscription.eventTypes.filter((t) => !(CHANNEL_EVENT_TYPES as readonly string[]).includes(t)),
          ],
        }),
      });
      await onSaved();
    } catch (cause) {
      setError(apiErrorMessage(cause, "Mapping could not be updated."));
    } finally {
      setBusy(false);
    }
  }
  return (
    <details>
      <summary>Edit schedule and events</summary>
      <form onSubmit={save}>
        <label>
          Cadence
          <select name="cadence" defaultValue={subscription.cadence}>
            <option value="immediate">Immediate</option>
            <option value="digest">Daily digest</option>
          </select>
        </label>
        <label>
          Daily send time
          <input type="time" name="digestTime" defaultValue={subscription.digestTime ?? "09:00"} required />
        </label>
        <label>
          Digest timezone
          <input name="digestTimezone" defaultValue={subscription.digestTimezone ?? ""} maxLength={100} />
        </label>
        <label>
          <input type="checkbox" name="digestOpenWork" defaultChecked={subscription.digestOpenWork} />
          Include unresolved comments and unfinished tasks
        </label>
        <fieldset>
          <legend>Events</legend>
          {CHANNEL_EVENT_TYPES.map((t) => (
            <label key={t}>
              <input type="checkbox" name={`event:${t}`} defaultChecked={subscription.eventTypes.includes(t)} />
              {ACTIVITY_LABELS[t]}
            </label>
          ))}
        </fieldset>
        {error && <p role="alert">{error}</p>}
        <button disabled={busy}>Save mapping settings</button>
      </form>
    </details>
  );
}
