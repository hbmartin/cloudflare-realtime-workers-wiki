import type { Connection, ConnectionContext, WSMessage } from "partyserver";
import { YServer } from "y-partyserver";
import type { Page, WorkspaceEvent } from "../shared/types";
import { ID_PATTERN, parseWorkspaceEvent } from "../shared/validation";
import type { Env } from "./env";
import { pageJson, type PageJsonRow } from "./page-row";

export interface EventConnectionAuth {
  userId: string;
  expiresAt: number;
  __ypsAwarenessIds?: number[];
}

const WORKSPACE_EVENT_DELIVERY_QUEUE_LIMIT = 128;

export async function eventForCurrentWorkspaceState(
  env: Env,
  workspaceId: string,
  event: WorkspaceEvent,
): Promise<WorkspaceEvent | null> {
  if (event.type === "pages-upserted") {
    const candidates = event.pages.filter((page) => page.workspaceId === workspaceId && page.archivedAt === null);
    if (!candidates.length) return null;
    const active = await env.DB.prepare(
      `SELECT id, workspace_id, space_id, parent_id, kind, position, title, icon, revision,
              content_epoch, is_template, archived_at, created_at, updated_at FROM pages
        WHERE workspace_id = ? AND archived_at IS NULL
          AND id IN (SELECT value FROM json_each(?))`,
    )
      .bind(workspaceId, JSON.stringify(candidates.map((page) => page.id)))
      .all<PageJsonRow>();
    const activePages = new Map(active.results.map((row) => [row.id, pageJson(row)]));
    const currentPages: Page[] = [];
    for (const page of candidates) {
      const current = activePages.get(page.id);
      if (current === undefined || current.revision < page.revision) return { type: "workspace-invalidated" };
      currentPages.push(current);
    }
    // A later mutation can commit before an older queued event is delivered.
    // Broadcast the current rows instead of forcing every client to reconnect;
    // clients still receive authoritative state even if the later event is lost.
    return { ...event, pages: currentPages };
  }
  if (event.type === "pages-removed") {
    const statePredicate = event.permanently ? "1 = 1" : "archived_at IS NOT NULL";
    const matching = await env.DB.prepare(
      `SELECT id FROM pages
        WHERE workspace_id = ? AND ${statePredicate}
          AND id IN (SELECT value FROM json_each(?))`,
    )
      .bind(workspaceId, JSON.stringify(event.pageIds))
      .all<{ id: string }>();
    const matchingIds = new Set(matching.results.map((page) => page.id));
    const pageIds = event.permanently
      ? event.pageIds.filter((pageId) => !matchingIds.has(pageId))
      : event.pageIds.filter((pageId) => matchingIds.has(pageId));
    return pageIds.length ? { ...event, pageIds } : null;
  }
  return event;
}

export class WorkspaceEvents extends YServer {
  static options = { hibernate: true };

