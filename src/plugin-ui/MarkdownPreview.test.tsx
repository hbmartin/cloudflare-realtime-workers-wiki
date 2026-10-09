// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MarkdownPreview } from "./MarkdownPreview";

describe("Markdown task previews", () => {
  it.each([
    { name: "tight", separator: "\n", indentation: "" },
    { name: "loose", separator: "\n\n", indentation: "" },
    { name: "nested", separator: "\n", indentation: "  " },
    { name: "loose nested", separator: "\n\n", indentation: "  " },
  ])("preserves literal checkbox labels and formatting in $name tasks", ({ separator, indentation }) => {
    const openLink = vi.fn();
    const { container } = render(
      <MarkdownPreview
        markdown={`- [x] **First**${separator}${indentation}- [ ] [x] = *completed*\n${indentation}- [x] \\[ \\] [link](https://example.com)\n`}
        openLink={openLink}
      />,
    );
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(
      items.map((item) =>
        [...item.childNodes]
          .filter((node) => !(node instanceof HTMLElement && node.matches("ul, ol")))
          .map((node) => node.textContent)
          .join("")
          .trim(),
      ),
    ).toEqual(["☑ First", "☐ [x] = completed", "☑ [ ] link"]);
    expect(items.map((item) => item.querySelector(":scope > [aria-label]")?.getAttribute("aria-label"))).toEqual([
      "Completed",
      "Incomplete",
      "Completed",
    ]);
    expect(container.querySelector("strong")).toHaveTextContent("First");
    expect(container.querySelector("em")).toHaveTextContent("completed");
    fireEvent.click(screen.getByRole("button", { name: "link" }));
    expect(openLink).toHaveBeenCalledExactlyOnceWith("https://example.com");
  });
});
