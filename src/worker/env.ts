import type { Document } from "./document";
import type { WorkspaceEvents } from "./workspace-events";

export interface AppBindings {
  DB: D1Database;
  BUCKET: R2Bucket;
  DOCUMENT: DurableObjectNamespace<Document>;
  WORKSPACE_EVENTS: DurableObjectNamespace<WorkspaceEvents>;
  ASSETS: Fetcher;
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
  BOOTSTRAP_TOKEN: string;
  DO_LOCATION_HINT?: DurableObjectLocationHint;
}

export interface Env extends AppBindings {}

declare global {
  namespace Cloudflare {
    interface Env extends AppBindings {}
  }
}

export interface MemberContext {
  user: { id: string; name: string; email: string };
  session: { id: string; expiresAt: Date };
  workspace: { id: string; name: string; locationHint: string | null };
  role: "owner" | "editor" | "viewer";
}
