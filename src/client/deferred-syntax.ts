import { createExtension, type ExtensionOptions } from "@blocknote/core";
import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
import type { Node as PMNode } from "prosemirror-model";

export type Highlighter = {
  codeToTokens: (
    code: string,
    options: { lang: string; themes: { light: string; dark: string }; defaultColor: false },
  ) => {
    tokens: Array<
      Array<{
        content: string;
        color?: string;
        fontStyle?: number;
        variants?: Record<string, { color?: string; fontStyle?: number }>;
      }>
    >;
  };
};
const key = new PluginKey<DecorationSet>("notesDeferredSyntax");
let highlighterPromise: Promise<Highlighter> | undefined;
const aliases: Record<string, string> = {
  js: "javascript",
  ts: "typescript",
  sh: "bash",
  py: "python",
  md: "markdown",
};

/** Keep code as real editable text; disposable highlighting is computed only
 * near the viewport or while that block owns selection/composition. */
function deferredSyntaxPlugin(createHighlighter: () => Promise<Highlighter>) {
  return new Plugin<DecorationSet>({
    key,
    state: {
      init: () => DecorationSet.empty,
      apply: (tr, previous) => {
        const updated = tr.getMeta(key) as Decoration[] | undefined;
        return updated ? DecorationSet.create(tr.doc, updated) : previous.map(tr.mapping, tr.doc);
      },
    },
    props: { decorations: (state) => key.getState(state) ?? DecorationSet.empty },
    view(view: EditorView) {
      let disposed = false,
        composing = false,
        generation = 0;
      let frame: number | undefined;
      const visible = new Set<Element>();
      const observed = new Set<Element>();
      const cache = new WeakMap<PMNode, Array<{ from: number; to: number; style: string }>>();
      const observer =
        typeof IntersectionObserver === "undefined"
          ? null
          : new IntersectionObserver(
              (entries) => {
                for (const entry of entries) {
                  if (entry.isIntersecting) visible.add(entry.target);
                  else visible.delete(entry.target);
                }
                schedule();
              },
              { rootMargin: "600px" },
            );
      const codeNodes = () => {
        const output: Array<{ node: PMNode; pos: number; dom: Element | null }> = [];
        view.state.doc.descendants((node, pos) => {
          if (node.type.name !== "codeBlock") return true;
          const dom = view.nodeDOM(pos);
          output.push({ node, pos, dom: dom instanceof Element ? dom : null });
          return false;
        });
        return output;
      };
      const observe = () => {
        const elements = new Set(codeNodes().flatMap(({ dom }) => (dom ? [dom] : [])));
        for (const element of observed)
          if (!elements.has(element)) {
            observer?.unobserve(element);
            observed.delete(element);
            visible.delete(element);
          }
        for (const element of elements)
          if (!observed.has(element)) {
            observed.add(element);
            observer?.observe(element);
          }
      };
      const render = async () => {
        frame = undefined;
        if (disposed || composing) return;
        const version = ++generation;
        const doc = view.state.doc;
        const selection = view.state.selection;
        const codes = codeNodes().filter(
          ({ node, pos, dom }) =>
            node.textContent.length <= 150_000 &&
            (!observer || (dom && visible.has(dom)) || (selection.from <= pos + node.nodeSize && selection.to >= pos)),
        );
        const decorations: Decoration[] = [];
        for (const { node, pos } of codes) {
          const language = String(node.attrs.language ?? "text");
          if (["text", "none", "plaintext", "txt"].includes(language)) continue;
          let tokens = cache.get(node);
          if (!tokens) {
            try {
              highlighterPromise ??= createHighlighter();
              const highlighter = await highlighterPromise;
              if (disposed || generation !== version || view.state.doc !== doc) return;
              const result = highlighter.codeToTokens(node.textContent, {
                lang: aliases[language] ?? language,
                themes: { light: "github-light", dark: "github-dark" },
                defaultColor: false,
              });
              tokens = [];
              let offset = 0;
              for (const line of result.tokens) {
                for (const token of line) {
                  const light = token.variants?.light?.color ?? token.color ?? "inherit";
                  const dark = token.variants?.dark?.color ?? token.color ?? "inherit";
                  const fontStyle = token.fontStyle ?? token.variants?.light?.fontStyle ?? 0;
                  if (token.content)
                    tokens.push({
                      from: offset,
                      to: offset + token.content.length,
                      style: `--shiki-light:${light};--shiki-dark:${dark};${fontStyle & 1 ? "font-style:italic;" : ""}${fontStyle & 2 ? "font-weight:bold;" : ""}${fontStyle & 4 ? "text-decoration:underline;" : ""}`,
                    });
                  offset += token.content.length;
                }
                offset++;
              }
              cache.set(node, tokens);
            } catch {
              tokens = [];
              cache.set(node, tokens);
            }
          }
          for (const token of tokens)
            decorations.push(
              Decoration.inline(pos + 1 + token.from, pos + 1 + token.to, {
                class: "notes-code-token",
                style: token.style,
              }),
            );
        }
        if (!disposed && generation === version && view.state.doc === doc)
          view.dispatch(view.state.tr.setMeta(key, decorations).setMeta("addToHistory", false));
      };
      function schedule() {
        if (!disposed && frame === undefined) frame = requestAnimationFrame(() => void render());
      }
      const start = () => {
        composing = true;
        generation++;
      };
      const end = () => {
        composing = false;
        schedule();
      };
      view.dom.addEventListener("compositionstart", start);
      view.dom.addEventListener("compositionend", end);
      observe();
      schedule();
      return {
        update(next, previous) {
          if (next.state.doc !== previous.doc) {
            generation++;
            observe();
            schedule();
          } else if (!next.state.selection.eq(previous.selection)) schedule();
        },
        destroy() {
          disposed = true;
          generation++;
          observer?.disconnect();
          if (frame !== undefined) cancelAnimationFrame(frame);
          view.dom.removeEventListener("compositionstart", start);
          view.dom.removeEventListener("compositionend", end);
        },
      };
    },
  });
}
export const deferredSyntaxExtension = createExtension(
  ({ options }: ExtensionOptions<{ createHighlighter: () => Promise<Highlighter> }>) => ({
    key: "notesDeferredSyntax",
    prosemirrorPlugins: [deferredSyntaxPlugin(options.createHighlighter)],
  }),
);
