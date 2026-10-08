import {
  BlockNoteSchema,
  createCodeBlockSpec,
  defaultBlockSpecs,
  defaultInlineContentSpecs,
  defaultStyleSpecs,
} from "@blocknote/core";
import { createReactInlineContentSpec } from "@blocknote/react";
import { useState } from "react";
import { mentionInlineConfig } from "../shared/mention-spec";
import { dateMentionInlineConfig } from "../shared/date-mention-spec";
import { dateMentionFromProps, dateMentionWireProps, formatDateMention } from "../shared/date-mentions";
import type { PagePreview } from "../shared/types";
import { api } from "./api";
import { coreBlockSpecs, inlineMathSpec } from "./editor-blocks";
import { DateMentionChip } from "./DateMentionChip";

export const PAGE_NAVIGATE_EVENT = "notes:navigate-page";

const previewCache = new Map<string, Promise<PagePreview>>();

export function invalidatePagePreview(pageId: string) {
  previewCache.delete(pageId);
}

export function invalidateAllPagePreviews() {
  previewCache.clear();
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

const mentionInlineSpec = createReactInlineContentSpec(mentionInlineConfig, {
  render: ({ inlineContent, contentRef }) => (
    <MentionChip
      entityType={inlineContent.props.entityType}
      entityId={inlineContent.props.entityId}
      label={inlineContent.props.label}
      contentRef={contentRef}
    />
  ),
  toExternalHTML: ({ inlineContent, contentRef }) => <span ref={contentRef}>@{inlineContent.props.label}</span>,
});

const dateMentionInlineSpec = createReactInlineContentSpec(dateMentionInlineConfig, {
  render: ({ inlineContent, contentRef, updateInlineContent }) => {
    const value = dateMentionFromProps(inlineContent.props);
    return value ? (
      <DateMentionChip
        value={value}
        contentRef={contentRef}
        update={(next) => updateInlineContent({ type: "dateMention", props: dateMentionWireProps(next) })}
      />
    ) : (
      <span ref={contentRef}>Date</span>
    );
  },
  toExternalHTML: ({ inlineContent, contentRef }) => {
    const value = dateMentionFromProps(inlineContent.props);
    return <span ref={contentRef}>{value ? formatDateMention(value) : "Date"}</span>;
  },
});

const codeLanguages = {
  text: { name: "Plain text" },
  javascript: { name: "JavaScript", aliases: ["js"] },
  typescript: { name: "TypeScript", aliases: ["ts"] },
  json: { name: "JSON" },
  html: { name: "HTML" },
  css: { name: "CSS" },
  bash: { name: "Bash", aliases: ["sh"] },
  python: { name: "Python", aliases: ["py"] },
  sql: { name: "SQL" },
  markdown: { name: "Markdown", aliases: ["md"] },
};
export function codeLanguageForPicker(language: string) {
  return Object.hasOwn(codeLanguages, language) ? language : "text";
}
const codeBlockBase = createCodeBlockSpec({ supportedLanguages: codeLanguages });
const codeBlock = {
  ...codeBlockBase,
  implementation: {
    ...codeBlockBase.implementation,
    render: function (
      this: ThisParameterType<typeof codeBlockBase.implementation.render>,
      block: Parameters<typeof codeBlockBase.implementation.render>[0],
      editor: Parameters<typeof codeBlockBase.implementation.render>[1],
    ): ReturnType<typeof codeBlockBase.implementation.render> {
      const rendered = codeBlockBase.implementation.render.call(
        this,
        {
          ...block,
          props: {
            ...block.props,
            language: codeLanguageForPicker(block.props.language),
          },
        },
        editor,
      );
      if (this.renderType !== "nodeView" || !rendered.contentDOM) return rendered;

      const code = rendered.contentDOM;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "code-copy-button";
      button.textContent = "Copy code";
      button.contentEditable = "false";
      button.setAttribute("aria-label", "Copy code");
      rendered.dom.appendChild(button);

      let destroyed = false;
      let resetTimer: number | undefined;
      const copy = async () => {
        try {
          await navigator.clipboard.writeText(code.textContent ?? "");
          if (destroyed) return;
          window.clearTimeout(resetTimer);
          button.textContent = "Copied";
          resetTimer = window.setTimeout(() => {
            button.textContent = "Copy code";
          }, 2_000);
        } catch {
          if (destroyed) return;
          window.clearTimeout(resetTimer);
          button.textContent = "Copy failed";
        }
      };
      const onClick = () => void copy();
      button.addEventListener("click", onClick);

      return {
        ...rendered,
        ignoreMutation: (mutation) => {
          // Only the copy control belongs to us. Native edits beside contentDOM
          // must still reach ProseMirror, including mobile paragraph splits.
          if (mutation.type !== "selection" && button.contains(mutation.target)) return true;
          return rendered.ignoreMutation?.(mutation) ?? false;
        },
        destroy: () => {
          destroyed = true;
          window.clearTimeout(resetTimer);
          button.removeEventListener("click", onClick);
          rendered.destroy?.();
        },
      };
    },
  },
};

export const notesSchema = BlockNoteSchema.create({
  blockSpecs: { ...defaultBlockSpecs, codeBlock, ...coreBlockSpecs },
  inlineContentSpecs: {
    ...defaultInlineContentSpecs,
    mention: mentionInlineSpec,
    dateMention: dateMentionInlineSpec,
    inlineMath: inlineMathSpec,
  },
  styleSpecs: defaultStyleSpecs,
});

// Imported Slack replies use these blocks and the same verified mention chip as documents.
// Keep the comment surface smaller than the document editor (no embeds or attachments).
export const notesCommentSchema = BlockNoteSchema.create({
  blockSpecs: {
    paragraph: defaultBlockSpecs.paragraph,
    quote: defaultBlockSpecs.quote,
    codeBlock: defaultBlockSpecs.codeBlock,
  },
  inlineContentSpecs: { ...defaultInlineContentSpecs, mention: mentionInlineSpec },
  styleSpecs: defaultStyleSpecs,
});
