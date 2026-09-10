import { renderToString } from "katex";
import { createReactBlockSpec, createReactInlineContentSpec } from "@blocknote/react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { notionBlockRegistry } from "../shared/notion-blocks";
import { api, apiErrorMessage, json } from "./api";
import type { Page, SearchTitleSuggestion } from "../shared/types";
import "katex/dist/katex.min.css";

const CALLOUT_TONES = ["info", "success", "warning", "danger"] as const;

export function renderedMath(formula: string, displayMode: boolean) {
  return renderToString(formula || "\\text{Empty formula}", {
    displayMode,
    output: "html",
    throwOnError: false,
    strict: "error",
    trust: false,
  });
}

const callout = createReactBlockSpec(
  {
    type: "callout",
    propSchema: {
      icon: { default: "💡" },
      tone: { default: "info", values: CALLOUT_TONES },
    },
    content: "inline",
  },
  {
    render: ({ block, editor, contentRef }) => (
      <aside className={`editor-callout tone-${block.props.tone}`}>
        {editor.isEditable ? (
          <input
            className="callout-icon"
            aria-label="Callout icon"
            value={block.props.icon}
            maxLength={4}
            contentEditable={false}
            onChange={(event) => editor.updateBlock(block, { props: { icon: event.target.value } })}
          />
        ) : (
          <span className="callout-icon-readonly">{block.props.icon}</span>
        )}
        <div className="callout-content" ref={contentRef} />
        {editor.isEditable && (
          <label className="callout-tone" contentEditable={false}>
            <span className="visually-hidden">Callout tone</span>
            <select
              aria-label="Callout tone"
              value={block.props.tone}
              onChange={(event) =>
                editor.updateBlock(block, { props: { tone: event.target.value as (typeof CALLOUT_TONES)[number] } })
              }
            >
              {CALLOUT_TONES.map((tone) => (
                <option key={tone} value={tone}>
                  {tone}
                </option>
              ))}
            </select>
          </label>
        )}
      </aside>
    ),
    toExternalHTML: ({ block, contentRef }) => (
      <aside className={`callout callout-${block.props.tone}`}>
        <span>{block.props.icon}</span>
        <div ref={contentRef} />
      </aside>
    ),
  },
)();

function MathBlock({ formula, update }: { formula: string; update?: (formula: string) => void }) {
  return (
    <div className="editor-math-block">
      <div className="math-preview" dangerouslySetInnerHTML={{ __html: renderedMath(formula, true) }} />
      {update && (
        <label contentEditable={false}>
          <span className="visually-hidden">Math formula</span>
          <textarea
            aria-label="Math formula"
            value={formula}
            rows={2}
            spellCheck={false}
            onChange={(event) => update(event.target.value)}
          />
        </label>
      )}
    </div>
  );
}

const math = createReactBlockSpec(
  {
    type: "math",
    propSchema: { formula: { default: "E = mc^2" } },
    content: "none",
  },
  {
    render: ({ block, editor }) => (
      <MathBlock
        formula={block.props.formula}
        update={editor.isEditable ? (formula) => editor.updateBlock(block, { props: { formula } }) : undefined}
      />
    ),
    toExternalHTML: ({ block }) => <MathBlock formula={block.props.formula} />,
  },
)();

