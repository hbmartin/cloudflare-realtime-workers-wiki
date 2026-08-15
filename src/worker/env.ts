import type { Document } from "./document";
import type { WorkspaceEvents } from "./workspace-events";

export type { MemberContext } from "../shared/types";

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
