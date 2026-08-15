import { BlockNoteSchema, defaultBlockSpecs, defaultInlineContentSpecs, defaultStyleSpecs } from "@blocknote/core";
import { createReactInlineContentSpec } from "@blocknote/react";
import { useState } from "react";
import type { PagePreview } from "../shared/types";
import { api } from "./api";

export const PAGE_NAVIGATE_EVENT = "notes:navigate-page";

const previewCache = new Map<string, Promise<PagePreview>>();

export function invalidatePagePreview(pageId: string) {
  previewCache.delete(pageId);
}

function loadPreview(pageId: string) {
  let pending = previewCache.get(pageId);
  if (!pending) {
    pending = api<{ preview: PagePreview }>(`/api/pages/${pageId}/preview`).then((data) => data.preview);
    previewCache.set(pageId, pending);
    pending.catch(() => previewCache.delete(pageId));
  }
  return pending;
}

function MentionChip({
  entityType,
  entityId,
  label,
  contentRef,
}: {
  entityType: "page" | "user";
  entityId: string;
  label: string;
  contentRef: (element: HTMLElement | null) => void;
}) {
  const [preview, setPreview] = useState<PagePreview | null>(null);
  const [open, setOpen] = useState(false);

  const showPreview = () => {
    if (entityType !== "page") return;
    setOpen(true);
    void loadPreview(entityId)
      .then(setPreview)
      .catch(() => setPreview(null));
  };

  if (entityType === "user") {
    return (
      <span ref={contentRef} className="mention-chip mention-user">
        @{label}
      </span>
    );
  }

  return (
    <span ref={contentRef} className="mention-wrap" onMouseEnter={showPreview} onMouseLeave={() => setOpen(false)}>
      <button
        type="button"
        className="mention-chip mention-page"
        onFocus={showPreview}
        onBlur={() => setOpen(false)}
        onClick={() => window.dispatchEvent(new CustomEvent(PAGE_NAVIGATE_EVENT, { detail: entityId }))}
      >
        @{label}
      </button>
      {open && (
        <span className="mention-preview" role="tooltip">
          {preview ? (
            <>
              <strong>
                {preview.page.icon ?? "□"} {preview.page.title}
              </strong>
              <span>{preview.excerpt || "No preview yet."}</span>
            </>
          ) : (
            <span>Loading preview…</span>
          )}
        </span>
      )}
    </span>
  );
}

const mentionInlineSpec = createReactInlineContentSpec(
  {
    type: "mention",
    content: "none",
    propSchema: {
      entityType: { default: "page", values: ["page", "user"] as const },
      entityId: { default: "" },
      label: { default: "" },
    },
  } as const,
  {
    render: ({ inlineContent, contentRef }) => (
      <MentionChip
        entityType={inlineContent.props.entityType}
        entityId={inlineContent.props.entityId}
        label={inlineContent.props.label}
        contentRef={contentRef}
      />
    ),
    toExternalHTML: ({ inlineContent, contentRef }) => <span ref={contentRef}>@{inlineContent.props.label}</span>,
  },
);

export const notesSchema = BlockNoteSchema.create({
  blockSpecs: defaultBlockSpecs,
  inlineContentSpecs: { ...defaultInlineContentSpecs, mention: mentionInlineSpec },
  styleSpecs: defaultStyleSpecs,
});