export function MermaidBlock({ source, update }: { source: string; update?: (source: string) => void }) {
  const [colorScheme, setColorScheme] = useState<"light" | "dark">(() =>
    document.documentElement.getAttribute("data-mantine-color-scheme") === "dark" ? "dark" : "light",
  );
  const renderBaseId = `notes-mermaid-${useId().replaceAll(":", "")}`;
  const renderSequence = useRef(0);
  const [preview, setPreview] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const root = document.documentElement;
    const updateTheme = () =>
      setColorScheme(root.getAttribute("data-mantine-color-scheme") === "dark" ? "dark" : "light");
    const observer = new MutationObserver(updateTheme);
    observer.observe(root, { attributes: true, attributeFilter: ["data-mantine-color-scheme"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let active = true;
    const renderId = `${renderBaseId}-${++renderSequence.current}`;
    void import("mermaid")
      .then(async ({ default: mermaid }) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          suppressErrorRendering: true,
          theme: colorScheme === "dark" ? "dark" : "default",
        });
        const { svg } = await mermaid.render(renderId, source);
        if (!active) return;
        setPreview(`<!doctype html><html><body>${svg}</body></html>`);
        setError("");
      })
      .catch(() => {
        if (!active) return;
        setPreview("");
        setError("This diagram could not be rendered. Check its Mermaid syntax.");
      });
    return () => {
      active = false;
    };
  }, [colorScheme, renderBaseId, source]);

  return (
    <div className="editor-mermaid">
      {preview ? (
        <iframe title="Mermaid diagram preview" sandbox="" srcDoc={preview} />
      ) : (
        <div className="diagram-placeholder">{error || "Rendering diagram…"}</div>
      )}
      {update && (
        <label contentEditable={false}>
          <span className="visually-hidden">Mermaid source</span>
          <textarea
            aria-label="Mermaid source"
            value={source}
            rows={4}
            spellCheck={false}
            onChange={(event) => update(event.target.value)}
          />
        </label>
      )}
    </div>
  );
}

const mermaid = createReactBlockSpec(
  {
    type: "mermaid",
    propSchema: { source: { default: "flowchart LR\n  A[Start] --> B[Done]" } },
    content: "none",
  },
  {
    render: ({ block, editor }) => (
      <MermaidBlock
        source={block.props.source}
        update={editor.isEditable ? (source) => editor.updateBlock(block, { props: { source } }) : undefined}
      />
    ),
    toExternalHTML: ({ block }) => <pre className="mermaid">{block.props.source}</pre>,
  },
)();

const columns = createReactBlockSpec(
  {
    type: "columns",
    propSchema: { count: { default: 2, values: [2, 3] } },
    content: "inline",
  },
  {
    render: ({ block, editor, contentRef }) => (
      <div className="editor-columns" style={{ "--column-count": block.props.count } as CSSProperties}>
        <div ref={contentRef} />
        {editor.isEditable && (
          <label contentEditable={false}>
            <span className="visually-hidden">Column count</span>
            <select
              aria-label="Column count"
              value={block.props.count}
              onChange={(event) => editor.updateBlock(block, { props: { count: Number(event.target.value) as 2 | 3 } })}
            >
              <option value={2}>2 columns</option>
              <option value={3}>3 columns</option>
            </select>
          </label>
        )}
      </div>
    ),
    toExternalHTML: ({ block, contentRef }) => (
      <div className="columns" data-columns={block.props.count}>
        <div ref={contentRef} />
      </div>
    ),
  },
)();

export function allowedEmbedUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    if (url.hostname === "youtu.be") return `https://www.youtube-nocookie.com/embed/${url.pathname.slice(1)}`;
    if (url.hostname === "www.youtube.com" || url.hostname === "youtube.com") {
      const id = url.pathname.startsWith("/embed/") ? url.pathname.slice(7) : url.searchParams.get("v");
      return id ? `https://www.youtube-nocookie.com/embed/${id}` : null;
    }
    if (url.hostname === "vimeo.com" && /^\/\d+$/.test(url.pathname)) {
      return `https://player.vimeo.com/video/${url.pathname.slice(1)}`;
    }
    if (url.hostname === "www.figma.com" || url.hostname === "figma.com") {
      return `https://www.figma.com/embed?embed_host=notes&url=${encodeURIComponent(url.href)}`;
    }
    return null;
  } catch {
    return null;
  }
}

