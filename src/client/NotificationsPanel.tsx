import { useEffect, useRef, useState } from "react";
import type { Notification, NotificationEventType, NotificationPreference } from "../shared/types";
import { api, apiErrorMessage, json } from "./api";

const DATE_TIME_FORMAT = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const EVENT_LABELS: Record<NotificationEventType, string> = {
  mention: "Mentions",
  reply: "Replies",
  thread_resolved: "Resolved threads",
  thread_reopened: "Reopened threads",
  page_edit: "Watched page edits",
};

type PreferenceResponse = {
  preferences: NotificationPreference[];
  configured: boolean;
  channels: { email: { available: boolean }; slack: { available: boolean } };
};

function notificationCopy(notification: Notification) {
  const actor = notification.actor?.name ?? "A collaborator";
  if (notification.eventType === "mention") return `${actor} mentioned you`;
  if (notification.eventType === "reply") return `${actor} replied to a thread`;
  if (notification.eventType === "thread_resolved") return `${actor} resolved a thread`;
  if (notification.eventType === "thread_reopened") return `${actor} reopened a thread`;
  return `${actor} edited this watched page`;
}

export function NotificationsPanel({
  revision,
  onClose,
  onSelectPage,
  onUnreadCountChange,
}: {
  revision: number;
  onClose: () => void;
  onSelectPage: (pageId: string) => void;
  onUnreadCountChange: (count: number) => void;
}) {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [preferences, setPreferences] = useState<NotificationPreference[]>([]);
  const [channels, setChannels] = useState<PreferenceResponse["channels"] | null>(null);
  const [settingsError, setSettingsError] = useState("");
  const [saving, setSaving] = useState(false);
  const closeButton = useRef<HTMLButtonElement>(null);
  const tray = useRef<HTMLDialogElement>(null);

  async function load(offset = 0) {
    setLoading(true);
    try {
      const data = await api<{ notifications: Notification[]; unreadCount: number; hasMore: boolean }>(
        `/api/notifications?limit=20&offset=${offset}${unreadOnly ? "&unread=true" : ""}`,
      );
      setNotifications((current) => (offset ? [...current, ...data.notifications] : data.notifications));
      setUnreadCount(data.unreadCount);
      setHasMore(data.hasMore);
      onUnreadCountChange(data.unreadCount);
      setError("");
    } catch (cause) {
      setError(apiErrorMessage(cause, "Notifications could not be loaded."));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // `load` intentionally follows the current filter and server revision.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision, unreadOnly]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButton.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab" || !tray.current) return;
      const controls = Array.from(
        tray.current.querySelectorAll<HTMLElement>(
          "button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled)",
        ),
      );
      if (!controls.length) return;
      const first = controls[0]!;
      const last = controls.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.setTimeout(() => {
        if (previousFocus?.isConnected) previousFocus.focus();
      });
    };
  }, [onClose]);

  async function mark(action: "read" | "archive", ids?: string[]) {
    try {
      await api(`/api/notifications/${action}`, { method: "POST", body: json(ids ? { ids } : {}) });
      await load();
    } catch (cause) {
      setError(apiErrorMessage(cause, `Notifications could not be marked ${action}.`));
    }
  }

  async function openNotification(notification: Notification) {
    if (!notification.readAt) await mark("read", [notification.id]);
    onSelectPage(notification.page.id);
    onClose();
  }

  async function openSettings() {
    setSettingsOpen(true);
    if (preferences.length) return;
    try {
      const data = await api<PreferenceResponse>("/api/notification-preferences");
      const browserTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
      setPreferences(
        data.preferences.map((preference) => ({
          ...preference,
          timezone: data.configured ? preference.timezone : browserTimezone,
        })),
      );
      setChannels(data.channels);
      setSettingsError("");
    } catch (cause) {
      setSettingsError(apiErrorMessage(cause, "Notification settings could not be loaded."));
    }
  }

  async function saveSettings() {
    setSaving(true);
    try {
      const data = await api<{ preferences: NotificationPreference[] }>("/api/notification-preferences", {
        method: "PUT",
        body: json({ preferences }),
      });
      setPreferences(data.preferences);
      setSettingsError("");
      setSettingsOpen(false);
      await load();
    } catch (cause) {
      setSettingsError(apiErrorMessage(cause, "Notification settings could not be saved."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="activity-scrim" aria-hidden="true" onClick={onClose} />
      <dialog
        ref={tray}
        className="activities-tray notifications-tray"
        open
        aria-modal="true"
        aria-labelledby="notifications-title"
      >
        <header>
          <div>
            <p className="eyebrow">Updates for you</p>
            <h2 id="notifications-title">Notifications</h2>
          </div>
          <button ref={closeButton} className="icon-button" aria-label="Close notifications" onClick={onClose}>
            ×
          </button>
        </header>
        {settingsOpen ? (
          <div className="notification-settings">
            <button className="quiet-button notification-back" onClick={() => setSettingsOpen(false)}>
              ← Back to notifications
            </button>
            <h3>Delivery preferences</h3>
            <p className="muted">Urgent events can arrive immediately. Watched edits are bundled by default.</p>
            {channels && !channels.email.available && (
              <output className="channel-status">
                Email is unavailable until a sending domain is configured. In-app notifications remain active.
              </output>
            )}
            {preferences.map((preference, index) => (
              <fieldset key={preference.eventType} className="notification-preference">
                <legend>{EVENT_LABELS[preference.eventType]}</legend>
                <label>
                  <input
                    type="checkbox"
                    checked={preference.inApp}
                    onChange={(event) =>
                      setPreferences((current) =>
                        current.map((item, itemIndex) =>
                          itemIndex === index ? { ...item, inApp: event.target.checked } : item,
                        ),
                      )
                    }
                  />
                  In app
                </label>
                <label>
                  Email
                  <select
                    aria-label={`${EVENT_LABELS[preference.eventType]} email`}
                    value={preference.email}
                    disabled={!channels?.email.available}
                    onChange={(event) =>
                      setPreferences((current) =>
                        current.map((item, itemIndex) =>
                          itemIndex === index
                            ? { ...item, email: event.target.value as NotificationPreference["email"] }
                            : item,
                        ),
                      )
                    }
                  >
                    <option value="off">Off</option>
                    <option value="immediate">Immediately</option>
                    <option value="digest">Daily digest</option>
                  </select>
                </label>
                <span className="slack-disabled" title="Slack integration is not configured">
                  Slack unavailable
                </span>
              </fieldset>
            ))}
            <label className="timezone-field">
              Digest timezone
              <input
                value={preferences[0]?.timezone ?? "UTC"}
                onChange={(event) =>
                  setPreferences((current) => current.map((item) => ({ ...item, timezone: event.target.value })))
                }
              />
            </label>
            {settingsError && (
              <p className="activity-job-error" role="alert">
                {settingsError}
              </p>
            )}
            <button
              className="primary-button"
              disabled={saving || !preferences.length}
              onClick={() => void saveSettings()}
            >
              {saving ? "Saving…" : "Save preferences"}
            </button>
          </div>
        ) : (
          <>
            <div className="activities-toolbar notification-toolbar">
              <fieldset className="notification-filter">
                <legend className="visually-hidden">Notification filter</legend>
                <button
                  className={!unreadOnly ? "active" : ""}
                  aria-pressed={!unreadOnly}
                  onClick={() => setUnreadOnly(false)}
                >
                  All
                </button>
                <button
                  className={unreadOnly ? "active" : ""}
                  aria-pressed={unreadOnly}
                  onClick={() => setUnreadOnly(true)}
                >
                  Unread {unreadCount || ""}
                </button>
              </fieldset>
              <div>
                {unreadCount > 0 && (
                  <button className="quiet-button" onClick={() => void mark("read")}>
                    Mark all read
                  </button>
                )}
                <button className="icon-button" aria-label="Notification settings" onClick={() => void openSettings()}>
                  ⚙
                </button>
              </div>
            </div>
            {error ? (
              <div className="activity-error" role="alert">
                <p>{error}</p>
                <button className="quiet-button" onClick={() => void load()}>
                  Try again
                </button>
              </div>
            ) : notifications.length ? (
              <ol className="activity-list notification-list">
                {notifications.map((notification) => (
                  <li key={notification.id} className={notification.readAt ? "" : "unread"}>
                    <button
                      className="notification-open"
                      aria-label={`Open ${notification.page.title}: ${notificationCopy(notification)}`}
                      onClick={() => void openNotification(notification)}
                    >
                      <span className="notification-dot" aria-hidden="true" />
                      <span>
                        <strong>{notificationCopy(notification)}</strong>
                        <span>
                          {notification.page.icon ?? "□"} {notification.page.title}
                        </span>
                        <time dateTime={new Date(notification.createdAt).toISOString()}>
                          {DATE_TIME_FORMAT.format(notification.createdAt)}
                        </time>
                      </span>
                    </button>
                    <button
                      className="notification-archive"
                      aria-label={`Archive notification for ${notification.page.title}`}
                      onClick={() => void mark("archive", [notification.id])}
                    >
                      ×
                    </button>
                  </li>
                ))}
                {hasMore && (
                  <li className="notification-more">
                    <button className="quiet-button" disabled={loading} onClick={() => void load(notifications.length)}>
                      Load more
                    </button>
                  </li>
                )}
              </ol>
            ) : loading ? (
              <div className="activity-empty">
                <p>Loading notifications…</p>
              </div>
            ) : (
              <div className="activity-empty">
                <span aria-hidden="true">◌</span>
                <h3>{unreadOnly ? "You’re caught up" : "No notifications yet"}</h3>
                <p>Mentions, replies, and watched page updates will appear here.</p>
              </div>
            )}
          </>
        )}
      </dialog>
    </>
  );
}
