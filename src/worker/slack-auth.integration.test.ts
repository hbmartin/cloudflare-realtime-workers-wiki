import { applyD1Migrations, createExecutionContext, env, reset, SELF, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { enrollAccount, responseCookies, securityRequest } from "../../tests/helpers/security";
import { bytesToBase64Url } from "../shared/security";
import worker from "./index";
import * as authApi from "better-auth/api";
import { HttpError } from "./http";
import type { Env, MemberContext } from "./env";
import { consumeSlackLink, encryptSlackToken } from "./slack";
import { disconnectSlackIdentity, slackAccessAuthorization } from "./slack-identity";

const configured = () =>
  ({
    ...env,
    SLACK_CLIENT_ID: "123.456",
    SLACK_CLIENT_SECRET: "slack-secret",
    SLACK_SIGNING_SECRET: "slack-signing-secret",
    SLACK_TOKEN_ENCRYPTION_KEY: "slack-encryption-test-secret",
  }) as unknown as Env;
let key: CryptoKeyPair,
  jwk: JsonWebKey,
  nonce: string | null,
  slackUser: string,
  team: string,
  userFlags: Record<string, unknown>;
beforeAll(async () => {
  key = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  jwk = await crypto.subtle.exportKey("jwk", key.publicKey);
});
async function token() {
  const encode = (value: unknown) => bytesToBase64Url(new TextEncoder().encode(JSON.stringify(value)));
  const unsigned = `${encode({ alg: "RS256", kid: "slack-test-key", typ: "JWT" })}.${encode({
    iss: "https://slack.com",
    aud: "123.456",
    sub: slackUser,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 600,
    ...(nonce ? { nonce } : {}),
    email: `${slackUser.toLowerCase()}@example.test`,
    email_verified: true,
    name: "Slack member",
    "https://slack.com/team_id": team,
    "https://slack.com/user_id": slackUser,
  })}`;
  return `${unsigned}.${bytesToBase64Url(new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key.privateKey, new TextEncoder().encode(unsigned))))}`;
}
beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
  nonce = null;
  slackUser = "UOWNER";
  team = "T123";
  userFlags = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname.endsWith("openid-configuration"))
        return Response.json({
          issuer: "https://slack.com",
          jwks_uri: "https://slack.com/openid/connect/keys",
          authorization_endpoint: "https://slack.com/openid/connect/authorize",
          token_endpoint: "https://slack.com/api/openid.connect.token",
          userinfo_endpoint: "https://slack.com/api/openid.connect.userInfo",
          id_token_signing_alg_values_supported: ["RS256"],
        });
      if (url.pathname.endsWith("/keys"))
        return Response.json({ keys: [{ ...jwk, kid: "slack-test-key", alg: "RS256", use: "sig" }] });
      if (url.pathname.endsWith("openid.connect.token"))
        return Response.json({
          ok: true,
          access_token: "xoxp-test",
          token_type: "Bearer",
          expires_in: 600,
          id_token: await token(),
          scope: "openid profile email",
        });
      if (url.pathname.endsWith("openid.connect.userInfo"))
        return Response.json({
          ok: true,
          sub: slackUser,
          name: "Slack member",
          email: `${slackUser.toLowerCase()}@example.test`,
          "https://slack.com/team_id": team,
          "https://slack.com/user_id": slackUser,
        });
      if (url.pathname.endsWith("users.info"))
        return Response.json({ ok: true, user: { id: slackUser, team_id: team, ...userFlags } });
      throw new Error(`Unexpected Slack request ${url.pathname}`);
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
async function account(protectedAccount = true) {
  const response = await SELF.fetch("http://example.test/api/install/bootstrap", {
    method: "POST",
    headers: { origin: "http://example.test", "content-type": "application/json" },
    body: JSON.stringify({
      bootstrapToken: "worker-bootstrap-token",
      workspaceName: "Slack Notes",
      name: "Owner",
      email: "owner@example.test",
      password: "password123",
    }),
  });
  expect(response.status).toBe(200);
  const cookie = protectedAccount ? await enrollAccount(response) : responseCookies(response);
  const user = (await env.DB.prepare("SELECT id FROM user").first<{ id: string }>())!.id;
  const workspace = (await env.DB.prepare("SELECT id FROM workspaces").first<{ id: string }>())!.id;
  await env.DB.prepare(`INSERT INTO slack_installations(id,workspace_id,team_id,team_name,bot_user_id,bot_token_ciphertext,scopes,installed_by,created_at,updated_at)
    VALUES('installation',?,'T123','Slack','UBOT',?,'users:read,chat:write',?,1,1)`)
    .bind(workspace, await encryptSlackToken(configured(), "xoxb-test"), user)
    .run();
  return { cookie, user, workspace };
}
async function auth(cookie: string, path: string, body?: Record<string, unknown>, database = env.DB) {
  const context = createExecutionContext();
  const response = await worker.fetch(
    new Request(`http://example.test/api/auth${path}`, {
      method: body ? "POST" : "GET",
      headers: { cookie, origin: "http://example.test", ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
    { ...configured(), DB: database },
    context,
  );
  await waitOnExecutionContext(context);
  return response;
}
async function start(cookie: string, body: Record<string, unknown> = {}, path = "/link-social", database = env.DB) {
  const response = await auth(
    cookie,
    path,
    {
      provider: "slack",
      callbackURL: "/?view=settings&slack=verified",
      errorCallbackURL: "/?view=settings&slackAuth=callback",
      disableRedirect: true,
      ...body,
    },
    database,
  );
  expect(response.status).toBe(200);
  const url = new URL((await response.json<{ url: string }>()).url);
  nonce = url.searchParams.get("nonce");
  return { state: url.searchParams.get("state")!, cookie: responseCookies(response, cookie) };
}
const callback = (flow: { state: string; cookie: string }, database = env.DB) =>
  auth(flow.cookie, `/callback/slack?state=${encodeURIComponent(flow.state)}&code=test-code`, undefined, database);

function beforeAuthWrite(pattern: string, before: () => Promise<void>) {
  let triggered = false;
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, property) {
        if (property === "bind") return (...binds: unknown[]) => wrap(target.bind(...binds));
        if (property === "run")
          return async () => {
            if (!triggered) {
              triggered = true;
              await before();
            }
            return target.run();
          };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  return new Proxy(env.DB, {
    get(target, property) {
      if (property === "prepare")
        return (sql: string) => (sql.includes(pattern) ? wrap(target.prepare(sql)) : target.prepare(sql));
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("Slack OAuth authorization boundaries", () => {
  it.each(["verified", "legacy"])(
    "repairs a NULL grant start through %s relinking without admitting historical work",
    async (mode) => {
      const { cookie, user } = await account();
      await callback(await start(cookie));
      await env.DB.prepare("UPDATE slack_user_links SET authorization_started_at=NULL").run();
      let location: string | null = null;
      if (mode === "verified") {
        const response = await callback(await start(cookie));
        location = response.headers.get("location");
      } else {
        const raw = "repair-null-link-token";
        const hash = Array.from(
          new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw))),
          (byte) => byte.toString(16).padStart(2, "0"),
        ).join("");
        await env.DB.prepare(
          "INSERT INTO slack_link_tokens(token_hash,installation_id,slack_user_id,expires_at,created_at) VALUES(?,'installation','UOWNER',?,1)",
        )
          .bind(hash, Date.now() + 60000)
          .run();
        const member = await (await securityRequest(cookie, "/api/me")).json<MemberContext>();
        const session = (await env.DB.prepare("SELECT id FROM session WHERE userId=?")
          .bind(user)
          .first<{ id: string }>())!;
        await consumeSlackLink(
          configured(),
          { ...member, session: { id: session.id, expiresAt: new Date(Date.now() + 60000) } },
          raw,
        );
      }
      expect(location?.includes("slack=verified") ?? false).toBe(mode === "verified");
      const link = (await env.DB.prepare("SELECT authorization_started_at,linked_at FROM slack_user_links").first<{
        authorization_started_at: number;
        linked_at: number;
      }>())!;
      expect(link.authorization_started_at).toBe(link.linked_at);
      expect(link.authorization_started_at).toBeGreaterThan(2);
      await expect(
        slackAccessAuthorization(configured(), { id: "installation", generation: 0 }, { userId: user }, 2)(),
      ).rejects.toMatchObject({ code: "slack_identity_required" });
      await expect(
        slackAccessAuthorization(
          configured(),
          { id: "installation", generation: 0 },
          { userId: user },
          link.authorization_started_at,
        )(),
      ).resolves.toBeUndefined();
    },
  );

  it.each(["old", "malformed"])("rejects a %s populated OAuth permit before changing its grant", async (mode) => {
    const { cookie, user } = await account();
    await callback(await start(cookie));
    const before = await env.DB.prepare("SELECT * FROM slack_user_links").first();
    const database = new Proxy(env.DB, {
      get(target, property) {
        if (property === "prepare")
          return (sql: string) => {
            const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
              new Proxy(statement, {
                get(prepared, method) {
                  if (method === "bind") return (...binds: unknown[]) => wrap(prepared.bind(...binds));
                  if (method === "all" && sql.includes("SELECT installation_id,slack_user_id,better_auth_account_id"))
                    return async () => {
                      const rows = await prepared.all<Record<string, unknown>>();
                      return {
                        ...rows,
                        results: rows.results.map((row) => {
                          const binding = { ...row };
                          delete binding.installation_generation;
                          delete binding.authorization_started_at;
                          if (mode === "malformed") binding.linked_at = "invalid";
                          return binding;
                        }),
                      };
                    };
                  const value: unknown = Reflect.get(prepared, method, prepared);
                  return typeof value === "function" ? value.bind(prepared) : value;
                },
              });
            return wrap(target.prepare(sql));
          };
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const flow = await start(cookie, {}, "/link-social", database);
    const response = await callback(flow);
    expect(response.status).toBe(302);
    expect(
      new URL(response.headers.get("location")!, "http://example.test").searchParams.get("error")?.toLowerCase(),
    ).toBe(mode === "old" ? "slack_link_changed" : "unauthorized");
    expect(await env.DB.prepare("SELECT * FROM slack_user_links WHERE user_id=?").bind(user).first()).toEqual(before);
  });

  it.each(["default", "custom", "custom query"])(
    "preserves the %s error destination when OAuth state is rejected",
    async (mode) => {
      const { cookie } = await account();
      const flow = await start(cookie, {
        errorCallbackURL:
          mode === "default" ? undefined : mode === "custom" ? "/custom-error?keep=1" : "/api/auth/error?keep=1",
      });
      const response = await callback({ ...flow, cookie: "" });
      const destination = new URL(response.headers.get("location")!, "http://example.test");
      expect(destination.pathname).toBe(
        mode === "default" ? "/" : mode === "custom" ? "/custom-error" : "/api/auth/error",
      );
      expect(destination.searchParams.get("error")).toBe("state_mismatch");
      expect(destination.searchParams.get("keep")).toBe(mode === "default" ? null : "1");
      expect(destination.origin).toBe("http://example.test");
    },
  );

  it.each(["default", "custom", "custom query"])(
    "routes completion errors to the %s application destination",
    async (mode) => {
      const { cookie } = await account();
      const flow = await start(cookie, {
        errorCallbackURL:
          mode === "default"
            ? undefined
            : mode === "custom query"
              ? "/api/auth/error?keep=1"
              : "/custom-error?keep=1&slackAuth=callback",
      });
      const database = beforeAuthWrite("INSERT INTO slack_user_links", async () => {
        await env.DB.prepare("UPDATE slack_installations SET generation=generation+1").run();
      });
      const response = await callback(flow, database);
      const destination = new URL(response.headers.get("location")!, "http://example.test");
      expect(destination.pathname).toBe(
        mode === "default" ? "/" : mode === "custom query" ? "/api/auth/error" : "/custom-error",
      );
      expect(destination.searchParams.get("error")).toBe("slack_link_changed");
      expect(destination.searchParams.get(mode === "default" ? "view" : "keep")).toBe(
        mode === "default" ? "settings" : "1",
      );
    },
  );

  it.each(["D1", "TypeError", "server"])(
    "logs a sanitized %s completion failure before returning a friendly error",
    async (kind) => {
      const { cookie } = await account();
      const flow = await start(cookie);
      const secret = "xoxb-test-log-secret";
      const failure =
        kind === "server"
          ? new HttpError(503, "server_failure", `Failure ${secret}`)
          : kind === "TypeError"
            ? new TypeError(`Failure ${secret}`)
            : new Error(`D1 failure ${secret}`);
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      const response = await callback(
        flow,
        beforeAuthWrite("INSERT INTO slack_user_links", async () => {
          throw failure;
        }),
      );
      expect(response.status).toBe(302);
      expect(new URL(response.headers.get("location")!, "http://example.test").searchParams.get("error")).toBe(
        "slack_unavailable",
      );
      expect(log.mock.calls).toEqual(
        expect.arrayContaining([
          [expect.objectContaining({ event: "auth.slack.failed", operation: "callback", severity: "error" })],
        ]),
      );
      expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
      expect(await env.DB.prepare("SELECT 1 FROM slack_user_links").first()).toBeNull();
    },
  );

  it.each(["D1", "TypeError", "server"])(
    "logs unexpected %s identity-policy failures while keeping expected denials ordinary",
    async (kind) => {
      const { cookie } = await account();
      const flow = await start(cookie, { errorCallbackURL: undefined });
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      const failure =
        kind === "server"
          ? new HttpError(503, "unexpected_server_error", "Internal policy detail")
          : kind === "TypeError"
            ? new TypeError("Injected identity policy failure")
            : new Error("Injected D1 failure");
      const database = new Proxy(env.DB, {
        get(target, property) {
          if (property === "prepare")
            return (sql: string) => {
              const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
                new Proxy(statement, {
                  get(prepared, method) {
                    if (method === "bind") return (...binds: unknown[]) => wrap(prepared.bind(...binds));
                    if (method === "first" && sql.includes("SELECT * FROM slack_installations"))
                      return async () => {
                        throw failure;
                      };
                    const value: unknown = Reflect.get(prepared, method, prepared);
                    return typeof value === "function" ? value.bind(prepared) : value;
                  },
                });
              return wrap(target.prepare(sql));
            };
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const response = await callback(flow, database);
      expect(new URL(response.headers.get("location")!, "http://example.test").searchParams.get("error")).toBe(
        "slack_unavailable",
      );
      expect(new URL(response.headers.get("location")!, "http://example.test").searchParams.get("view")).toBe(
        "settings",
      );
      expect(log.mock.calls).toEqual(
        expect.arrayContaining([
          [expect.objectContaining({ event: "auth.slack.failed", operation: "identity_validation" })],
        ]),
      );
      log.mockClear();
      userFlags = { deleted: true };
      await callback(await start(cookie));
      expect(log.mock.calls.filter(([record]) => (record as { event?: string }).event === "auth.slack.failed")).toEqual(
        [],
      );
    },
  );

  it.each(["http://[invalid", "https://foreign.example/error?keep=1"])(
    "normalizes an old callback error destination %s",
    async (errorURL) => {
      const { cookie } = await account();
      const flow = await start(cookie);
      const getState = authApi.getOAuthState;
      vi.spyOn(authApi, "getOAuthState").mockImplementation(async () => {
        const state = await getState();
        return state ? { ...state, errorURL } : state;
      });
      const response = await callback(
        flow,
        beforeAuthWrite("INSERT INTO slack_user_links", async () => {
          await env.DB.prepare("UPDATE slack_installations SET generation=generation+1").run();
        }),
      );
      const destination = new URL(response.headers.get("location")!, "http://example.test");
      expect(destination.origin).toBe("http://example.test");
      expect(destination.pathname).toBe("/");
      expect(destination.searchParams.get("view")).toBe("settings");
      expect(destination.searchParams.get("error")).toBe("slack_link_changed");
      expect(destination.searchParams.has("keep")).toBe(false);
    },
  );

  it("routes a default sign-in completion failure to the sign-in callback screen", async () => {
    const { cookie } = await account();
    await callback(await start(cookie));
    const flow = await start("", { errorCallbackURL: undefined }, "/sign-in/social");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await callback(
      flow,
      beforeAuthWrite("INSERT INTO slack_primary_factor_proofs", async () => {
        throw new Error("D1 unavailable");
      }),
    );
    const destination = new URL(response.headers.get("location")!, "http://example.test");
    expect(destination.pathname).toBe("/");
    expect(destination.searchParams.get("slackAuth")).toBe("callback");
    expect(destination.searchParams.get("error")).toBe("slack_unavailable");
    expect(destination.searchParams.has("view")).toBe(false);
  });

  it.each([
    "legacy relink",
    "legacy verification",
    "verified relink",
    "identity replacement",
    "installation reconnect",
    "security reset",
  ])("preserves only a continuous authorization start through %s", async (mode) => {
    const { cookie, user } = await account();
    await env.DB.prepare(`INSERT INTO slack_user_links(installation_id,user_id,slack_user_id,linked_at,security_generation,installation_generation,authorization_started_at)
        VALUES('installation',?,'UOWNER',1,0,0,1)`)
      .bind(user)
      .run();
    if (["verified relink", "identity replacement", "installation reconnect", "security reset"].includes(mode))
      await callback(await start(cookie));
    if (mode === "identity replacement") slackUser = "UREPLACEMENT";
    if (mode === "installation reconnect")
      await env.DB.prepare("UPDATE slack_installations SET generation=generation+1").run();
    if (mode === "security reset") {
      await env.DB.prepare("UPDATE account_security SET generation=generation+1").run();
      await env.DB.prepare("UPDATE session_security SET generation=1,verified_at=?").bind(Date.now()).run();
    }
    let completion: Response | null = null;
    if (mode === "legacy relink") {
      const raw = "continuity-link-token";
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
      const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
      await env.DB.prepare(
        "INSERT INTO slack_link_tokens(token_hash,installation_id,slack_user_id,expires_at,created_at) VALUES(?,'installation','UOWNER',?,1)",
      )
        .bind(hash, Date.now() + 60000)
        .run();
      const member = await (await securityRequest(cookie, "/api/me")).json<MemberContext>();
      const session = (await env.DB.prepare("SELECT id FROM session WHERE userId=?")
        .bind(user)
        .first<{ id: string }>())!;
      await consumeSlackLink(
        configured(),
        { ...member, session: { id: session.id, expiresAt: new Date(Date.now() + 60000) } },
        raw,
      );
    } else {
      completion = await callback(await start(cookie));
    }
    expect(completion?.status ?? 200).toBe(mode === "legacy relink" ? 200 : 302);
    expect(completion?.headers.get("location")?.includes("slack=verified") ?? false).toBe(mode !== "legacy relink");
    const link = (await env.DB.prepare(
      "SELECT authorization_started_at,linked_at,verified_at FROM slack_user_links",
    ).first<{ authorization_started_at: number; linked_at: number; verified_at: number | null }>())!;
    const continuous = ["legacy relink", "legacy verification", "verified relink"].includes(mode);
    expect(link.authorization_started_at).toBe(continuous ? 1 : link.linked_at);
    expect(link.linked_at).toBeGreaterThan(1);
    expect(link.verified_at === null).toBe(mode === "legacy relink");
    const authorize = slackAccessAuthorization(
      configured(),
      { id: "installation", generation: mode === "installation reconnect" ? 1 : 0 },
      { userId: user },
      2,
    );
    const denial = await authorize().then(
      () => null,
      (error: { code: string }) => error.code,
    );
    expect(denial).toBe(continuous ? null : "slack_identity_required");
  });

  it("backfills known grant starts when upgrading from 0071", async () => {
    await reset();
    const migrations = env.TEST_MIGRATIONS!;
    await applyD1Migrations(
      env.DB,
      migrations.filter((migration) => migration.name < "0072"),
    );
    const user = "migration-owner";
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO user(id,name,email,createdAt,updatedAt) VALUES(?,'Owner','migration-owner@example.test',1,1)",
      ).bind(user),
      env.DB.prepare("INSERT INTO workspaces(id,name,created_at) VALUES('migration-workspace','Migration',1)"),
      env.DB.prepare(
        "INSERT INTO slack_installations(id,workspace_id,team_id,team_name,bot_user_id,bot_token_ciphertext,installed_by,created_at,updated_at) VALUES('installation','migration-workspace','T123','Slack','UBOT','unused',?,1,1)",
      ).bind(user),
      env.DB.prepare(
        "INSERT INTO slack_user_links(installation_id,user_id,slack_user_id,linked_at,security_generation) VALUES('installation',?,'UOWNER',10,0)",
      ).bind(user),
      env.DB.prepare(
        "INSERT INTO account(id,accountId,providerId,userId,createdAt,updatedAt) VALUES('migration-account','T123:UOWNER','slack',?,1,1)",
      ).bind(user),
    ]);
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO user(id,name,email,createdAt,updatedAt) VALUES('migration-verified','Verified','migration-verified@example.test',1,1)",
      ),
      env.DB.prepare(
        "INSERT INTO account(id,accountId,providerId,userId,createdAt,updatedAt) VALUES('verified-migration-account','T123:UVERIFIED','slack','migration-verified',1,1)",
      ),
      env.DB
        .prepare(`INSERT INTO slack_user_links(installation_id,user_id,slack_user_id,linked_at,security_generation,verified_at,better_auth_account_id,migration_state,verification_method)
        VALUES('installation','migration-verified','UVERIFIED',10,0,20,'verified-migration-account','verified','slack_openid')`),
    ]);
    await applyD1Migrations(
      env.DB,
      migrations.filter((migration) => migration.name.startsWith("0072")),
    );
    expect(
      await env.DB.prepare(
        "SELECT authorization_started_at FROM slack_user_links WHERE user_id='migration-verified'",
      ).first(),
    ).toEqual({ authorization_started_at: 20 });
    expect(
      await env.DB.prepare("SELECT authorization_started_at FROM slack_user_links WHERE user_id=?").bind(user).first(),
    ).toEqual({ authorization_started_at: 10 });
    await env.DB.prepare(
      "UPDATE slack_user_links SET verified_at=20,migration_state='verified',verification_method='slack_openid',better_auth_account_id='migration-account',authorization_started_at=NULL WHERE user_id=?",
    )
      .bind(user)
      .run();
    await expect(
      slackAccessAuthorization(configured(), { id: "installation", generation: 0 }, { userId: user }, 30)(),
    ).rejects.toMatchObject({ code: "slack_identity_required" });
    await env.DB.prepare(
      "INSERT INTO workspace_members(workspace_id,user_id,role,created_at) VALUES('migration-workspace',?,'editor',1)",
    )
      .bind(user)
      .run();
    await applyD1Migrations(
      env.DB,
      migrations.filter((migration) => migration.name.startsWith("0073")),
    );
    expect(
      await env.DB.prepare("SELECT 1 FROM slack_user_links WHERE user_id='migration-verified'").first(),
    ).toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM slack_user_links WHERE user_id=?").bind(user).first()).not.toBeNull();
    await env.DB.prepare("DELETE FROM workspace_members WHERE user_id=?").bind(user).run();
    expect(await env.DB.prepare("SELECT 1 FROM slack_user_links WHERE user_id=?").bind(user).first()).toBeNull();
  });

  it.each([false, true])("redirects a completion race with an existing account %s", async (relink) => {
    const { cookie } = await account();
    if (relink) await callback(await start(cookie));
    const oldAccounts = (await env.DB.prepare("SELECT id FROM account WHERE providerId='slack'").all()).results;
    const oldSessions = (await env.DB.prepare("SELECT id FROM session ORDER BY id").all()).results;
    const flow = await start(cookie, { errorCallbackURL: "/?view=settings&slackAuth=callback&keep=1" });
    const database = beforeAuthWrite("INSERT INTO slack_user_links", async () => {
      await env.DB.prepare("UPDATE slack_installations SET generation=generation+1").run();
    });
    const result = await callback(flow, database);
    expect(result.status).toBe(302);
    const location = new URL(result.headers.get("location")!, "http://example.test");
    expect(location.searchParams.get("error")).toBe("slack_link_changed");
    expect(location.searchParams.get("view")).toBe("settings");
    expect(location.searchParams.get("keep")).toBe("1");
    expect((await env.DB.prepare("SELECT id FROM account WHERE providerId='slack'").all()).results).toEqual(
      oldAccounts,
    );
    expect((await env.DB.prepare("SELECT id FROM session ORDER BY id").all()).results).toEqual(oldSessions);
    expect(await env.DB.prepare("SELECT 1 FROM slack_primary_factor_proofs").first()).toBeNull();
  });

  it.each(["verified link", "primary proof"])(
    "preserves an account adopted into a %s when a concurrent link loses its fence",
    async (adoption) => {
      const { cookie, user } = await account();
      const losingFlow = await start(cookie);
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const database = beforeAuthWrite("INSERT INTO slack_user_links", async () => {
        entered();
        await gate;
      });
      const losingCallback = callback(losingFlow, database);
      await ready;
      let successful!: Response;
      try {
        successful = await callback(
          await start(
            adoption === "verified link" ? cookie : "",
            {},
            adoption === "verified link" ? "/link-social" : "/sign-in/social",
          ),
        );
        if (adoption === "primary proof")
          await env.DB.prepare("UPDATE slack_installations SET generation=generation+1").run();
      } finally {
        release();
      }
      const losing = await losingCallback;
      expect(successful.status).toBe(302);
      expect(new URL(successful.headers.get("location")!, "http://example.test").searchParams.get("slack")).toBe(
        "verified",
      );
      expect(losing.status).toBe(302);
      expect(new URL(losing.headers.get("location")!, "http://example.test").searchParams.get("error")).toBe(
        "slack_link_changed",
      );
      expect(await env.DB.prepare("SELECT user_id,migration_state FROM slack_user_links").first()).toEqual(
        adoption === "verified link" ? { user_id: user, migration_state: "verified" } : null,
      );
      expect(await env.DB.prepare("SELECT userId FROM account WHERE providerId='slack'").first()).toEqual({
        userId: user,
      });
      const signIn = await callback(await start("", {}, "/sign-in/social"));
      expect(signIn.status).toBe(302);
      expect(new URL(signIn.headers.get("location")!, "http://example.test").searchParams.get("error")).toBeNull();
      expect(await env.DB.prepare("SELECT user_id FROM slack_primary_factor_proofs").first()).toEqual({
        user_id: user,
      });
    },
  );

  it("preserves the library's conflicting-account error redirect", async () => {
    const { cookie } = await account();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO user(id,name,email,createdAt,updatedAt) VALUES('other','Other','other@example.test',1,1)",
      ),
      env.DB.prepare(
        "INSERT INTO account(id,accountId,providerId,userId,createdAt,updatedAt) VALUES('other-slack','T123:UOWNER','slack','other',1,1)",
      ),
    ]);
    const result = await callback(await start(cookie));
    expect(result.status).toBe(302);
    expect(new URL(result.headers.get("location")!, "http://example.test").searchParams.get("error")).toBe(
      "account_already_linked_to_different_user",
    );
    expect(await env.DB.prepare("SELECT 1 FROM slack_user_links").first()).toBeNull();
    expect(await env.DB.prepare("SELECT userId FROM account WHERE id='other-slack'").first()).toEqual({
      userId: "other",
    });
  });

  it.each(["disconnect", "reconnect"])("removes only the new sign-in session after installation %s", async (mode) => {
    const { cookie } = await account();
    await callback(await start(cookie));
    const oldSessions = (await env.DB.prepare("SELECT id FROM session ORDER BY id").all()).results;
    const accounts = (await env.DB.prepare("SELECT id FROM account ORDER BY id").all()).results;
    const flow = await start("", {}, "/sign-in/social");
    const database = beforeAuthWrite("INSERT INTO slack_primary_factor_proofs", async () => {
      await env.DB.prepare(
        mode === "disconnect"
          ? "UPDATE slack_installations SET disconnected_at=1,generation=generation+1"
          : "UPDATE slack_installations SET generation=generation+1",
      ).run();
    });
    const result = await callback(flow, database);
    expect(result.status).toBe(302);
    expect(new URL(result.headers.get("location")!, "http://example.test").searchParams.get("error")).toBe(
      "slack_identity_invalid",
    );
    expect((await env.DB.prepare("SELECT id FROM session ORDER BY id").all()).results).toEqual(oldSessions);
    expect((await env.DB.prepare("SELECT id FROM account ORDER BY id").all()).results).toEqual(accounts);
    expect(await env.DB.prepare("SELECT 1 FROM slack_primary_factor_proofs").first()).toBeNull();
  });

  it.each([false, true])(
    "rejects authorization lost during identity validation with existing link %s",
    async (relink) => {
      const { cookie, user, workspace } = await account();
      if (relink) await callback(await start(cookie));
      await env.DB.prepare(`INSERT INTO invites(id,workspace_id,token_hash,role,expires_at,created_by,created_at,claimed_email,claim_token,claim_expires_at)
      VALUES('unrelated',?,'unrelated-token','editor',?, ?,1,'invitee@example.test','reservation',?)`)
        .bind(workspace, Date.now() + 60_000, user, Date.now() + 60_000)
        .run();
      const invite = await env.DB.prepare("SELECT * FROM invites WHERE id='unrelated'").first();
      const links = await env.DB.prepare("SELECT * FROM slack_user_links").all();
      const accounts = await env.DB.prepare("SELECT * FROM account WHERE providerId='slack'").all();
      const flow = await start(cookie);
      const remote = vi.mocked(fetch).getMockImplementation()!;
      vi.mocked(fetch).mockImplementation(async (input, init) => {
        if (String(input).includes("users.info"))
          await env.DB.prepare("UPDATE session_security SET verified_at=?")
            .bind(Date.now() - 6 * 60_000)
            .run();
        return remote(input, init);
      });
      expect((await callback(flow)).headers.get("location")).toContain("error=SECURITY_REQUIRED");
      expect((await env.DB.prepare("SELECT * FROM slack_user_links").all()).results).toEqual(links.results);
      expect((await env.DB.prepare("SELECT * FROM account WHERE providerId='slack'").all()).results).toEqual(
        accounts.results,
      );
      expect(await env.DB.prepare("SELECT 1 FROM slack_primary_factor_proofs").first()).toBeNull();
      expect(await env.DB.prepare("SELECT * FROM invites WHERE id='unrelated'").first()).toEqual(invite);
    },
  );

  it.each(["totp", "passkey", "trust"])("disconnects using an older unexpired %s proof", async (method) => {
    const { cookie, user, workspace } = await account();
    await callback(await start(cookie));
    const session = (await env.DB.prepare("SELECT id FROM session WHERE userId=?").bind(user).first<{ id: string }>())!;
    const oauth = (await env.DB.prepare("SELECT id FROM account WHERE providerId='slack'").first<{ id: string }>())!;
    const now = Date.now();
    if (method === "trust")
      await env.DB.prepare(`INSERT INTO trusted_browsers(id,token_hash,user_id,generation,created_at,expires_at,name)
        VALUES('trusted','trusted-token',?,0,?,?,'Test browser')`)
        .bind(user, now, now + 60_000)
        .run();
    await env.DB.prepare(
      "UPDATE session_security SET method=?,verified_at=?,expires_at=?,trust_id=? WHERE session_id=?",
    )
      .bind(method, now - 6 * 60_000, now + 60_000, method === "trust" ? "trusted" : null, session.id)
      .run();
    await env.DB.prepare(`INSERT INTO slack_primary_factor_proofs(session_id,user_id,account_id,team_id,slack_user_id,verified_at,expires_at,security_generation,authentication_source)
      VALUES(?,?,?,'T123','UOWNER',?,?,0,'sign_in')`)
      .bind(session.id, user, oauth.id, now, now + 60_000)
      .run();
    const context = createExecutionContext();
    const response = await worker.fetch(
      new Request("http://example.test/api/slack/identity", {
        method: "DELETE",
        headers: { cookie, origin: "http://example.test" },
      }),
      configured(),
      context,
    );
    await waitOnExecutionContext(context);
    expect(response.status).toBe(200);
    expect(await env.DB.prepare("SELECT 1 FROM slack_user_links").first()).toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM slack_primary_factor_proofs").first()).toBeNull();
    expect(await env.DB.prepare("SELECT id FROM account WHERE providerId='slack'").first()).toEqual(oauth);
    await expect(disconnectSlackIdentity(configured(), user, session.id, workspace)).resolves.toBe(0);
  });

  it.each([
    "expired session",
    "revoked session",
    "expired proof",
    "revoked trust",
    "expired trust",
    "wrong trust owner",
    "wrong trust generation",
    "unprotected account",
  ])("rejects disconnect with %s", async (mode) => {
    const { cookie, user, workspace } = await account();
    await callback(await start(cookie));
    const session = (await env.DB.prepare("SELECT id FROM session WHERE userId=?").bind(user).first<{ id: string }>())!;
    if (mode === "expired session")
      await env.DB.prepare("UPDATE session SET expiresAt=?").bind(new Date(0).toISOString()).run();
    if (mode === "revoked session") await env.DB.prepare("DELETE FROM session").run();
    if (mode === "expired proof") await env.DB.prepare("UPDATE session_security SET expires_at=0").run();
    if (mode === "unprotected account") await env.DB.prepare("UPDATE account_security SET codes_saved=0").run();
    if (mode.includes("trust")) {
      await env.DB.prepare("UPDATE session_security SET method='trust',trust_id='trusted'").run();
      if (mode !== "revoked trust") {
        if (mode === "wrong trust owner")
          await env.DB.prepare(`INSERT INTO user(id,name,email,createdAt,updatedAt)
            VALUES('other-user','Other user','other-user@example.test',1,1)`).run();
        await env.DB.prepare(`INSERT INTO trusted_browsers(id,token_hash,user_id,generation,created_at,expires_at,name)
            VALUES('trusted','trusted-token',?,?,1,?,'Test browser')`)
          .bind(
            mode === "wrong trust owner" ? "other-user" : user,
            mode === "wrong trust generation" ? 1 : 0,
            mode === "expired trust" ? 0 : Date.now() + 60_000,
          )
          .run();
      }
    }
    await expect(disconnectSlackIdentity(configured(), user, session.id, workspace)).rejects.toMatchObject({
      status: 403,
      code: "SECURITY_REQUIRED",
    });
    expect(await env.DB.prepare("SELECT 1 FROM slack_user_links").first()).not.toBeNull();
  });

  it("disconnects links only in the requested workspace", async () => {
    const { cookie, user, workspace } = await account();
    await callback(await start(cookie));
    const session = (await env.DB.prepare("SELECT id FROM session WHERE userId=?").bind(user).first<{ id: string }>())!;
    await env.DB.batch([
      env.DB.prepare("INSERT INTO workspaces(id,name,created_at) VALUES('other-workspace','Other workspace',1)"),
      env.DB.prepare(
        "INSERT INTO workspace_members(workspace_id,user_id,role,created_at) VALUES('other-workspace',?,'owner',1)",
      ).bind(user),
      env.DB.prepare(`INSERT INTO slack_installations(id,workspace_id,team_id,team_name,bot_user_id,bot_token_ciphertext,scopes,installed_by,created_at,updated_at)
        VALUES('other-installation','other-workspace','TOTHER','Other Slack','UBOT','unused','users:read',?,1,1)`).bind(
        user,
      ),
      env.DB.prepare(`INSERT INTO slack_user_links(installation_id,user_id,slack_user_id,linked_at,security_generation)
        VALUES('other-installation',?,'UOTHER',1,0)`).bind(user),
    ]);
    await expect(disconnectSlackIdentity(configured(), user, session.id, workspace)).resolves.toBe(1);
    expect(
      (await env.DB.prepare("SELECT installation_id FROM slack_user_links WHERE user_id=?").bind(user).all()).results,
    ).toEqual([{ installation_id: "other-installation" }]);
  });

  it.each(["session revoked", "generation changed"])("reports a guarded disconnect no-op after %s", async (mode) => {
    const { cookie, user, workspace } = await account();
    await callback(await start(cookie));
    const session = (await env.DB.prepare("SELECT id FROM session WHERE userId=?").bind(user).first<{ id: string }>())!;
    const link = env.DB.prepare(
      "SELECT * FROM slack_user_links WHERE installation_id='installation' AND user_id=?",
    ).bind(user);
    let expectedLink = await link.first();
    expect(expectedLink).not.toBeNull();
    const db = new Proxy(env.DB, {
      get(target, property) {
        if (property === "batch")
          return async (statements: D1PreparedStatement[]) => {
            if (mode === "session revoked")
              await env.DB.prepare("DELETE FROM session WHERE id=?").bind(session.id).run();
            else {
              await env.DB.prepare("UPDATE account_security SET generation=generation+1 WHERE user_id=?")
                .bind(user)
                .run();
              // The generation-revocation trigger removes the original link before reconnection.
              expect(await link.first()).toBeNull();
              // A newly connected link must survive the stale revocation request.
              await env.DB.prepare(`INSERT INTO slack_user_links(installation_id,user_id,slack_user_id,linked_at,security_generation)
              VALUES('installation',?,'UNEWER',?,1)`)
                .bind(user, Date.now())
                .run();
              expectedLink = await link.first();
              expect(expectedLink).not.toBeNull();
            }
            return target.batch(statements);
          };
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(
      disconnectSlackIdentity({ ...configured(), DB: db }, user, session.id, workspace),
    ).rejects.toMatchObject({ status: 409, code: "slack_link_changed" });
    expect(await link.first()).toEqual(expectedLink);
  });

  it("completes linking and relinking without creating a primary proof or changing assurance", async () => {
    const { cookie, user } = await account();
    const assurance = await env.DB.prepare("SELECT * FROM session_security").first();
    const flow = await start(cookie);
    const result = await callback(flow);
    expect(result.status).toBe(302);
    expect(result.headers.get("location")).toContain("slack=verified");
    expect(
      await env.DB.prepare("SELECT slack_user_id,security_generation FROM slack_authorized_user_links").first(),
    ).toEqual({ slack_user_id: "UOWNER", security_generation: 0 });
    expect(await env.DB.prepare("SELECT 1 FROM slack_primary_factor_proofs").first()).toBeNull();
    expect(await env.DB.prepare("SELECT * FROM session_security").first()).toEqual(assurance);
    const relink = await callback(await start(cookie));
    expect(relink.status).toBe(302);
    expect(relink.headers.get("location")).toContain("slack=verified");
    expect(
      await env.DB.prepare("SELECT count(*) count FROM account WHERE userId=? AND providerId='slack'")
        .bind(user)
        .first(),
    ).toEqual({ count: 1 });
    expect((await callback(flow)).headers.get("location")).not.toContain("slack=verified");
  });
  it.each(["unenrolled", "stale proof", "trusted proof", "unsaved codes"])("rejects %s linking", async (mode) => {
    const { cookie } = await account(mode !== "unenrolled");
    if (mode === "stale proof")
      await env.DB.prepare("UPDATE session_security SET verified_at=?")
        .bind(Date.now() - 6 * 60000)
        .run();
    if (mode === "trusted proof") await env.DB.prepare("UPDATE session_security SET method='trust'").run();
    if (mode === "unsaved codes") await env.DB.prepare("UPDATE account_security SET codes_saved=0").run();
    const result = await auth(cookie, "/link-social", { provider: "slack" });
    expect(result.status).toBe(403);
    expect(await env.DB.prepare("SELECT 1 FROM account WHERE providerId='slack'").first()).toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM slack_primary_factor_proofs").first()).toBeNull();
  });
  it.each(["idToken", "scopes", "additionalParams"])(
    "rejects the alternate %s linking path before account writes",
    async (field) => {
      const { cookie } = await account();
      const value =
        field === "idToken" ? { token: await token() } : field === "scopes" ? ["admin"] : { team: "TOTHER" };
      const result = await auth(cookie, "/link-social", { provider: "slack", [field]: value });
      expect(result.status).toBe(400);
      expect(await env.DB.prepare("SELECT 1 FROM account WHERE providerId='slack'").first()).toBeNull();
    },
  );
  it.each(["session revoked", "security reset", "proof expires", "binding replaced"])(
    "rejects completion after %s",
    async (mode) => {
      const { cookie, user } = await account();
      const flow = await start(cookie);
      if (mode === "session revoked") await env.DB.prepare("DELETE FROM session").run();
      if (mode === "security reset") await env.DB.prepare("UPDATE account_security SET generation=generation+1").run();
      if (mode === "proof expires")
        await env.DB.prepare("UPDATE session_security SET verified_at=?")
          .bind(Date.now() - 6 * 60000)
          .run();
      if (mode === "binding replaced")
        await env.DB.prepare(
          "INSERT INTO slack_user_links(installation_id,user_id,slack_user_id,linked_at,security_generation) VALUES('installation',?,'UNEWER',1,0)",
        )
          .bind(user)
          .run();
      const result = await callback(flow);
      expect(result.headers.get("location") ?? "").not.toContain("slack=verified");
      expect(await env.DB.prepare("SELECT 1 FROM account WHERE providerId='slack'").first()).toBeNull();
      expect(await env.DB.prepare("SELECT 1 FROM slack_primary_factor_proofs").first()).toBeNull();
    },
  );
  it.each(["wrong team", "guest", "bot", "removed"])("rejects a %s identity at callback", async (mode) => {
    const { cookie } = await account();
    const flow = await start(cookie);
    if (mode === "wrong team") team = "TOTHER";
    if (mode === "guest") userFlags = { is_restricted: true };
    if (mode === "bot") userFlags = { is_bot: true };
    if (mode === "removed") userFlags = { deleted: true };
    const result = await callback(flow);
    expect(result.headers.get("location") ?? "").not.toContain("slack=verified");
    expect(await env.DB.prepare("SELECT 1 FROM account WHERE providerId='slack'").first()).toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM slack_user_links").first()).toBeNull();
  });
  it("keeps primary Slack sign-in after access revocation and does not recreate the binding", async () => {
    const { cookie } = await account();
    expect((await callback(await start(cookie))).headers.get("location")).toContain("slack=verified");
    const context = createExecutionContext();
    const disconnected = await worker.fetch(
      new Request("http://example.test/api/slack/identity", {
        method: "DELETE",
        headers: { cookie, origin: "http://example.test" },
      }),
      configured(),
      context,
    );
    await waitOnExecutionContext(context);
    expect(disconnected.status).toBe(200);
    expect(await env.DB.prepare("SELECT 1 FROM slack_user_links").first()).toBeNull();
    const result = await callback(await start("", {}, "/sign-in/social"));
    expect(result.status).toBe(302);
    expect(result.headers.get("location")).toContain("slack=verified");
    expect(await env.DB.prepare("SELECT authentication_source FROM slack_primary_factor_proofs").first()).toEqual({
      authentication_source: "sign_in",
    });
    expect(await env.DB.prepare("SELECT 1 FROM slack_user_links").first()).toBeNull();
    expect((await securityRequest(responseCookies(result), "/api/me")).status).toBe(401);
  });
  it("requires the original session even when another session has fresh protection", async () => {
    const { cookie, user } = await account();
    const flow = await start(cookie);
    const live = (await env.DB.prepare("SELECT * FROM session WHERE userId=? LIMIT 1")
      .bind(user)
      .first<{ id: string; token: string }>())!;
    await env.DB.batch([
      env.DB.prepare("DELETE FROM session WHERE id=?").bind(live.id),
      env.DB.prepare(
        "INSERT INTO session(id,userId,token,expiresAt,createdAt,updatedAt) VALUES('replacement-session',?,?,'2099-01-01T00:00:00.000Z',1,1)",
      ).bind(user, live.token),
      env.DB.prepare(
        "INSERT INTO session_security(session_id,user_id,generation,method,verified_at,expires_at) VALUES('replacement-session',?,0,'totp',?,?)",
      ).bind(user, Date.now(), Date.now() + 600000),
    ]);
    const result = await callback(flow);
    expect(result.headers.get("location") ?? "").not.toContain("slack=verified");
    expect(await env.DB.prepare("SELECT 1 FROM account WHERE providerId='slack'").first()).toBeNull();
  });
  it("rejects a reset while Slack membership is being checked", async () => {
    const { cookie } = await account();
    const flow = await start(cookie);
    const remote = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const response = await remote(input, init);
      if (String(input).includes("users.info"))
        await env.DB.prepare("UPDATE account_security SET generation=generation+1").run();
      return response;
    });
    expect((await callback(flow)).headers.get("location") ?? "").not.toContain("slack=verified");
    expect(await env.DB.prepare("SELECT 1 FROM account WHERE providerId='slack'").first()).toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM slack_primary_factor_proofs").first()).toBeNull();
  });
  it("revokes Slack access and proofs during recovery while preserving primary login", async () => {
    const { cookie } = await account();
    await callback(await start(cookie));
    const codesResponse = await securityRequest(cookie, "/api/security/recovery-codes", {});
    const { codes, receipt } = await codesResponse.json<{ codes: string[]; receipt: string }>();
    await securityRequest(cookie, "/api/security/acknowledge-codes", { receipt });
    const recovered = await securityRequest(cookie, "/api/security/recover", {
      password: "password123",
      code: codes[0],
    });
    expect(recovered.status).toBe(200);
    expect(await env.DB.prepare("SELECT 1 FROM slack_user_links").first()).toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM slack_primary_factor_proofs").first()).toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM account WHERE providerId='slack'").first()).not.toBeNull();
    const signin = await callback(await start("", {}, "/sign-in/social"));
    expect(signin.status).toBe(302);
    expect(await env.DB.prepare("SELECT 1 FROM slack_user_links").first()).toBeNull();
    expect(
      await env.DB.prepare("SELECT security_generation,authentication_source FROM slack_primary_factor_proofs").first(),
    ).toEqual({ security_generation: 1, authentication_source: "sign_in" });
  });
  it("allows invited Slack signup to enroll protection without creating a private access grant", async () => {
    const { cookie } = await account();
    const invitation = await securityRequest(cookie, "/api/invites", { role: "editor" });
    const { invite } = await invitation.json<{ invite: { token: string } }>();
    const context = createExecutionContext();
    const response = await worker.fetch(
      new Request("http://example.test/api/slack/identity/invite/start", {
        method: "POST",
        headers: { origin: "http://example.test", "content-type": "application/json" },
        body: JSON.stringify({ token: invite.token }),
      }),
      configured(),
      context,
    );
    await waitOnExecutionContext(context);
    expect(response.status).toBe(200);
    const url = new URL((await response.json<{ url: string }>()).url);
    nonce = url.searchParams.get("nonce");
    slackUser = "UINVITED";
    const result = await callback({ state: url.searchParams.get("state")!, cookie: responseCookies(response) });
    expect(result.status).toBe(302);
    expect(await env.DB.prepare("SELECT authentication_source FROM slack_primary_factor_proofs").first()).toEqual({
      authentication_source: "sign_up",
    });
    expect(await env.DB.prepare("SELECT 1 FROM slack_user_links").first()).toBeNull();
    const setup = await securityRequest(responseCookies(result), "/api/security/setup-totp", {});
    expect(setup.status).toBe(200);
  });
});
