import { createContext, useCallback, useContext, useRef, useState } from "react";
import type { DateMention } from "../shared/date-mentions";
import { formatDateMention } from "../shared/date-mentions";
import { DateMentionPicker } from "./DateMentionPicker";

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
      <button
        ref={button}
        type="button"
        className="date-mention-chip"
        disabled={!context?.editable}
        onClick={openPicker}
        aria-label={`Date: ${formatDateMention(value)}${context?.editable ? ". Edit date" : ""}`}
      >
        <span aria-hidden="true">▦</span> {formatDateMention(value)}
      </button>
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
    </span>
  );
}