export function safeBookmarkUrl(value: string) {
  try {
    const url = new URL(value);
    return ["https:", "http:", "mailto:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

export function safePdfUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

function EmbedBlock({ url, title, update }: { url: string; title: string; update?: (url: string) => void }) {
  const embedded = allowedEmbedUrl(url);
  const bookmark = safeBookmarkUrl(url);
  return (
    <div className="editor-embed">
      {embedded ? (
        <iframe
          title={title || "Embedded content"}
          src={embedded}
          sandbox="allow-scripts allow-presentation"
          referrerPolicy="no-referrer"
          allowFullScreen
        />
      ) : (
        <a href={bookmark ?? undefined} target="_blank" rel="noreferrer">
          <strong>{title || "Bookmark"}</strong>
          <span>{url || "Add a supported HTTPS URL"}</span>
        </a>
      )}
      {update && (
        <label contentEditable={false}>
          <span className="visually-hidden">Embed URL</span>
          <input aria-label="Embed URL" type="url" value={url} onChange={(event) => update(event.target.value)} />
        </label>
      )}
    </div>
  );
}

const embed = createReactBlockSpec(
  {
    type: "embed",
    propSchema: { url: { default: "" }, title: { default: "Embedded link" } },
    content: "none",
  },
  {
    render: ({ block, editor }) => (
      <EmbedBlock
        url={block.props.url}
        title={block.props.title}
        update={editor.isEditable ? (url) => editor.updateBlock(block, { props: { url } }) : undefined}
      />
    ),
    toExternalHTML: ({ block }) => <EmbedBlock url={block.props.url} title={block.props.title} />,
  },
)();

const bookmark = createReactBlockSpec(
  {
    type: "bookmark",
    propSchema: { url: { default: "" }, title: { default: "Bookmark" } },
    content: "none",
  },
  {
    render: ({ block, editor }) => (
      <div className="editor-bookmark">
        <a href={safeBookmarkUrl(block.props.url) ?? undefined} target="_blank" rel="noreferrer">
          <strong>{block.props.title || "Bookmark"}</strong>
          <span>{block.props.url || "Add an HTTP, HTTPS, or mail link"}</span>
        </a>
        {editor.isEditable && (
          <input
            contentEditable={false}
            aria-label="Bookmark URL"
            type="url"
            value={block.props.url}
            onChange={(event) => editor.updateBlock(block, { props: { url: event.target.value } })}
          />
        )}
      </div>
    ),
    toExternalHTML: ({ block }) => (
      <a href={safeBookmarkUrl(block.props.url) ?? undefined}>{block.props.title || block.props.url}</a>
    ),
  },
)();

function TableOfContentsView({
  editor,
}: {
  editor: { document: readonly any[]; onChange: (callback: () => void) => () => void };
}) {
  const [blocks, setBlocks] = useState(editor.document);
  useEffect(() => editor.onChange(() => setBlocks(editor.document)), [editor]);
  const headings = useMemo(() => {
    const output: Array<{ id: string; level: number; text: string }> = [];
    const visit = (nestedBlocks: readonly any[]) => {
      for (const block of nestedBlocks) {
        if (block.type === "heading" && Number(block.props?.level) <= 4) {
          const text = Array.isArray(block.content)
            ? block.content.map((item: any) => (typeof item.text === "string" ? item.text : "")).join("")
            : "";
          if (text.trim()) output.push({ id: block.id, level: Number(block.props?.level ?? 1), text });
        }
        if (Array.isArray(block.children)) visit(block.children);
      }
    };
    visit(blocks);
    return output;
  }, [blocks]);
  return (
    <nav className="editor-toc" contentEditable={false} aria-label="Table of contents">
      <strong>Table of contents</strong>
      {headings.map((heading) => (
        <button
          type="button"
          key={heading.id}
          style={{ paddingInlineStart: `${(heading.level - 1) * 14}px` }}
          onClick={() => document.querySelector<HTMLElement>(`[data-id="${CSS.escape(heading.id)}"]`)?.scrollIntoView()}
        >
          {heading.text}
        </button>
      ))}
      {!headings.length && <span>Add headings to build this table.</span>}
    </nav>
  );
}

const tableOfContents = createReactBlockSpec(
  { type: "tableOfContents", propSchema: { color: { default: "default" } }, content: "none" },
  {
    render: ({ editor }) => <TableOfContentsView editor={editor as never} />,
    toExternalHTML: () => <div data-derived-block="table-of-contents" />,
  },
)();

const columnList = createReactBlockSpec(
  { type: "columnList", propSchema: {}, content: "none" },
  {
    render: () => (
      <div className="editor-column-list-label" contentEditable={false}>
        Columns
      </div>
    ),
    toExternalHTML: () => <div className="columns" />,
  },
)();

const column = createReactBlockSpec(
  { type: "column", propSchema: {}, content: "none" },
  {
    render: () => (
      <div className="editor-column-label" contentEditable={false}>
        Column
      </div>
    ),
    toExternalHTML: () => <div className="column" />,
  },
)();

const syncedBlockSource = createReactBlockSpec(
  { type: "syncedBlockSource", propSchema: { blockId: { default: "" } }, content: "none" },
  {
    render: () => (
      <div className="editor-synced-label" contentEditable={false}>
        Synced block source
      </div>
    ),
    toExternalHTML: () => <div data-synced-block="source" />,
  },
)();

type TransclusionResult =
  | { status: "ok"; content: string; sourceTitle: string }
  | { status: "not_found" | "no_access" };

export function unsyncTransclusion<Block, ParsedBlock>(
  editor: {
    tryParseHTMLToBlocks: (html: string) => ParsedBlock[];
    replaceBlocks: (blocks: Block[], replacements: ParsedBlock[]) => unknown;
  },
  block: Block,
  html: string,
) {
  editor.replaceBlocks([block], editor.tryParseHTMLToBlocks(html));
}

function SyncedReferenceView({
  sourcePageId,
  blockId,
  onRemove,
  onUnsync,
}: {
  sourcePageId: string;
  blockId: string;
  onRemove: () => void;
  onUnsync: (content: string) => void;
}) {
  const [result, setResult] = useState<TransclusionResult | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    void api<{ results: TransclusionResult[] }>("/api/transclusions/lookup", {
      method: "POST",
      body: json({ references: [{ sourcePageId, blockId }], refresh: revision }),
    })
      .then((data) => {
        if (active) setResult(data.results[0] ?? { status: "not_found" });
      })
      .catch(() => {
        if (active) setResult({ status: "not_found" });
      });
    return () => {
      active = false;
    };
  }, [blockId, revision, sourcePageId]);
  if (!result) return <div className="editor-synced-placeholder">Loading synced content…</div>;
  if (result.status !== "ok") return <div className="editor-synced-placeholder">Synced content is unavailable.</div>;
  return (
    <div className="editor-synced-reference" contentEditable={false}>
      <div className="editor-synced-actions">
        <a href={`/?page=${encodeURIComponent(sourcePageId)}`}>Edit source</a>
        <button type="button" onClick={() => setRevision((value) => value + 1)}>
          Refresh
        </button>
        <button type="button" onClick={() => onUnsync(result.content)}>
          Unsync to copy
        </button>
        <button type="button" onClick={onRemove}>
          Remove
        </button>
      </div>
      <div dangerouslySetInnerHTML={{ __html: result.content }} />
    </div>
  );
}

const syncedBlockReference = createReactBlockSpec(
  {
    type: "syncedBlockReference",
    propSchema: { sourcePageId: { default: "" }, blockId: { default: "" } },
    content: "none",
  },
  {
    render: ({ block, editor }) => (
      <SyncedReferenceView
        sourcePageId={block.props.sourcePageId}
        blockId={block.props.blockId}
        onRemove={() => editor.removeBlocks([block])}
        onUnsync={(content) => unsyncTransclusion(editor, block, content)}
      />
    ),
    toExternalHTML: ({ block }) => (
      <div data-source-page-id={block.props.sourcePageId} data-block-id={block.props.blockId} />
    ),
  },
)();

function currentPageId() {
  return new URLSearchParams(window.location.search).get("page") ?? "";
}

function BreadcrumbView() {
  const [trail, setTrail] = useState<string[]>([]);
  useEffect(() => {
    const pageId = currentPageId();
    if (!pageId) return;
    void api<{ breadcrumbs: Array<{ title: string }> }>(`/api/pages/${pageId}/breadcrumbs`)
      .then((data) => setTrail(data.breadcrumbs.map((item) => item.title)))
      .catch(() => setTrail([]));
  }, []);
  return (
    <div className="editor-breadcrumb" contentEditable={false}>
      {trail.join(" / ") || "Breadcrumb"}
    </div>
  );
}

const breadcrumb = createReactBlockSpec(
  { type: "breadcrumb", propSchema: {}, content: "none" },
  { render: () => <BreadcrumbView />, toExternalHTML: () => <div data-derived-block="breadcrumb" /> },
)();

const linkToPage = createReactBlockSpec(
  { type: "linkToPage", propSchema: { pageId: { default: "" }, title: { default: "Linked page" } }, content: "none" },
  {
    render: ({ block }) => (
      <a className="editor-page-link" contentEditable={false} href={`/?page=${encodeURIComponent(block.props.pageId)}`}>
        <span aria-hidden="true">□</span> {block.props.title}
      </a>
    ),
    toExternalHTML: ({ block }) => <a href={`/?page=${encodeURIComponent(block.props.pageId)}`}>{block.props.title}</a>,
  },
)();

export function LinkedDiagramView({
  pageId,
  title,
  update,
}: {
  pageId: string;
  title: string;
  update?: (page: Pick<Page, "id" | "title">) => void;
}) {
  const [choosing, setChoosing] = useState(!pageId && Boolean(update));
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<SearchTitleSuggestion[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const updateRef = useRef(update);
  useLayoutEffect(() => {
    updateRef.current = update;
  }, [update]);

  const showPicker = Boolean(update) && (!pageId || choosing);
  useEffect(() => {
    if (!showPicker || !query.trim()) {
      return undefined;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void api<{ suggestions: SearchTitleSuggestion[] }>(
        `/api/search/titles?q=${encodeURIComponent(query.trim())}&kind=diagram&limit=8`,
        { signal: controller.signal },
      )
        .then((result) => setSuggestions(result.suggestions))
        .catch(() => {
          if (!controller.signal.aborted) setSuggestions([]);
        });
    }, 150);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [showPicker, query]);
  const visibleSuggestions = showPicker && query.trim() ? suggestions : [];

  async function createDiagram() {
    if (!updateRef.current || busy) return;
    setBusy(true);
    try {
      const result = await api<{ page: Page }>("/api/pages", {
        method: "POST",
        body: json({
          kind: "diagram",
          parentId: currentPageId() || null,
          title: query.trim() || "Untitled diagram",
        }),
      });
      const currentUpdate = updateRef.current;
      if (!currentUpdate) return;
      currentUpdate(result.page);
      setChoosing(false);
      setError("");
    } catch (cause) {
      setError(apiErrorMessage(cause, "The linked whiteboard could not be created."));
    } finally {
      setBusy(false);
    }
  }

  if (!pageId && !update) {
    return (
      <figure className="editor-linked-diagram" contentEditable={false}>
        <figcaption>
          <span aria-hidden="true">◇</span> {title || "Linked whiteboard"} unavailable
        </figcaption>
      </figure>
    );
  }

  if (showPicker) {
    return (
      <div className="editor-linked-diagram-picker" contentEditable={false}>
        <strong>Link a whiteboard</strong>
        <input
          aria-label="Find a diagram"
          placeholder="Search diagrams or name a new one"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="editor-linked-diagram-options">
          {visibleSuggestions.map((suggestion) => (
            <button
              type="button"
              key={suggestion.page.id}
              onClick={() => {
                update?.(suggestion.page);
                setChoosing(false);
              }}
            >
              ◇ {suggestion.page.title}
              <small>{suggestion.space.name}</small>
            </button>
          ))}
          <button type="button" disabled={busy} onClick={() => void createDiagram()}>
            ＋ Create {query.trim() ? `“${query.trim()}”` : "child diagram"}
          </button>
          {pageId && (
            <button type="button" onClick={() => setChoosing(false)}>
              Cancel
            </button>
          )}
        </div>
        {error ? <span className="form-error">{error}</span> : null}
      </div>
    );
  }

  return (
    <figure className="editor-linked-diagram" contentEditable={false}>
      <a href={`/?page=${encodeURIComponent(pageId)}`}>
        <img src={`/api/pages/${encodeURIComponent(pageId)}/diagram-thumbnail.svg`} alt="" loading="lazy" />
        <figcaption>
          <span aria-hidden="true">◇</span> {title || "Linked whiteboard"}
        </figcaption>
      </a>
      {update && (
        <button type="button" onClick={() => setChoosing(true)}>
          Change
        </button>
      )}
    </figure>
  );
}

const linkedDiagram = createReactBlockSpec(
  {
    type: "linkedDiagram",
    propSchema: { pageId: { default: "" }, title: { default: "Linked whiteboard" } },
    content: "none",
  },
  {
    render: ({ block, editor }) => (
      <LinkedDiagramView
        pageId={block.props.pageId}
        title={block.props.title}
        update={
          editor.isEditable
            ? (page) => editor.updateBlock(block, { props: { pageId: page.id, title: page.title } })
            : undefined
        }
      />
    ),
    toExternalHTML: ({ block }) => (
      <figure data-linked-diagram-id={block.props.pageId}>
        <a href={`/?page=${encodeURIComponent(block.props.pageId)}`}>
          <img src={`/api/pages/${encodeURIComponent(block.props.pageId)}/diagram-thumbnail.svg`} alt="" />
          <figcaption>{block.props.title}</figcaption>
        </a>
      </figure>
    ),
  },
)();

const pdf = createReactBlockSpec(
  { type: "pdf", propSchema: { url: { default: "" }, caption: { default: "PDF" } }, content: "none" },
  {
    render: ({ block, editor }) => {
      const url = safePdfUrl(block.props.url);
      return (
        <div className="editor-pdf">
          {url ? <iframe title={block.props.caption} src={url} sandbox="" /> : <span>Add a PDF URL</span>}
          {editor.isEditable && (
            <input
              contentEditable={false}
              aria-label="PDF URL"
              type="url"
              value={block.props.url}
              onChange={(event) => editor.updateBlock(block, { props: { url: event.target.value } })}
            />
          )}
        </div>
      );
    },
    toExternalHTML: ({ block }) => <a href={safePdfUrl(block.props.url) ?? undefined}>{block.props.caption}</a>,
  },
)();

export const coreBlockSpecs = {
  callout,
  math,
  mermaid,
  columns,
  embed,
  bookmark,
  tableOfContents,
  columnList,
  column,
  syncedBlockSource,
  syncedBlockReference,
  breadcrumb,
  linkToPage,
  linkedDiagram,
  pdf,
};

export const inlineMathSpec = createReactInlineContentSpec(
  { type: "inlineMath", content: "none", propSchema: { formula: { default: "x" } } } as const,
  {
    render: ({ inlineContent }) => (
      <span
        className="editor-inline-math"
        title={inlineContent.props.formula}
        dangerouslySetInnerHTML={{ __html: renderedMath(inlineContent.props.formula, false) }}
      />
    ),
    toExternalHTML: ({ inlineContent }) => <span>${inlineContent.props.formula}$</span>,
  },
);

export const editorBlockFactories = [
  { type: "callout", label: "Callout", description: "Highlighted note with tone and icon", icon: "💡" },
  { type: "math", label: "Math", description: "KaTeX display formula", icon: "∑" },
  { type: "mermaid", label: "Diagram", description: "Mermaid flowchart or diagram", icon: "◇" },
  { type: "embed", label: "Embed", description: "Allowlisted embed or safe bookmark", icon: "↗" },
  { type: "bookmark", label: "Bookmark", description: "Link preview without embedded scripts", icon: "🔖" },
  { type: "tableOfContents", label: "Table of contents", description: "Links to headings on this page", icon: "☷" },
  { type: "columnList", label: "Columns", description: "Nested two-column layout", icon: "▥" },
  { type: "syncedBlockSource", label: "Synced block", description: "Reusable source content", icon: "⟳" },
  { type: "breadcrumb", label: "Breadcrumb", description: "Current page ancestry", icon: "›" },
  { type: "linkToPage", label: "Link to page", description: "Linked page card", icon: "□" },
  { type: "linkedDiagram", label: "Linked whiteboard", description: "Live diagram with a thumbnail", icon: "◇" },
  { type: "pdf", label: "PDF", description: "PDF preview and download", icon: "▤" },
] as const satisfies ReadonlyArray<{
  type: keyof typeof notionBlockRegistry;
  label: string;
  description: string;
  icon: string;
}>;
