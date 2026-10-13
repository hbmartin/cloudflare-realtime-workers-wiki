import { api } from "./api";
import type { WorkspaceEvent } from "../shared/types";

export type CardPreview = {
  page: { id: string; title: string; kind: string };
  text: string;
  table?: {
    viewId: string | null;
    name: string;
    columns: { id: string; name: string }[];
    rows: { id: string; cells: Record<string, unknown> }[];
    hasMore: boolean;
  };
};
export type CardPreviewState = { status: "loading" | "ok" | "unavailable"; preview: CardPreview | null };
const pools = new Map<string, { subscribe: (receive: (state: CardPreviewState) => void) => () => void }>();

/** Visible cards share one disposable, ACL-checked source request per account/view. */
export function subscribeCardPreview(
  account: string,
  pageId: string,
  viewId: string | null,
  receive: (state: CardPreviewState) => void,
) {
  const key = `${account}:${pageId}:${viewId ?? ""}`;
  let pool = pools.get(key);
  if (!pool) {
    const listeners = new Set<(state: CardPreviewState) => void>();
    let state: CardPreviewState = { status: "loading", preview: null };
    let active = true,
      running = false,
      queued = false,
      generation = 0;
    let controller: AbortController | null = null;
    const publish = (next: CardPreviewState) => {
      state = next;
      for (const listener of listeners) listener(next);
    };
    const refresh = async () => {
      if (!active) return;
      if (running) {
        queued = true;
        return;
      }
      running = true;
      controller = new AbortController();
      const version = generation;
      try {
        const result = await api<CardPreview>(
          `/api/pages/${encodeURIComponent(pageId)}/card-preview${viewId ? `?viewId=${encodeURIComponent(viewId)}` : ""}`,
          { signal: controller.signal },
        );
        if (active && generation === version) publish({ status: "ok", preview: result });
      } catch {
        if (active && generation === version) publish({ status: "unavailable", preview: null });
      } finally {
        running = false;
        if (active && queued) {
          queued = false;
          void refresh();
        }
      }
    };
    const workspace = (event: Event) => {
      const change = (event as CustomEvent<WorkspaceEvent>).detail;
      if (change?.type === "pages-removed" && change.pageIds.includes(pageId)) {
        generation++;
        controller?.abort();
        publish({ status: "unavailable", preview: null });
        return;
      }
      if (
        change?.type === "workspace-invalidated" ||
        change?.type === "organization-invalidated" ||
        (change?.type === "pages-upserted" && change.pages.some((page) => page.id === pageId)) ||
        (change?.type === "projection-updated" && change.pageId === pageId)
      ) {
        generation++;
        // Drop cached metadata before checking a changed permission/source.
        publish({ status: "loading", preview: null });
        void refresh();
      }
    };
    const online = () => {
      generation++;
      publish({ status: "loading", preview: null });
      void refresh();
    };
    window.addEventListener("notes:workspace-event", workspace);
    window.addEventListener("online", online);
    const timer = window.setInterval(() => void refresh(), 30_000);
    pool = {
      subscribe(listener) {
        listeners.add(listener);
        listener(state);
        if (state.status === "loading" && !running) void refresh();
        return () => {
          listeners.delete(listener);
          if (listeners.size) return;
          active = false;
          controller?.abort();
          window.clearInterval(timer);
          window.removeEventListener("notes:workspace-event", workspace);
          window.removeEventListener("online", online);
          pools.delete(key);
        };
      },
    };
    pools.set(key, pool);
  }
  return pool.subscribe(receive);
}
