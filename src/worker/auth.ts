import { betterAuth } from "better-auth";
import type { MemberContext } from "./env";
import type { Env } from "./env";
import { HttpError } from "./http";

export function createAuth(env: Env) {
  return betterAuth({
    database: env.DB,
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
    },
    telemetry: { enabled: false },
  });
}

async function getMember(request: Request, env: Env): Promise<MemberContext | null> {
  const session = await createAuth(env).api.getSession({ headers: request.headers });
  if (!session) return null;

  const row = await env.DB.prepare(
    `SELECT w.id workspace_id, w.name workspace_name, w.location_hint, wm.role
       FROM workspace_members wm
       JOIN workspaces w ON w.id = wm.workspace_id
      WHERE wm.user_id = ?
      LIMIT 1`,
  )
    .bind(session.user.id)
    .first<{
      workspace_id: string;
      workspace_name: string;
      location_hint: string | null;
      role: MemberContext["role"];
    }>();

  if (!row) return null;
  return {
    user: { id: session.user.id, name: session.user.name, email: session.user.email },
    session: { id: session.session.id, expiresAt: session.session.expiresAt },
    workspace: {
      id: row.workspace_id,
      name: row.workspace_name,
      locationHint: row.location_hint,
    },
    role: row.role,
  };
}

export async function requireMember(request: Request, env: Env) {
  const member = await getMember(request, env);
  if (!member) throw new HttpError(401, "unauthorized", "Sign in to continue.");
  return member;
}

export function requireEditor(member: MemberContext) {
  if (member.role === "viewer") {
    throw new HttpError(403, "read_only", "Your workspace role is read-only.");
  }
}

export function requireOwner(member: MemberContext) {
  if (member.role !== "owner") {
    throw new HttpError(403, "owner_required", "Only a workspace owner can do that.");
  }
}
