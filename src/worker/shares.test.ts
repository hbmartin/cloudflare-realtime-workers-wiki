import { describe, expect, it } from "vitest";
import type { DocumentContentEnvelope } from "../shared/types";
import { publicDocumentHtml } from "./shares";

describe("public document rendering", () => {
  it("rewrites only internal link attributes", () => {
    const target = "target-page";
    const document: DocumentContentEnvelope["document"] = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: `Visible ?page=${target} ` },
            {
              type: "text",
              text: "internal",
              marks: [{ type: "link", attrs: { href: `?page=${target}` } }],
            },
            { type: "text", text: " " },
            {
              type: "text",
              text: "external",
              marks: [{ type: "link", attrs: { href: `https://example.test/?page=${target}` } }],
            },
          ],
        },
      ],
    };

    const { body } = publicDocumentHtml(document, "public-key", "source-page");

    expect(body).toContain(`Visible ?page=${target}`);
    expect(body).toContain(`href="/share/public-key/pages/${target}"`);
    expect(body).toContain(`href="https://example.test/?page=${target}"`);
  });

  it("uses capability-scoped public thumbnail URLs for linked diagrams", () => {
    const document: DocumentContentEnvelope["document"] = {
      type: "doc",
      content: [{ type: "linkedDiagram", attrs: { pageId: "diagram-one", title: "System map" } }],
    };

    const { body } = publicDocumentHtml(document, "public-key", "source-page", new Map(), new Set(["diagram-one"]));

    expect(body).toContain('src="/share/public-key/diagram-thumbnails/diagram-one.svg?source=source-page"');
    expect(body).not.toContain("/api/pages/");
    expect(body).not.toContain("?page=");
    expect(body).not.toContain("/share/public-key/pages/diagram-one");
  });

  it("does not emit a thumbnail URL for a diagram outside the shared subtree", () => {
    const document: DocumentContentEnvelope["document"] = {
      type: "doc",
      content: [{ type: "linkedDiagram", attrs: { pageId: "private-diagram", title: "Private map" } }],
    };

    const { body } = publicDocumentHtml(document, "public-key", "source-page");

    expect(body).toContain("Private map");
    expect(body).not.toContain("<img");
    expect(body).not.toContain("diagram-thumbnails");
  });
});
