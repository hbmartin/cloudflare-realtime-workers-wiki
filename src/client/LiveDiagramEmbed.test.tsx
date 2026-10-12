// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { DiagramEmbedState } from "./diagram-embed-pool";
const mocks = vi.hoisted(() => ({ subscribe: vi.fn() }));
vi.mock("./diagram-embed-pool", () => ({ subscribeDiagramEmbed: mocks.subscribe }));
vi.mock("@xyflow/react", () => ({
  ReactFlowProvider: ({ children }: { children: ReactNode }) => children,
  ReactFlow: ({ children }: { children: ReactNode }) => <div data-testid="live-canvas">{children}</div>,
  Background: () => null,
  Controls: () => null,
}));
import { LiveDiagramEmbed } from "./LiveDiagramEmbed";
let intersection: IntersectionObserverCallback;
let receive: (state: DiagramEmbedState) => void;
let visibility: DocumentVisibilityState;
const release = vi.fn();
beforeEach(() => {
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: IntersectionObserverCallback) {
        intersection = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  mocks.subscribe.mockImplementation((_account: string, _page: string, callback: typeof receive) => {
    receive = callback;
    return release;
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
const intersect = (visible: boolean) =>
  act(() => intersection([{ isIntersecting: visible } as IntersectionObserverEntry], {} as IntersectionObserver));
const connected: DiagramEmbedState = {
  page: null,
  records: { schemaVersion: 1, pageId: "diagram", contentEpoch: 1, sequence: 1, nodes: [], edges: [] },
  status: "connected",
};
it("connects only visible foreground embeds and retains the last view when suspended", () => {
  render(<LiveDiagramEmbed account="account" pageId="diagram" title="Diagram" />);
  expect(mocks.subscribe).not.toHaveBeenCalled();
  expect(screen.getByAltText("Diagram preview")).toBeDefined();
  intersect(true);
  expect(mocks.subscribe).toHaveBeenCalledOnce();
  act(() => receive(connected));
  expect(screen.getByTestId("live-canvas")).toBeDefined();
  visibility = "hidden";
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(release).toHaveBeenCalledOnce();
  expect(screen.getByTestId("live-canvas")).toBeDefined();
  expect(screen.getByText("Offline — last available view")).toBeDefined();
  visibility = "visible";
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(mocks.subscribe).toHaveBeenCalledTimes(2);
  intersect(false);
  expect(release).toHaveBeenCalledTimes(2);
});
it("clears live content and the Open link after an access denial", () => {
  render(<LiveDiagramEmbed account="account" pageId="diagram" title="Diagram" />);
  intersect(true);
  act(() => receive(connected));
  act(() => receive({ page: null, records: null, status: "unavailable" }));
  expect(screen.queryByTestId("live-canvas")).toBeNull();
  expect(screen.queryByRole("link", { name: "Open diagram" })).toBeNull();
  expect(screen.getByText("Diagram unavailable")).toBeDefined();
});
