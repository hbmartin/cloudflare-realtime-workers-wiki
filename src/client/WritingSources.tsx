import { useState } from "react";
import type { AiSource } from "../shared/ai";
import type { DiagramContentEnvelope, DocumentContentEnvelope, Page } from "../shared/types";
import { flattenDocumentBlocks } from "../shared/notion-blocks";
import { serializeDocument } from "../shared/document-projection";
import { api, apiErrorMessage } from "./api";

export function WritingSources({
  sources,
  pages,
  pageId,
  onChange,
  onSelection,
  disabled,
}: {
  sources: AiSource[];
  pages: Page[];
  pageId: string;
  onChange: (sources: AiSource[]) => void;
  onSelection: () => void;
  disabled: boolean;
}) {
  const [configuring, setConfiguring] = useState<string | null>(null),
    [choices, setChoices] = useState<{ id: string; text: string }[]>([]),
    [epoch, setEpoch] = useState(0),
    [error, setError] = useState("");
  const update = (id: string, scope: AiSource["scope"]) =>
    onChange(sources.map((source) => (source.pageId === id ? { ...source, scope } : source)));
  async function configure(page: Page) {
    setConfiguring(page.id);
    setChoices([]);
    setError("");
    try {
      const envelope = await api<DocumentContentEnvelope | DiagramContentEnvelope>(`/api/pages/${page.id}/content`);
      setEpoch(envelope.contentEpoch);
      setChoices(
        "nodes" in envelope
          ? envelope.nodes.map((node) => ({ id: node.id, text: node.label || node.notes || "Untitled node" }))
          : flattenDocumentBlocks(envelope.document).map((block) => ({
              id: block.internalId,
              text: serializeDocument({ type: "doc", content: [block.node] }).plainText || `[${block.type}]`,
            })),
      );
    } catch (cause) {
      setError(apiErrorMessage(cause, "The source scope could not be loaded."));
    }
  }
  return (
    <fieldset disabled={disabled} className="writing-sources">
      <legend>Sources ({sources.length}/20)</legend>
      <p className="muted">Complete chosen scopes are included. Attachment contents are excluded.</p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {sources.map((source) => {
        const page = pages.find((item) => item.id === source.pageId);
        const kind = page?.kind ?? "document";
        return (
          <div key={source.pageId} className="writing-source">
            <strong>{page?.title || (source.pageId === pageId ? "Current document" : "Referenced page")}</strong>
            <small>
              {source.scope.kind === "page"
                ? "Entire page"
                : source.scope.kind === "selection"
                  ? "Selected text"
                  : source.scope.kind === "blocks"
                    ? `${source.scope.blockIds.length} blocks`
                    : source.scope.kind === "diagram"
                      ? `${source.scope.nodeIds.length} nodes and their connecting edges`
                      : "Filtered table rows"}
            </small>
            <button type="button" onClick={() => update(source.pageId, { kind: "page" })}>
              Use entire page
            </button>
            {source.pageId === pageId && (
              <button type="button" onClick={onSelection}>
                Use selected text
              </button>
            )}
            {kind === "table" ? (
              <label>
                Filter rows by text
                <input
                  value={source.scope.kind === "table" ? source.scope.filter : ""}
                  onChange={(event) => update(source.pageId, { kind: "table", filter: event.target.value })}
                />
              </label>
            ) : (
              page && (
                <button type="button" onClick={() => void configure(page)}>
                  Choose {kind === "diagram" ? "nodes" : "blocks"}
                </button>
              )
            )}
            {source.pageId !== pageId && (
              <button type="button" onClick={() => onChange(sources.filter((item) => item.pageId !== source.pageId))}>
                Remove source
              </button>
            )}
            {configuring === source.pageId && (
              <div className="writing-source-choices">
                <p>Select at least one {kind === "diagram" ? "node" : "block"}.</p>
                {choices.map((choice) => {
                  const selected =
                    source.scope.kind === "blocks"
                      ? source.scope.blockIds
                      : source.scope.kind === "diagram"
                        ? source.scope.nodeIds
                        : [];
                  return (
                    <label key={choice.id}>
                      <input
                        type="checkbox"
                        checked={selected.includes(choice.id)}
                        onChange={(event) => {
                          const ids = event.target.checked
                            ? [...selected, choice.id]
                            : selected.filter((id) => id !== choice.id);
                          update(
                            source.pageId,
                            kind === "diagram"
                              ? { kind: "diagram", nodeIds: ids }
                              : { kind: "blocks", blockIds: ids, contentEpoch: epoch },
                          );
                        }}
                      />
                      {choice.text.slice(0, 160)}
                    </label>
                  );
                })}
                <button type="button" onClick={() => setConfiguring(null)}>
                  Done choosing scope
                </button>
              </div>
            )}
          </div>
        );
      })}
      <label>
        Add an explicit reference
        <select
          value=""
          disabled={disabled || sources.length >= 20}
          onChange={(event) => {
            if (event.target.value) onChange([...sources, { pageId: event.target.value, scope: { kind: "page" } }]);
          }}
        >
          <option value="">Choose a page…</option>
          {pages
            .filter((page) => !sources.some((source) => source.pageId === page.id))
            .map((page) => (
              <option key={page.id} value={page.id}>
                {page.title || "Untitled"} ({page.kind})
              </option>
            ))}
        </select>
      </label>
    </fieldset>
  );
}
