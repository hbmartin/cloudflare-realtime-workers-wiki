import { createContext, useCallback, useContext, useRef, useState } from "react";
import type { DateMention } from "../shared/date-mentions";
import { formatDateMention } from "../shared/date-mentions";
import { DateMentionPicker } from "./DateMentionPicker";
import { DateReminderPicker } from "./DateReminderPicker";

export const DateMentionContext = createContext<{ pageId: string; userId: string; editable: boolean } | null>(null);

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
  const openedRevision = useRef(value.revision);
  const [open, setOpen] = useState(false);
  const [reminderOpen, setReminderOpen] = useState(false);
  const reminderButton = useRef<HTMLButtonElement>(null);
  const label = formatDateMention(value);

  const openPicker = useCallback(() => {
    if (!context?.editable) return;
    openedRevision.current = value.revision;
    setOpen(true);
  }, [context?.editable, value.revision]);

  const closePicker = () => {
    setOpen(false);
    button.current?.focus();
  };

  return (
    <span ref={contentRef} className="date-mention-wrap">
      {context?.editable ? (
        <button
          ref={button}
          type="button"
          className="date-mention-chip"
          onClick={openPicker}
          aria-label={`Date: ${label}. Edit date`}
        >
          <span aria-hidden="true">▦</span> {label}
        </button>
      ) : (
        <span className="date-mention-chip">
          <span aria-hidden="true">▦</span> {label}
        </span>
      )}
      {context?.userId === value.createdBy && (
        <button
          ref={reminderButton}
          type="button"
          className="date-mention-reminder"
          onClick={() => setReminderOpen(true)}
          aria-label={`Remind me about ${label}`}
        >
          Remind me
        </button>
      )}
      {open && (
        <DateMentionPicker
          initial={value}
          label="Edit date mention"
          onSave={(next) => {
            if (!context?.editable) return "This date is read only.";
            if (openedRevision.current !== value.revision)
              return "This date changed while the picker was open. Close and reopen it to see the latest value.";
            update({ ...next, revision: crypto.randomUUID() });
            return null;
          }}
          onClose={closePicker}
        />
      )}
      {reminderOpen && context?.userId === value.createdBy && (
        <DateReminderPicker
          pageId={context.pageId}
          token={value}
          onClose={() => {
            setReminderOpen(false);
            reminderButton.current?.focus();
          }}
        />
      )}
    </span>
  );
}
