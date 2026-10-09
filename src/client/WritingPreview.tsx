import { createElement, memo, useMemo, type ReactNode } from "react";
import type { ProseMirrorJson } from "../shared/types";
import { parseAiMarkdown } from "../shared/ai-writing";

function renderBlocks(nodes: ProseMirrorJson[]): ReactNode[] {
  let ordinal = 0;
  return nodes.map((node, index) => {
    const block = node.type === "blockContainer" ? node.content?.[0] : node;
    ordinal = block?.type === "numberedListItem" ? ordinal + 1 : 0;
    return renderNode(node, index, ordinal || 1);
  });
}
function renderNode(node: ProseMirrorJson, index: number, ordinal = 1): ReactNode {
  const children =
    node.type === "blockGroup"
      ? renderBlocks(node.content ?? [])
      : (node.content ?? []).map((child, childIndex) => renderNode(child, childIndex, ordinal));
  if (node.type === "text") {
    let value: ReactNode = node.text;
    for (const mark of node.marks ?? []) {
      if (mark.type === "bold") value = <strong>{value}</strong>;
      else if (mark.type === "italic") value = <em>{value}</em>;
      else if (mark.type === "strike") value = <s>{value}</s>;
      else if (mark.type === "code") value = <code>{value}</code>;
      else if (mark.type === "link" && typeof mark.attrs?.href === "string")
        value = (
          <a href={mark.attrs.href} target="_blank" rel="noopener noreferrer">
            {value}
          </a>
        );
    }
    return <span key={index}>{value}</span>;
  }
  if (node.type === "heading") {
    const level = Math.min(6, Math.max(1, Number(node.attrs?.level ?? 1)));
    return createElement(`h${level}`, { key: index, className: `writing-heading writing-heading-${level}` }, children);
  }
  if (node.type === "codeBlock")
    return (
      <pre key={index}>
        <code>{children}</code>
      </pre>
    );
  if (node.type === "quote") return <blockquote key={index}>{children}</blockquote>;
  if (node.type === "divider") return <hr key={index} />;
  if (node.type === "hardBreak") return <br key={index} />;
  if (["bulletListItem", "numberedListItem", "checkListItem"].includes(node.type ?? ""))
    return (
      <div key={index} className="writing-list-item">
        <span aria-hidden="true">
          {node.type === "numberedListItem"
            ? `${ordinal}.`
            : node.type === "checkListItem"
              ? node.attrs?.checked
                ? "☑"
                : "☐"
              : "•"}
        </span>
        <span>{children}</span>
      </div>
    );
  if (node.type === "paragraph") return <p key={index}>{children}</p>;
  return <div key={index}>{children}</div>;
}
export function useWritingMarkdown(markdown: string) {
  return useMemo(() => {
    if (!markdown) return { blocks: null, error: "" };
    try {
      return { blocks: parseAiMarkdown(markdown), error: "" };
    } catch (cause) {
      return {
        blocks: null,
        error: cause instanceof Error ? cause.message : "The result cannot be safely applied. Copy or refine it.",
      };
    }
  }, [markdown]);
}
export const WritingPreview = memo(function WritingPreview({
  markdown,
  blocks: parsed,
}: {
  markdown: string;
  blocks?: ProseMirrorJson[] | null;
}) {
  const content = useMemo(() => {
    try {
      return renderBlocks(parsed === undefined ? parseAiMarkdown(markdown) : (parsed ?? []));
    } catch {
      return null;
    }
  }, [markdown, parsed]);
  return content && parsed !== null ? (
    <div className="writing-preview" aria-label="Writing result">
      {content}
    </div>
  ) : (
    <pre className="writing-preview" aria-label="Writing result">
      {markdown}
    </pre>
  );
});
