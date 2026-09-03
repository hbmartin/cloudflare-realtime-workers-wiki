import type { Connection, ConnectionContext, WSMessage } from "partyserver";
import { YServer } from "y-partyserver";
import type { WorkspaceEvent } from "../shared/types";
import { ID_PATTERN, parseWorkspaceEvent } from "../shared/validation";
import type { Env } from "./env";

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
      `SELECT id, revision FROM pages
        WHERE workspace_id = ? AND archived_at IS NULL
          AND id IN (SELECT value FROM json_each(?))`,
    )
      .bind(workspaceId, JSON.stringify(candidates.map((page) => page.id)))
      .all<{ id: string; revision: number }>();
    const activeRevisions = new Map(active.results.map((page) => [page.id, page.revision]));
    const stateChanged = candidates.some((page) => {
      const activeRevision = activeRevisions.get(page.id);
      return activeRevision === undefined || activeRevision < page.revision;
    });
    if (stateChanged) return { type: "workspace-invalidated" };
    return { ...event, pages: candidates };
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
    if (event.type === "projection-updated" || event.type === "workspace-invalidated") {
      this.broadcastEvent(event);
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
        this.broadcastEvent({ type: "workspace-invalidated" });
      }
    }
  }

  private async deliver(workspaceId: string, event: WorkspaceEvent) {
    try {
      const currentEvent = await eventForCurrentWorkspaceState(this.bindings, workspaceId, event);
      if (currentEvent) this.broadcastEvent(currentEvent);
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

  private broadcastEvent(event: WorkspaceEvent) {
    this.broadcastCustomMessage(JSON.stringify(event));
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
