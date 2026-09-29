import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  dateMentionDueAt,
  dateMentionLocalFields,
  resolveLocalDateTime,
  type DateMention,
  type ReminderChoice,
} from "../shared/date-mentions";
import { api, apiErrorMessage, json } from "./api";

type SavedReminder = {
  id: string;
  tokenId: string;
  revision: string;
  choice: ReminderChoice | { absolute: string };
  dueAt: number;
  generation: number;
  state: "active" | "claimed" | "delivered";
};

const OPTIONS: Array<{ value: ReminderChoice | "custom"; label: string }> = [
  { value: "at_time", label: "At the date and time" },
  { value: "5m_before", label: "5 minutes before" },
  { value: "1h_before", label: "1 hour before" },
  { value: "1d_before", label: "1 day before" },
  { value: "custom", label: "Choose a time" },
];

export function DateReminderPicker({
  pageId,
  token,
  onClose,
}: {
  pageId: string;
  token: DateMention;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const openedRevision = useRef(token.revision);
  const [saved, setSaved] = useState<SavedReminder | null>(null);
  const [choice, setChoice] = useState<ReminderChoice | "custom">("at_time");
  const local = dateMentionLocalFields(token);
  const [customDate, setCustomDate] = useState(local?.date ?? "");
  const [customTime, setCustomTime] = useState(local?.time ?? "09:00");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const path = `/api/pages/${encodeURIComponent(pageId)}/date-reminders/${encodeURIComponent(token.tokenId)}`;

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    let live = true;
    void api<{ reminder: SavedReminder | null }>(path)
      .then(({ reminder }) => {
        if (!live) return;
        setSaved(reminder);
        if (reminder) setChoice(typeof reminder.choice === "string" ? reminder.choice : "custom");
        if (reminder && typeof reminder.choice !== "string") {
          const date = new Date(reminder.choice.absolute);
          const parts = new Intl.DateTimeFormat("en-CA", {
            timeZone: token.timezone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            hourCycle: "h23",
          }).formatToParts(date);
          const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
          setCustomDate(`${part("year")}-${part("month")}-${part("day")}`);
          setCustomTime(`${part("hour")}:${part("minute")}`);
        }
      })
      .catch((cause: unknown) => {
        if (live) setError(apiErrorMessage(cause, "Reminder could not be loaded."));
      })
      .finally(() => {
        if (live) setBusy(false);
      });
    return () => {
      live = false;
    };
  }, [path, token.timezone]);

  useEffect(() => {
    if (!busy) (dialog.current?.querySelector("select") as HTMLElement | null)?.focus();
  }, [busy]);

  const reminderChoice = (): ReminderChoice | { absolute: string } | null => {
    if (choice !== "custom") return choice;
    const [hour, minute] = customTime.split(":").map(Number);
    const instant = resolveLocalDateTime(customDate, token.timezone, hour!, minute!);
    return instant === null ? null : { absolute: new Date(instant).toISOString() };
  };
  const selected = reminderChoice();
  const dueAt = selected ? dateMentionDueAt(token, selected) : null;

  const save = async () => {
    if (openedRevision.current !== token.revision) {
      setError("This date changed. Close and reopen the reminder to see the latest value.");
      return;
    }
    if (dueAt === null || !selected) {
      setError("Choose a future reminder time.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api(path, { method: "PUT", body: json({ revision: token.revision, choice: selected }) });
      onClose();
    } catch (cause) {
      setError(apiErrorMessage(cause, "Reminder could not be saved."));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError("");
    try {
      await api(path, { method: "DELETE" });
      onClose();
    } catch (cause) {
      setError(apiErrorMessage(cause, "Reminder could not be removed."));
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <dialog ref={dialog} aria-label="Remind me" className="date-mention-picker" onClose={onClose}>
      <h2>Remind me</h2>
      <label>
        When
        <select
          value={choice}
          disabled={busy}
          onChange={(event) => setChoice(event.target.value as ReminderChoice | "custom")}
        >
          {OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      {choice === "custom" && (
        <>
          <label>
            Date <input type="date" value={customDate} onChange={(event) => setCustomDate(event.target.value)} />
          </label>
          <label>
            Time <input type="time" value={customTime} onChange={(event) => setCustomTime(event.target.value)} />
          </label>
        </>
      )}
      <p className="muted">Timezone: {token.timezone}</p>
      {dueAt !== null && (
        <p>
          Reminder:{" "}
          {new Intl.DateTimeFormat(undefined, {
            dateStyle: "medium",
            timeStyle: "short",
            timeZone: token.timezone,
          }).format(dueAt)}{" "}
          ({token.timezone})
        </p>
      )}
      {saved?.state === "delivered" && <p>This reminder was delivered.</p>}
      {error && <p role="alert">{error}</p>}
      <div className="date-mention-actions">
        <button type="button" onClick={() => void save()} disabled={busy}>
          Save reminder
        </button>
        {saved && (
          <button type="button" onClick={() => void remove()} disabled={busy}>
            Remove reminder
          </button>
        )}
        <button type="button" onClick={onClose}>
          Cancel
        </button>
      </div>
    </dialog>,
    document.body,
  );
}
