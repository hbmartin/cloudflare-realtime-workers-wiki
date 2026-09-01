// @vitest-environment jsdom

import { act, render, screen } from "@testing-library/react";
import type { JSX } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
  beforeEach(() => vi.restoreAllMocks());

  it("announces the unsupported-browser fallback without loading the application", () => {
    const loadSupportedApp = vi.fn();

    render(<Startup supported={false} loadSupportedApp={loadSupportedApp} />);

    expect(screen.getByRole("alert")).toHaveTextContent("Browser update required");
    expect(loadSupportedApp).not.toHaveBeenCalled();
  });

  it("renders a status while the supported application bundle loads", () => {
    const application = deferred<{ default: () => null }>();

    render(<Startup supported loadSupportedApp={() => application.promise} />);

    expect(screen.getByRole("status")).toHaveTextContent("Opening Notes…");
  });

  it("renders the supported application after its bundle loads", async () => {
    const application = deferred<{ default: () => JSX.Element }>();
    render(<Startup supported loadSupportedApp={() => application.promise} />);

    await act(async () => {
      application.resolve({ default: () => <p>Application loaded</p> });
      await application.promise;
    });

    expect(screen.getByText("Application loaded")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("logs and announces an application bundle load failure", async () => {
    const loadError = new TypeError("Chunk request failed");
    const reported = vi.spyOn(console, "error").mockImplementation(() => undefined);

    render(<Startup supported loadSupportedApp={() => Promise.reject(loadError)} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Workspace unavailable");
    expect(reported).toHaveBeenCalledWith("The application bundle could not be loaded", loadError);
  });
});
