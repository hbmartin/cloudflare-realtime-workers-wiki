/**
 * Notion HTML -> BlockNote blocks -> Yjs document, headless.
 *
 * The server accepts document content over exactly one channel: the Yjs WebSocket
 * at `/parties/document/{pageId}~{epoch}`. Nothing else writes a page body. So the
 * importer has to produce the same `Y.XmlFragment("document-store")` the browser
 * editor produces, which means running BlockNote itself rather than hand-rolling
 * ProseMirror JSON — BlockNote's HTML parse rules are the only definition of how
 * markup becomes blocks, and reimplementing them would drift immediately.
 *
 * BlockNote needs a DOM. `jsdom` is already a devDependency (the client tests use
 * it), so this installs the handful of globals BlockNote touches rather than
 * pulling in `@blocknote/server-util`, which would duplicate `yjs` and
 * `@blocknote/core` in the dependency graph and hand `YProvider` a `Y.Doc` from a
 * different module instance.
 */
import { mentionInlineConfig } from "../../src/shared/mention-spec.ts";

// Node strips TypeScript types natively from 22.18 onward, which is what lets this
// plain .mjs script import the shared modules the worker and client already use
// instead of keeping a second, drifting copy of them.
const MINIMUM_NODE = [22, 18];

export function assertSupportedNode(version = process.versions.node) {
  const [major, minor] = version.split(".").map((part) => Number.parseInt(part, 10));
  const supported = major > MINIMUM_NODE[0] || (major === MINIMUM_NODE[0] && minor >= MINIMUM_NODE[1]);
  if (!supported) {
    throw new Error(
      `The Notion importer needs Node ${MINIMUM_NODE.join(".")} or newer to read the shared TypeScript modules; this is Node ${version}.`,
    );
  }
}

// BlockNote reaches for these during schema construction and HTML parsing. Anything
// it only touches while mounted in a browser is deliberately absent — if this list
// grows, prefer adding the one missing global over widening to a full jsdom window.
const DOM_GLOBALS = [
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "DocumentFragment",
  "DOMParser",
  "XMLSerializer",
  "MutationObserver",
  "Range",
  "Text",
  "Event",
  "KeyboardEvent",
  "ClipboardEvent",
];

let domInstalled = false;

export async function installDomGlobals() {
  if (domInstalled || globalThis.document !== undefined) {
    domInstalled = true;
    return;
  }
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
  globalThis.window = dom.window;
  for (const name of DOM_GLOBALS) {
    if (globalThis[name] === undefined) globalThis[name] = dom.window[name];
  }
  if (globalThis.getComputedStyle === undefined) {
    globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  }
  domInstalled = true;
}

/**
 * The fragment name is load-bearing: `Document.compactOnce` reads exactly
 * `doc.getXmlFragment("document-store")` to build the D1 projection. Content written
 * under any other name would sync and persist but never reach search or backlinks.
 */
export const DOCUMENT_FRAGMENT = "document-store";

export async function createImportEditor() {
  await installDomGlobals();
  const {
    BlockNoteEditor,
    BlockNoteSchema,
    createInlineContentSpec,
    defaultBlockSpecs,
    defaultInlineContentSpecs,
    defaultStyleSpecs,
  } = await import("@blocknote/core");

  // The browser pairs this same config with a React chip. Only the config
  // contributes to the TipTap node, so a stub renderer is enough here.
  const mention = createInlineContentSpec(mentionInlineConfig, {
    render: () => ({ dom: globalThis.document.createElement("span") }),
  });
  const schema = BlockNoteSchema.create({
    blockSpecs: defaultBlockSpecs,
    inlineContentSpecs: { ...defaultInlineContentSpecs, mention },
    styleSpecs: defaultStyleSpecs,
  });
  return BlockNoteEditor.create({ schema });
}

export async function htmlToBlocks(editor, html) {
  return editor.tryParseHTMLToBlocks(html);
}

/**
 * Writes blocks into a Yjs fragment and reports whether anything actually changed.
 *
 * `prosemirrorToYXmlFragment` delegates to y-prosemirror's `updateYFragment`, the
 * same reconciler the live editor binding uses, so pushing identical content into an
 * already-populated fragment produces no updates at all. That is what makes the
 * importer resumable without hashing content or marking imported pages server-side:
 * re-running over a page that already landed is free and provably a no-op.
 */
export async function writeBlocksToFragment(editor, blocks, doc, fragmentName = DOCUMENT_FRAGMENT) {
  const Y = await import("yjs");
  const { prosemirrorToYXmlFragment } = await import("y-prosemirror");
  editor.replaceBlocks(editor.document, blocks);
  const fragment = doc.getXmlFragment(fragmentName);
  let updates = 0;
  const count = () => {
    updates += 1;
  };
  doc.on("update", count);
  try {
    // The origin must not be the provider, or its update handler suppresses the
    // broadcast and the server never sees the import.
    doc.transact(() => prosemirrorToYXmlFragment(editor.prosemirrorState.doc, fragment), "notion-import");
  } finally {
    doc.off("update", count);
  }
  return { updates, byteLength: Y.encodeStateAsUpdate(doc).byteLength };
}

const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };

export function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (character) => HTML_ESCAPES[character]);
}

/**
 * Renders a mention as plain HTML.
 *
 * BlockNote registers a parse rule for `[data-inline-content-type="mention"]` and
 * maps each prop from its `data-kebab-case` attribute, so link rewriting stays a
 * string transform over the Notion export rather than a walk over parsed blocks.
 * The label is also emitted as text: `projectDocument` indexes it into `plain_text`
 * and drops any mention whose label is empty, which would silently cost a backlink.
 */
export function mentionHtml({ entityType = "page", entityId, label }) {
  const text = String(label ?? "").trim() || "Untitled";
  return (
    `<span data-inline-content-type="mention" data-entity-type="${escapeHtml(entityType)}"` +
    ` data-entity-id="${escapeHtml(entityId)}" data-label="${escapeHtml(text)}">@${escapeHtml(text)}</span>`
  );
}
