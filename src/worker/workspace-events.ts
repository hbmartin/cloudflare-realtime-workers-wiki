import type { Connection, ConnectionContext, WSMessage } from "partyserver";
import { YServer } from "y-partyserver";
import type { WorkspaceEvent } from "../shared/types";
import { isPage } from "../shared/validation";
import type { Env } from "./env";

export interface EventConnectionAuth {
  userId: string;
  expiresAt: number;
  __ypsAwarenessIds?: number[];
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function workspaceEvent(value: unknown): WorkspaceEvent | null {
  const event = record(value);
  if (!event) return null;
  if (
    event.type === "pages-upserted" &&
    Array.isArray(event.pages) &&
    event.pages.every(isPage) &&
    (event.restored === undefined || typeof event.restored === "boolean")
  ) {
    return event as WorkspaceEvent;
  }
  if (
    event.type === "pages-removed" &&
    stringList(event.pageIds) &&
    typeof event.permanently === "boolean" &&
    (event.operationId === undefined || typeof event.operationId === "string")
  ) {
    return event as WorkspaceEvent;
  }
  if (
    event.type === "projection-updated" &&
    typeof event.pageId === "string" &&
    stringList(event.backlinkTargetIds) &&
    stringList(event.mentionTargetUserIds)
  ) {
    return event as WorkspaceEvent;
  }
  return null;
}

export class WorkspaceEvents extends YServer {
  static options = { hibernate: true };

  private readonly state: DurableObjectState;
  private readonly bindings: Env;

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
    let value: unknown;
    try {
      value = await request.json();
    } catch {
      return Response.json({ error: "Invalid workspace event." }, { status: 400 });
    }
    const event = workspaceEvent(value);
    if (!event) return Response.json({ error: "Invalid workspace event." }, { status: 400 });
    this.broadcastCustomMessage(JSON.stringify(event));
    return Response.json({ delivered: true });
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
      headers: { "x-notes-internal": env.BETTER_AUTH_SECRET },
      body: JSON.stringify(event),
    }),
  );
  if (!response.ok) throw new Error(`Workspace event delivery failed with ${response.status}`);
}
