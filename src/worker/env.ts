import type { Document } from "./document";
import type { WorkspaceEvents } from "./workspace-events";
import type { JobWorkflowParams } from "./jobs";

export type { MemberContext } from "../shared/types";

export interface AppBindings {
  DB: D1Database;
  BUCKET: R2Bucket;
  DOCUMENT: DurableObjectNamespace<Document>;
  WORKSPACE_EVENTS: DurableObjectNamespace<WorkspaceEvents>;
  NOTES_WORKFLOW: Workflow<Readonly<JobWorkflowParams>>;
  DELIVERY_QUEUE: Queue;
  SEND_EMAIL?: SendEmail;
  BROWSER?: BrowserRun;
  EMAIL_FROM?: string;
  SLACK_CLIENT_ID?: string;
  SLACK_CLIENT_SECRET?: string;
  SLACK_SIGNING_SECRET?: string;
  SLACK_TOKEN_ENCRYPTION_KEY?: string;
  ASSETS: Fetcher;
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
  BOOTSTRAP_TOKEN: string;
  DO_LOCATION_HINT?: DurableObjectLocationHint;
  WORKFLOW_INLINE?: "true";
}

export interface Env extends AppBindings {}

declare global {
  namespace Cloudflare {
    interface Env extends AppBindings {}
  }
}
