// @vitest-environment jsdom

import { act, render, screen } from "@testing-library/react";
import type { JSX } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Startup } from "./startup";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, reject, resolve };
}

describe("Startup", () => {
  afterEach(() => vi.restoreAllMocks());

  it("announces the unsupported-browser fallback without loading the application", () => {
    const loadSupportedApp = vi.fn();

    render(<Startup supported={false} loadSupportedApp={loadSupportedApp} />);

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Browser update required");
    expect(screen.getByRole("main")).toContainElement(alert);
    expect(screen.getByRole("main")).not.toBe(alert);
    expect(loadSupportedApp).not.toHaveBeenCalled();
  });

  it("renders a status while the supported application bundle loads", () => {
    const application = deferred<{ default: () => null }>();

    render(<Startup supported loadSupportedApp={() => application.promise} />);

    const status = screen.getByText("Opening Notes…");
    expect(status).toHaveTextContent("Opening Notes…");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(screen.getByRole("main")).toContainElement(status);
  });

  it("renders the supported application after its bundle loads", async () => {
    const application = deferred<{ default: () => JSX.Element }>();
    render(<Startup supported loadSupportedApp={() => application.promise} />);

    await act(async () => {
      application.resolve({ default: () => <p>Application loaded</p> });
      await application.promise;
    });

    expect(screen.getByText("Application loaded")).toBeInTheDocument();
    expect(screen.queryByText("Opening Notes…")).not.toBeInTheDocument();
  });

  it("logs and announces an application bundle load failure", async () => {
    const loadError = new TypeError("Chunk request failed");
    const reported = vi.spyOn(console, "error").mockImplementation(() => undefined);

    render(<Startup supported loadSupportedApp={() => Promise.reject(loadError)} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Workspace unavailable");
    expect(reported).toHaveBeenCalledWith("The application bundle could not be loaded", loadError);
  });
});
