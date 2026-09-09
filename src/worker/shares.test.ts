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

    const { body } = publicDocumentHtml(document, "public-key");

    expect(body).toContain(`Visible ?page=${target}`);
    expect(body).toContain(`href="/share/public-key/pages/${target}"`);
    expect(body).toContain(`href="https://example.test/?page=${target}"`);
  });
});
