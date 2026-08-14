import type { Connection, ConnectionContext, WSMessage } from "partyserver";
import { YServer } from "y-partyserver";
import type { WorkspaceEvent } from "../shared/types";
import type { Env } from "./env";

interface EventConnectionAuth {
  userId: string;
  expiresAt: number;
  __ypsAwarenessIds?: number[];
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
    const event = await request.text();
    this.broadcastCustomMessage(event);
    return Response.json({ delivered: true });
  }

  private async scheduleAlarm(when: number) {
    const existing = await this.state.storage.getAlarm();
    if (existing === null || when < existing) await this.state.storage.setAlarm(when);
  }
}

export async function broadcastWorkspaceEvent(env: Env, workspaceId: string, event: WorkspaceEvent) {
  const stub = env.WORKSPACE_EVENTS.getByName(workspaceId);
  const response = await stub.fetch(new Request("https://workspace-events.internal/broadcast", {
    method: "POST",
    headers: { "x-notes-internal": env.BETTER_AUTH_SECRET },
    body: JSON.stringify(event),
  }));
  if (!response.ok) throw new Error(`Workspace event delivery failed with ${response.status}`);
}
