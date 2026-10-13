// @vitest-environment jsdom
import { Schema } from "prosemirror-model";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { expect, it, vi } from "vitest";
import { deferredSyntaxExtension } from "./deferred-syntax";

it("highlights visible code only, leaves edits authoritative, and waits for IME", async () => {
  let callback: IntersectionObserverCallback | undefined, target: Element | undefined;
  class Observer {
    constructor(receive: IntersectionObserverCallback) {
      callback = receive;
    }
    observe(element: Element) {
      target = element;
    }
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("IntersectionObserver", Observer);
  const highlighter = {
    codeToTokens: vi.fn((content: string) => ({
      tokens: [[{ content, variants: { light: { color: "#111" }, dark: { color: "#eee" } } }]],
    })),
  };
  const load = vi.fn(async () => highlighter);
  const schema = new Schema({
    nodes: {
      doc: { content: "block+" },
      paragraph: { group: "block", content: "text*", toDOM: () => ["p", 0] },
      codeBlock: {
        group: "block",
        content: "text*",
        attrs: { language: { default: "javascript" } },
        toDOM: () => ["pre", ["code", 0]],
      },
      text: {},
    },
  });
  const doc = schema.node("doc", null, [
    schema.node("paragraph", null, schema.text("Intro")),
    schema.node("codeBlock", null, schema.text("const x = 1;")),
  ]);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = new EditorView(host, {
    state: EditorState.create({
      schema,
      doc,
      plugins: deferredSyntaxExtension({ createHighlighter: load })({ editor: {} as never }).prosemirrorPlugins,
    }),
  });
  try {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(load).not.toHaveBeenCalled();
    callback!([{ target, isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    await vi.waitFor(() => expect(view.dom.querySelector(".notes-code-token")).not.toBeNull());
    expect(view.state.doc.toJSON()).toEqual(doc.toJSON());
    expect(highlighter.codeToTokens).toHaveBeenCalledOnce();
    callback!([{ target, isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver);
    view.dom.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    const tr = view.state.tr.insertText("!", 8);
    view.dispatch(tr.setSelection(TextSelection.create(tr.doc, 9)));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(highlighter.codeToTokens).toHaveBeenCalledOnce();
    view.dom.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    await vi.waitFor(() => expect(highlighter.codeToTokens).toHaveBeenCalledTimes(2));
    expect(view.state.doc.textContent).toContain("!const x");
  } finally {
    view.destroy();
    host.remove();
    vi.unstubAllGlobals();
  }
});
