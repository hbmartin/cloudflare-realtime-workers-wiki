import { renderToString } from "katex";
import { createReactBlockSpec, createReactInlineContentSpec } from "@blocknote/react";
import { useEffect, useId, useState, type CSSProperties } from "react";
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

function MermaidBlock({ source, update }: { source: string; update?: (source: string) => void }) {
  const renderId = `notes-mermaid-${useId().replaceAll(":", "")}`;
  const [preview, setPreview] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void import("mermaid")
      .then(async ({ default: mermaid }) => {
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", suppressErrorRendering: true });
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
  }, [renderId, source]);

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

export const coreBlockSpecs = { callout, math, mermaid, columns, embed };

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
  { type: "columns", label: "Columns", description: "Responsive two-column content", icon: "▥" },
  { type: "embed", label: "Embed", description: "Allowlisted embed or safe bookmark", icon: "↗" },
] as const;
