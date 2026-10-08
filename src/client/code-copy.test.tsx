// @vitest-environment jsdom
import { BlockNoteEditor } from "@blocknote/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { notesSchema } from "./mentions";

const mounted: Array<{
  editor: BlockNoteEditor<
    typeof notesSchema.blockSchema,
    typeof notesSchema.inlineContentSchema,
    typeof notesSchema.styleSchema
  >;
  host: HTMLElement;
}> = [];
const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");

function mountCode(language = "javascript") {
  const editor = BlockNoteEditor.create({
    schema: notesSchema,
    initialContent: [{ id: "code", type: "codeBlock", props: { language }, content: "const value = 1;" }],
  });
  const host = document.createElement("div");
  document.body.appendChild(host);
  editor.mount(host);
  mounted.push({ editor, host });
  return { editor, host };
}

function clipboard(writeText = vi.fn().mockResolvedValue(undefined)) {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  return writeText;
}

afterEach(() => {
  for (const { editor, host } of mounted.splice(0)) {
    editor.unmount();
    host.remove();
  }
  if (clipboardDescriptor) Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
  else Reflect.deleteProperty(navigator, "clipboard");
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("code block copy controls", () => {
  it("loads an existing code block and inserts another with one owned copy control each", async () => {
    const { editor, host } = mountCode("ruby");
    const original = host.querySelector(".code-copy-button");
    expect(host.querySelector("select")).toHaveValue("text");
    expect(editor.getBlock("code")?.props).toMatchObject({ language: "ruby" });
    editor.insertBlocks([{ id: "second", type: "codeBlock", content: "second" }], "code", "after");
    await vi.waitFor(() => expect(host.querySelectorAll(".code-copy-button")).toHaveLength(2));
    expect(host.querySelector(".code-copy-button")).toBe(original);
    const select = host.querySelector("select")!;
    select.value = "python";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(editor.getBlock("code")?.props).toMatchObject({ language: "python" });
    expect(host.querySelectorAll(".code-copy-button")).toHaveLength(2);
  });

  it("copies current editable text without recreating the node view for feedback", async () => {
    const writeText = clipboard();
    const { editor, host } = mountCode();
    const button = host.querySelector<HTMLButtonElement>(".code-copy-button")!;
    const code = host.querySelector("pre code")!;
    code.textContent = "const value = 2;";
    await vi.waitFor(() => expect(JSON.stringify(editor.document)).toContain("const value = 2;"));
    button.click();
    await vi.waitFor(() => expect(button).toHaveTextContent("Copied"));
    expect(writeText).toHaveBeenCalledExactlyOnceWith("const value = 2;");
    expect(host.querySelector(".code-copy-button")).toBe(button);
    expect(host.querySelector("pre code")).toBe(code);
    code.appendChild(document.createTextNode("\ncontinued"));
    await vi.waitFor(() => expect(JSON.stringify(editor.document)).toContain("continued"));
    expect(host.querySelectorAll(".code-copy-button")).toHaveLength(1);
  });

  it("resets successful feedback and reports a clipboard failure", async () => {
    const writeText = clipboard();
    const { host } = mountCode();
    const button = host.querySelector<HTMLButtonElement>(".code-copy-button")!;
    vi.useFakeTimers();
    button.click();
    await Promise.resolve();
    expect(button).toHaveTextContent("Copied");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(button).toHaveTextContent("Copy code");
    writeText.mockRejectedValueOnce(new Error("Clipboard denied"));
    button.click();
    await Promise.resolve();
    expect(button).toHaveTextContent("Copy failed");
    expect(host.querySelector(".code-copy-button")).toBe(button);
  });

  it("filters only copy feedback, preserving selection, native edits, and upstream Dark Reader filtering", () => {
    const { editor, host } = mountCode();
    type Description = {
      spec?: {
        dom: Node;
        ignoreMutation: (mutation: MutationRecord | { type: "selection"; target: Node }) => boolean;
      };
      children?: Description[];
    };
    // Inspect the actual mounted ProseMirror node view, including BlockNote's
    // upstream mutation wrapper, rather than a separately mocked renderer.
    const pending = [(editor.prosemirrorView as unknown as { docView: Description }).docView];
    const block = host.querySelector('[data-content-type="codeBlock"]')!;
    let nodeView: Description["spec"];
    while (pending.length) {
      const description = pending.pop()!;
      if (description.spec?.dom === block) nodeView = description.spec;
      pending.push(...(description.children ?? []));
    }
    expect(nodeView).toBeDefined();
    const ignore = nodeView!.ignoreMutation;
    const button = host.querySelector(".code-copy-button")!;
    const code = host.querySelector("pre code")!;
    const observer = new MutationObserver(() => undefined);
    observer.observe(block, { attributes: true, childList: true, subtree: true });
    button.textContent = "Copied";
    expect(ignore(observer.takeRecords()[0]!)).toBe(true);
    code.appendChild(document.createTextNode(" edited"));
    expect(ignore(observer.takeRecords()[0]!)).toBe(false);
    block.appendChild(document.createElement("p"));
    expect(ignore(observer.takeRecords()[0]!)).toBe(false);
    expect(ignore({ type: "selection", target: button })).toBe(false);
    block.setAttribute("data-darkreader-inline-color", "");
    expect(ignore(observer.takeRecords()[0]!)).toBe(true);
    observer.disconnect();
  });

  it("cleans up the button listener, feedback timer, and language picker when removed", async () => {
    const writeText = clipboard();
    const { editor, host } = mountCode();
    const button = host.querySelector<HTMLButtonElement>(".code-copy-button")!;
    const select = host.querySelector("select")!;
    const update = vi.spyOn(editor, "updateBlock");
    vi.useFakeTimers();
    button.click();
    await Promise.resolve();
    expect(button).toHaveTextContent("Copied");
    editor.removeBlocks(["code"]);
    button.click();
    select.value = "python";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(button).toHaveTextContent("Copied");
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
    expect(host.querySelector(".code-copy-button")).toBeNull();
  });

  it("does not update a destroyed view when a pending clipboard write finishes", async () => {
    let finish!: () => void;
    const writeText = clipboard(
      vi.fn().mockReturnValue(
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
      ),
    );
    const { editor, host } = mountCode();
    const button = host.querySelector<HTMLButtonElement>(".code-copy-button")!;
    button.click();
    editor.removeBlocks(["code"]);
    finish();
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(button).toHaveTextContent("Copy code");
  });

  it("keeps copy controls out of exported and serialized HTML", () => {
    const { editor } = mountCode();
    for (const html of [editor.blocksToHTMLLossy(), editor.blocksToFullHTML()]) {
      expect(html).toContain("const value = 1;");
      expect(html).not.toContain("code-copy-button");
      expect(html).not.toContain("Copy code");
    }
  });
});
