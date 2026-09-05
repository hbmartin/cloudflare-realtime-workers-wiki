// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WatchControl } from "./WatchControl";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
}

describe("WatchControl", () => {
  it("creates a page mute override for an inherited space watch", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ watch: { state: "watching", source: "space" } }))
      .mockResolvedValueOnce(jsonResponse({ watch: { state: "muted", source: "page" } }));
    vi.stubGlobal("fetch", fetchMock);
    render(<WatchControl resourceType="page" resourceId="page-1" />);

    const button = await screen.findByRole("button", { name: "Mute this page" });
    expect(button).toHaveTextContent("Watching space");
    fireEvent.click(button);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Stop watching this page" })).toHaveTextContent("Muted"),
    );
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/pages/page-1/watch",
      expect.objectContaining({ method: "PUT", body: JSON.stringify({ state: "muted" }) }),
    );
  });
});
