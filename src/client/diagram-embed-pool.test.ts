// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import * as Y from "yjs";
const mocks = vi.hoisted(() => ({ api: vi.fn(), network: vi.fn() }));
vi.mock("./api", async (importOriginal) => ({ ...(await importOriginal<typeof import("./api")>()), api: mocks.api }));
vi.mock("./collaboration", () => ({ createNetworkCollaboration: mocks.network }));
import { subscribeDiagramEmbed, type DiagramEmbedState } from "./diagram-embed-pool";
import { ApiClientError } from "./api";
import type { Page } from "../shared/types";
function room() {
  const events = new Map<string, Set<() => void>>();
  const doc = new Y.Doc();
  const bundle = {
    doc,
    synced: false,
    ready: Promise.resolve(),
    destroy: vi.fn(() => doc.destroy()),
    provider: {
      on: (name: string, fn: () => void) => {
        const set = events.get(name) ?? new Set();
        set.add(fn);
        events.set(name, set);
      },
      off: (name: string, fn: () => void) => events.get(name)?.delete(fn),
    },
  };
  return {
    bundle,
    emit: (name: string) => {
      for (const fn of events.get(name) ?? []) fn();
    },
  };
}
afterEach(() => vi.clearAllMocks());
describe("visible read-only diagram rooms", () => {
  it("shares a single room, waits for authoritative sync and never initializes shared data", async () => {
    mocks.api.mockResolvedValue({
      page: { id: "diagram", kind: "diagram", contentEpoch: 1, archivedAt: null } as Page,
    });
    const { bundle, emit } = room();
    mocks.network.mockReturnValue(bundle);
    const states: DiagramEmbedState[] = [];
    const first = subscribeDiagramEmbed("account", "diagram", (state) => states.push(state));
    const second = subscribeDiagramEmbed("account", "diagram", () => {});
    await waitFor(() => expect(mocks.network).toHaveBeenCalledOnce());
    expect(mocks.network.mock.calls[0]?.[3]).toBe(true);
    expect(states.at(-1)?.records).toBeNull();
    const update = vi.fn();
    bundle.doc.on("update", update);
    bundle.synced = true;
    emit("sync");
    expect(states.at(-1)?.records?.nodes).toEqual([]);
    expect(update).not.toHaveBeenCalled();
    first();
    expect(bundle.destroy).not.toHaveBeenCalled();
    second();
    expect(bundle.destroy).toHaveBeenCalledOnce();
  });
  it("reconnects to restored epochs and clears content after access loss", async () => {
    mocks.api.mockResolvedValue({
      page: { id: "diagram", kind: "diagram", contentEpoch: 1, archivedAt: null } as Page,
    });
    const one = room(),
      two = room();
    mocks.network.mockReturnValueOnce(one.bundle).mockReturnValueOnce(two.bundle);
    const states: DiagramEmbedState[] = [];
    const unsubscribe = subscribeDiagramEmbed("account", "diagram", (state) => states.push(state));
    await waitFor(() => expect(mocks.network).toHaveBeenCalledOnce());
    one.bundle.synced = true;
    one.emit("sync");
    mocks.api.mockResolvedValue({
      page: { id: "diagram", kind: "diagram", contentEpoch: 2, archivedAt: null } as Page,
    });
    window.dispatchEvent(
      new CustomEvent("notes:workspace-event", { detail: { type: "pages-upserted", pages: [{ id: "diagram" }] } }),
    );
    await waitFor(() => expect(mocks.network).toHaveBeenCalledTimes(2));
    expect(one.bundle.destroy).toHaveBeenCalledOnce();
    two.bundle.synced = true;
    two.emit("sync");
    expect(states.at(-1)?.records?.contentEpoch).toBe(2);
    mocks.api.mockRejectedValue(new ApiClientError(403, "denied", "Denied"));
    window.dispatchEvent(new Event("online"));
    await waitFor(() => expect(states.at(-1)?.status).toBe("unavailable"));
    expect(states.at(-1)?.records).toBeNull();
    unsubscribe();
  });
});
