import { BlockNoteEditor } from "@blocknote/core";
import { BlockNoteView } from "@blocknote/mantine";
import { MantineProvider } from "@mantine/core";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { notesSchema } from "../../../src/client/mentions";
import { deferredSyntaxExtension } from "../../../src/client/deferred-syntax";
import "../../../src/client/editor-features.css";

async function createHighlighter() {
  const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, light, dark, language] = await Promise.all([
    import("shiki/core"),
    import("@shikijs/engine-javascript"),
    import("@shikijs/themes/github-light"),
    import("@shikijs/themes/github-dark"),
    import("@shikijs/langs/javascript"),
  ]);
  return createHighlighterCore({
    themes: [light.default, dark.default],
    langs: [language.default],
    engine: createJavaScriptRegexEngine(),
  });
}
let warmed;
const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

/** Controlled eager-versus-deferred comparison: identical real editor trees,
 * viewport, Shiki, and source text. This is not a historical-commit benchmark. */
export async function renderBenchmark(count, eager) {
  warmed ??= createHighlighter();
  await warmed;
  const observer = window.IntersectionObserver;
  if (eager) Object.defineProperty(window, "IntersectionObserver", { configurable: true, value: undefined });
  const host = document.createElement("section");
  host.style.cssText = "position:fixed;inset:0;z-index:99999;background:white;overflow:auto;padding:20px";
  document.body.appendChild(host);
  const root = createRoot(host);
  const blocks = Array.from({ length: count }, (_, index) => {
    const id = `benchmark-${index}`;
    if (index % 100 === 98)
      return { id, type: "math", props: { formula: "\\frac{a^2+b^2}{1+x} = \\sum_{n=1}^{10} n" } };
    if (index % 100 === 99)
      return {
        id,
        type: "codeBlock",
        props: { language: "javascript" },
        content: `const result${index} = [1, 2, 3].map(x => x * 2);`,
      };
    if (index % 100 === 0) return { id, type: "heading", props: { level: 2 }, content: `Section ${index}` };
    return {
      id,
      type: "paragraph",
      content: `Paragraph ${index}: collaborative notes preserve actual editable text while disposable previews wait outside the visible area.`,
    };
  });
  let editor;
  try {
    const started = performance.now();
    editor = BlockNoteEditor.create({
      schema: notesSchema,
      initialContent: blocks,
      extensions: [deferredSyntaxExtension({ createHighlighter: () => warmed })],
    });
    root.render(
      createElement(
        MantineProvider,
        null,
        createElement(BlockNoteView, {
          editor: editor,
          slashMenu: false,
          formattingToolbar: false,
          sideMenu: false,
          filePanel: false,
          linkToolbar: false,
        }),
      ),
    );
    await frame();
    await frame();
    await frame();
    const firstPaintMs = performance.now() - started;
    const original = editor.prosemirrorState.doc;
    const editStarted = performance.now();
    editor.updateBlock("benchmark-1", { content: "Edited paragraph: the native document remains fully editable." });
    await frame();
    await frame();
    const editPaintMs = performance.now() - editStarted;
    const result = {
      count,
      mode: eager ? "eager" : "deferred",
      firstPaintMs: Math.round(firstPaintMs),
      editPaintMs: Math.round(editPaintMs),
      totalBlocks: host.querySelectorAll(".bn-block-outer").length,
      mathPreviews: host.querySelectorAll(".math-preview .katex").length,
      highlightedBlocks: new Set(
        [...host.querySelectorAll(".notes-code-token")].map((node) => node.closest("[data-content-type=codeBlock]")),
      ).size,
      docUnchangedByPreviews:
        original.textContent.replace(
          blocks[1].content,
          "Edited paragraph: the native document remains fully editable.",
        ) === editor.prosemirrorState.doc.textContent,
    };
    return result;
  } finally {
    root.unmount();
    editor?.unmount();
    host.remove();
    Object.defineProperty(window, "IntersectionObserver", { configurable: true, value: observer });
    await frame();
  }
}
