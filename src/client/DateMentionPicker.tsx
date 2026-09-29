import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { DateMention } from "../shared/date-mentions";
import { dateMentionLocalFields, resolveLocalDateTime, validCalendarDate } from "../shared/date-mentions";

export function DateMentionPicker({
  initial,
  label,
  onSave,
  onClose,
}: {
  initial: DateMention;
  label: string;
  onSave: (next: DateMention) => string | null;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const local = dateMentionLocalFields(initial);
  const [kind, setKind] = useState(initial.kind);
  const [date, setDate] = useState(local?.date ?? "");
  const [time, setTime] = useState(local?.time ?? "09:00");
  const [error, setError] = useState("");

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    element?.querySelector<HTMLInputElement>('input[type="date"]')?.focus();
  }, []);

  const save = () => {
    if (!validCalendarDate(date)) {
      setError("Choose a valid date.");
      return;
    }
    const [hour, minute] = time.split(":").map(Number);
    const instant = kind === "timed" ? resolveLocalDateTime(date, initial.timezone, hour!, minute!) : null;
    if (kind === "timed" && instant === null) {
      setError("Choose a valid time.");
      return;
    }
    const failure = onSave({
      ...initial,
      kind,
      value: kind === "timed" ? new Date(instant!).toISOString() : date,
    });
    if (failure) setError(failure);
    else onClose();
  };

  return createPortal(
    <dialog ref={dialog} aria-label={label} className="date-mention-picker" onClose={onClose}>
      <label>
        Date <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
      </label>
      <label>
        Type{" "}
        <select value={kind} onChange={(event) => setKind(event.target.value as DateMention["kind"])}>
          <option value="all-day">All day</option>
          <option value="timed">At a time</option>
        </select>
      </label>
      {kind === "timed" && (
        <label>
          Time <input type="time" value={time} onChange={(event) => setTime(event.target.value)} />
        </label>
      )}
      <p className="muted">Timezone: {initial.timezone}</p>
      {error && <p role="alert">{error}</p>}
      <div className="date-mention-actions">
        <button type="button" onClick={save}>
          Save date
        </button>
        <button type="button" onClick={onClose}>
          Cancel
        </button>
      </div>
    </dialog>,
    document.body,
  );
}
