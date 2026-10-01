import type { ProseMirrorJson } from "../../src/shared/types";

export const docxPng = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAD0lEQVR4nGP0rl3PwMAAAAb9AXlaLM3OAAAAAElFTkSuQmCC"),
  (char) => char.charCodeAt(0),
);

export function docxDocument(): ProseMirrorJson {
  const text = (value: string): ProseMirrorJson => ({ type: "text", text: value });
  const container = (node: ProseMirrorJson, children: ProseMirrorJson[] = []): ProseMirrorJson => ({
    type: "blockContainer",
    attrs: { id: crypto.randomUUID() },
    content: [node, ...(children.length ? [{ type: "blockGroup", content: children }] : [])],
  });
  return {
    type: "doc",
    content: [
      {
        type: "blockGroup",
        content: [
          container({ type: "heading", attrs: { level: 2 }, content: [text("Résumé 日本語")] }),
          container({
            type: "paragraph",
            content: [
              {
                ...text("Formatting"),
                marks: [{ type: "bold" }, { type: "italic" }, { type: "underline" }, { type: "strike" }],
              },
              { type: "hardBreak" },
              { ...text("Example"), marks: [{ type: "link", attrs: { href: "https://example.com/" } }] },
            ],
          }),
          container({ type: "bulletListItem", content: [text("Parent bullet")] }, [
            container({ type: "numberedListItem", content: [text("Nested number")] }),
            container({ type: "numberedListItem", content: [text("Second number")] }),
          ]),
          container({
            type: "table",
            content: [
              {
                type: "tableRow",
                content: ["Cell A", "Cell B"].map((value) => ({
                  type: "tableCell",
                  content: [{ type: "tableParagraph", content: [text(value)] }],
                })),
              },
            ],
          }),
          container({
            type: "image",
            attrs: { url: "/api/attachments/docx-image", name: "Pixel", caption: "Pixel caption", previewWidth: 64 },
          }),
        ],
      },
    ],
  };
}

export const docxImages = [
  { mime: "image/png", bytes: docxPng },
  {
    mime: "image/jpeg",
    bytes: Uint8Array.from(
      atob(
        "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwCnRRRXunin/9k=",
      ),
      (char) => char.charCodeAt(0),
    ),
  },
  {
    mime: "image/gif",
    bytes: Uint8Array.from(atob("R0lGODdhAgABAIEAAEt9rwAAAAAAAAAAACwAAAAAAgABAAAIBQABAAgIADs="), (char) =>
      char.charCodeAt(0),
    ),
  },
];