  private readonly state: DurableObjectState;
  private readonly bindings: Env;
  private deliveryQueue = Promise.resolve();
  private queuedDeliveries = 0;
  private resyncRequired = false;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.state = state;
    this.bindings = env;
  }

  async onConnect(connection: Connection<EventConnectionAuth>, context: ConnectionContext) {
    const userId = context.request.headers.get("x-notes-user-id");
    const expiresAt = Number(context.request.headers.get("x-notes-expires-at"));
    if (!userId || !expiresAt) {
      connection.close(4401, "Authorization missing.");
      return;
    }
    connection.setState({ userId, expiresAt });
    await this.scheduleAlarm(expiresAt);
    await super.onConnect(connection, context);
  }

  isReadOnly() {
    return true;
  }

  onMessage(connection: Connection<EventConnectionAuth>, message: WSMessage) {
    if (!connection.state || connection.state.expiresAt <= Date.now()) {
      connection.close(4401, "Authorization expired. Reconnect to continue.");
      return;
    }
    return super.onMessage(connection, message);
  }

  async onAlarm() {
    const time = Date.now();
    for (const connection of this.getConnections<EventConnectionAuth>()) {
      if (!connection.state || connection.state.expiresAt <= time) {
        connection.close(4401, "Authorization expired. Reconnect to continue.");
      }
    }
    const nextExpiry = Array.from(this.getConnections<EventConnectionAuth>())
      .map((connection) => connection.state?.expiresAt ?? 0)
      .filter((expiry) => expiry > time)
      .sort((left, right) => left - right)[0];
    if (nextExpiry) await this.scheduleAlarm(nextExpiry);
  }

  async onRequest(request: Request) {
    if (request.headers.get("x-notes-internal") !== this.bindings.BETTER_AUTH_SECRET) {
      return new Response("Forbidden", { status: 403 });
    }
    if (request.method !== "POST") return new Response("Not found", { status: 404 });
    const workspaceId = this.state.id.name;
    if (!workspaceId || !ID_PATTERN.test(workspaceId)) {
      return Response.json({ error: "Invalid workspace object identity." }, { status: 500 });
    }
    let value: unknown;
    try {
      value = await request.json();
    } catch {
      return Response.json({ error: "Invalid workspace event." }, { status: 400 });
    }
    const event = parseWorkspaceEvent(value);
    if (!event) return Response.json({ error: "Invalid workspace event." }, { status: 400 });

    // Projection notifications do not depend on page lifecycle ordering and do
    // not read D1, so a slow lifecycle check must not hold them behind it.
    if (
      event.type === "projection-updated" ||
      event.type === "workspace-invalidated" ||
      event.type === "organization-invalidated" ||
      event.type === "notifications-invalidated" ||
      event.type === "jobs-invalidated"
    ) {
      await this.broadcastEvent(event, workspaceId);
      return Response.json({ delivered: true });
    }
    if (this.queuedDeliveries >= WORKSPACE_EVENT_DELIVERY_QUEUE_LIMIT) {
      // The mutation is already committed, so rejecting this request would leave
      // connected clients stale indefinitely. Collapse all overflow into one
      // authoritative refresh after the accepted queue drains.
      if (!this.resyncRequired) {
        console.warn("Workspace event delivery queue overflow; scheduling workspace invalidation.", {
          workspaceId,
          queuedDeliveries: this.queuedDeliveries,
        });
      }
      this.resyncRequired = true;
      return Response.json({ delivered: false, resyncScheduled: true }, { status: 202 });
    }
    this.queuedDeliveries += 1;
    const delivery = this.deliveryQueue.then(() => this.deliver(workspaceId, event));
    this.deliveryQueue = delivery.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await delivery;
    } finally {
      this.queuedDeliveries -= 1;
      if (this.queuedDeliveries === 0 && this.resyncRequired) {
        this.resyncRequired = false;
        await this.broadcastEvent({ type: "workspace-invalidated" }, workspaceId);
      }
    }
  }

  private async deliver(workspaceId: string, event: WorkspaceEvent) {
    try {
      const currentEvent = await eventForCurrentWorkspaceState(this.bindings, workspaceId, event);
      if (currentEvent) await this.broadcastEvent(currentEvent, workspaceId);
      return Response.json({ delivered: currentEvent !== null });
    } catch (error) {
      console.error("Workspace event state check failed; scheduling workspace invalidation.", {
        workspaceId,
        error,
      });
      this.resyncRequired = true;
      return Response.json({ delivered: false, resyncScheduled: true }, { status: 202 });
    }
  }

  private async broadcastEvent(event: WorkspaceEvent, workspaceId: string) {
    if (
      event.type === "workspace-invalidated" ||
      event.type === "organization-invalidated" ||
      event.type === "notifications-invalidated" ||
      event.type === "jobs-invalidated"
    ) {
      this.broadcastCustomMessage(JSON.stringify(event));
    } else {
      const pageIds =
        event.type === "pages-upserted"
          ? event.pages.map((page) => page.id)
          : event.type === "pages-removed"
            ? event.pageIds
            : [event.pageId];
      const pages = await this.bindings.DB.prepare(
        `SELECT p.id, p.space_id, s.visibility FROM pages p JOIN spaces s ON s.id = p.space_id
          WHERE p.workspace_id = ? AND p.id IN (SELECT value FROM json_each(?))`,
      )
        .bind(workspaceId, JSON.stringify(pageIds))
        .all<{ id: string; space_id: string; visibility: "workspace" | "private" }>();

      // A permanently deleted page no longer carries a scope. A metadata-free
      // refresh is safe for every member and avoids leaking its former identity.
      if (!pages.results.length) {
        this.broadcastCustomMessage(JSON.stringify({ type: "workspace-invalidated" } satisfies WorkspaceEvent));
        return;
      }

      const privateSpaceIds = [
        ...new Set(pages.results.filter((page) => page.visibility === "private").map((page) => page.space_id)),
      ];
      const grants = privateSpaceIds.length
        ? await this.bindings.DB.prepare(
            `SELECT sm.space_id, sm.user_id FROM space_members sm
              WHERE sm.space_id IN (SELECT value FROM json_each(?))
              UNION ALL
              SELECT s.id, wm.user_id FROM spaces s JOIN workspace_members wm ON wm.workspace_id = s.workspace_id
               WHERE s.id IN (SELECT value FROM json_each(?)) AND wm.role = 'owner'`,
          )
            .bind(JSON.stringify(privateSpaceIds), JSON.stringify(privateSpaceIds))
            .all<{ space_id: string; user_id: string }>()
        : { results: [] as Array<{ space_id: string; user_id: string }> };
      const allowed = new Map<string, Set<string>>();
      for (const grant of grants.results) {
        const users = allowed.get(grant.space_id) ?? new Set<string>();
        users.add(grant.user_id);
        allowed.set(grant.space_id, users);
      }
      const byId = new Map(pages.results.map((page) => [page.id, page]));
      const eventForAudience = (canRead: (pageId: string) => boolean): WorkspaceEvent | null => {
        if (event.type === "pages-upserted") {
          const visiblePages = event.pages.filter((page) => canRead(page.id));
          if (!visiblePages.length) return null;
          const includesRestoredRoot =
            event.restoredRootId === undefined || visiblePages.some((page) => page.id === event.restoredRootId);
          return includesRestoredRoot
            ? { ...event, pages: visiblePages }
            : { type: "pages-upserted", pages: visiblePages };
        }
        if (event.type === "pages-removed") {
          const visibleIds = event.pageIds.filter(canRead);
          return visibleIds.length ? { ...event, pageIds: visibleIds } : null;
        }
        return canRead(event.pageId) ? event : null;
      };

      // Workspace-visible spaces share one safe audience, so keep the fast
      // broadcast path. Private-space events are partitioned per connection.
      const workspaceEvent = eventForAudience((pageId) => byId.get(pageId)?.visibility === "workspace");
      if (workspaceEvent) this.broadcastCustomMessage(JSON.stringify(workspaceEvent));
      for (const connection of this.getConnections<EventConnectionAuth>()) {
        const userId = connection.state?.userId;
        if (!userId) continue;
        const visible = eventForAudience((pageId) => {
          const page = byId.get(pageId);
          return Boolean(page?.visibility === "private" && allowed.get(page.space_id)?.has(userId));
        });
        if (visible) this.sendCustomMessage(connection, JSON.stringify(visible));
      }
    }
    if (event.type !== "workspace-invalidated") return;

    // Older bundles do not recognize this event type. Closing after the
    // broadcast makes every client reconnect and reload authoritative state.
    for (const connection of this.getConnections<EventConnectionAuth>()) {
      connection.close(1012, "Workspace refresh required.");
    }
  }

  private async scheduleAlarm(when: number) {
    const existing = await this.state.storage.getAlarm();
    if (existing === null || when < existing) await this.state.storage.setAlarm(when);
  }
}

export async function broadcastWorkspaceEvent(env: Env, workspaceId: string, event: WorkspaceEvent) {
  const stub = env.WORKSPACE_EVENTS.getByName(workspaceId);
  const response = await stub.fetch(
    new Request("https://workspace-events.internal/broadcast", {
      method: "POST",
      headers: {
        "x-notes-internal": env.BETTER_AUTH_SECRET,
      },
      body: JSON.stringify(event),
    }),
  );
  if (!response.ok) throw new Error(`Workspace event delivery failed with ${response.status}`);
  if (response.status === 202) {
    console.warn("Workspace event delivery deferred to an authoritative resync.", { workspaceId });
  }
}
