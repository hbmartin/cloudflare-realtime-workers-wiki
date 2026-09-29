import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { DateMention } from "../shared/date-mentions";
import {
  dateMentionLocalFields,
  formatDateMention,
  resolveLocalDateTime,
  validCalendarDate,
} from "../shared/date-mentions";

export const DateMentionContext = createContext<{ pageId: string; userId: string } | null>(null);
export const DATE_MENTION_EDIT_EVENT = "notes:edit-date-mention";

export function DateMentionChip({
  value,
  contentRef,
  update,
}: {
  value: DateMention;
  contentRef: (element: HTMLElement | null) => void;
  update: (value: DateMention) => void;
}) {
  const context = useContext(DateMentionContext);
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState(value.kind);
  const [date, setDate] = useState(dateMentionLocalFields(value)?.date ?? "");
  const [time, setTime] = useState(dateMentionLocalFields(value)?.time ?? "09:00");
  const [error, setError] = useState("");
  const [position, setPosition] = useState({ top: 40, left: 20 });

  const openPicker = useCallback(() => {
    const local = dateMentionLocalFields(value);
    const rectangle = button.current?.getBoundingClientRect();
    setPosition({
      top: Math.max(8, Math.min(rectangle?.bottom ?? 40, window.innerHeight - 280)),
      left: Math.max(8, Math.min(rectangle?.left ?? 20, window.innerWidth - 290)),
    });
    setKind(value.kind);
    setDate(local?.date ?? "");
    setTime(local?.time ?? "09:00");
    setError("");
    setOpen(true);
  }, [value]);

  useEffect(() => {
    const edit = (event: Event) => {
      if ((event as CustomEvent<string>).detail === value.tokenId) openPicker();
    };
    window.addEventListener(DATE_MENTION_EDIT_EVENT, edit);
    return () => window.removeEventListener(DATE_MENTION_EDIT_EVENT, edit);
  }, [value.tokenId, openPicker]);
  const save = () => {
    if (!validCalendarDate(date)) {
      setError("Choose a valid date.");
      return;
    }
    const [hour, minute] = time.split(":").map(Number);
    const instant = kind === "timed" ? resolveLocalDateTime(date, value.timezone, hour!, minute!) : null;
    if (kind === "timed" && instant === null) {
      setError("Choose a valid time.");
      return;
    }
    update({
      ...value,
      kind,
      value: kind === "timed" ? new Date(instant!).toISOString() : date,
      revision: crypto.randomUUID(),
    });
    setOpen(false);
    button.current?.focus();
  };
  return (
    <span ref={contentRef} className="date-mention-wrap">
      <button
        ref={button}
        type="button"
        className="date-mention-chip"
        onClick={openPicker}
        aria-label={`Date: ${formatDateMention(value)}. Edit date`}
      >
        <span aria-hidden="true">▦</span> {formatDateMention(value)}
      </button>
      {open &&
        createPortal(
          <dialog
            open
            aria-label="Edit date mention"
            className="date-mention-picker"
            style={position}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setOpen(false);
                button.current?.focus();
              }
            }}
          >
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
            <p className="muted">Timezone: {value.timezone}</p>
            {context?.userId === value.createdBy && <p className="muted">Reminder settings are private to you.</p>}
            {error && <p role="alert">{error}</p>}
            <div className="date-mention-actions">
              <button type="button" onClick={save}>
                Save date
              </button>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  button.current?.focus();
                }}
              >
                Cancel
              </button>
            </div>
          </dialog>,
          document.body,
        )}
    </span>
  );
}
