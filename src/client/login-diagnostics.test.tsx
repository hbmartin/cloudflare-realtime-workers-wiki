// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { finishPasswordSignIn } from "./SecurityScreen";

vi.mock("./EditorPage", () => ({ EditorPage: () => null }));
vi.mock("./TablePage", () => ({ TablePage: () => null }));

beforeEach(() => {
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
    clear: () => stored.clear(),
  });
  vi.stubGlobal("indexedDB", undefined);
  history.replaceState(null, "", "/");
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("startup failure diagnostics", () => {
  const fallback = "Unable to open the workspace. Try again.";
  it.each([
    {
      name: "HTML with HTTP 200",
      response: () => new Response("<!doctype html><title>Proxy</title>", { headers: { "content-type": "text/html" } }),
      message: fallback,
      logged: true,
      offlineLocked: false,
    },
    {
      name: "empty HTTP 200",
      response: () => new Response("", { headers: { "content-type": "application/json" } }),
      message: fallback,
      logged: true,
      offlineLocked: true,
    },
    {
      name: "empty HTTP 500",
      response: () => new Response("", { status: 500 }),
      message: fallback,
      logged: false,
      offlineLocked: true,
    },
    {
      name: "structured HTTP 500",
      response: () =>
        Response.json({ error: { code: "internal_error", message: "Something went wrong." } }, { status: 500 }),
      message: "Something went wrong.",
      logged: false,
      offlineLocked: true,
    },
    {
      name: "network failure",
      response: () => {
        throw new TypeError("Failed to fetch");
      },
      message: fallback,
      logged: false,
      offlineLocked: true,
    },
  ])("records the current UI and logging signature for $name", async ({ response, message, logged, offlineLocked }) => {
    const reported = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchMock = vi.fn(async (path: RequestInfo | URL) => {
      if (path === "/api/install") return Response.json({ initialized: true });
      if (path === "/api/security/status") return response();
      throw new Error(`Unexpected request: ${String(path)}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    const result = offlineLocked
      ? await screen.findByRole("heading", { name: "Offline access locked" })
      : await screen.findByRole("alert");
    expect(result).toHaveTextContent(offlineLocked ? "Offline access locked" : message);
    expect(reported.mock.calls.length > 0).toBe(logged);
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual(["/api/install", "/api/security/status"]);
  });

  it("reproduces blocked sessionStorage as a silent failure before any startup request", async () => {
    const reported = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("sessionStorage", {
      getItem: () => {
        throw new DOMException("Storage blocked", "SecurityError");
      },
    });
    render(<App />);
    expect(await screen.findByRole("alert")).toHaveTextContent(fallback);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(reported).not.toHaveBeenCalled();
  });

  it.each([403, 500])("documents that complete-trust silently consumes HTTP %s", async (status) => {
    const reported = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status })),
    );
    await expect(finishPasswordSignIn()).resolves.toBeUndefined();
    expect(reported).not.toHaveBeenCalled();
  });
});
