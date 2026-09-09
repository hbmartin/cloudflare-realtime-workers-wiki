// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import { ShareControl } from "./ShareControl";

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  api: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ShareControl", () => {
  it("opens a native dialog and preserves the active share when revoke fails", async () => {
    vi.mocked(api).mockImplementation(async (_path, init) => {
      if (!init?.method) {
        return {
          share: {
            url: "https://public.example.test/page",
            includeSubpages: false,
            allowIndexing: false,
            showToc: true,
            showLastUpdated: true,
            views: 1,
          },
        };
      }
      if (init.method === "DELETE") throw new Error("network unavailable");
      throw new Error(`Unexpected method: ${init.method}`);
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<ShareControl pageId="page-1" owner />);

    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    expect(await screen.findByRole("dialog", { name: "Share this page" })).toHaveAttribute("open");
    expect(await screen.findByDisplayValue("https://public.example.test/page")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Revoke public link" }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("public link could not be revoked"));
    expect(screen.getByDisplayValue("https://public.example.test/page")).toBeInTheDocument();
  });
});
