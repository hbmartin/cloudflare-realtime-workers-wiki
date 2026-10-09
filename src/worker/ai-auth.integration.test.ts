import { applyD1Migrations, createExecutionContext, env, reset, SELF, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPair, exportJWK, SignJWT, type CryptoKey } from "jose";
import { enrollAccount, responseCookies } from "../../tests/helpers/security";
import type { Env, MemberContext } from "./env";
import { requireMember } from "./auth";
import {
  chatgptAccessToken,
  chatgptConfigured,
  finishChatgptConnection,
  seal,
  startChatgptConnection,
  unseal,
} from "./ai-auth";
import worker from "./index";
/* oxlint-disable vitest/no-standalone-expect -- Fixture setup validates the mocked OAuth wire contract for every test. */

let member: MemberContext, cookie: string, nonce: string, browser: string, state: string;
let privateKey: CryptoKey, publicJwk: JsonWebKey;
let tokenCalls: number,
  refreshCalls: number,
  scope: string,
  tokenNonce: string | null,
  issuer: string,
  audience: string,
  expires: number;
const scopes = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const configured = () =>
  ({
    ...env,
    CHATGPT_CONNECTION_ENABLED: "true",
    CHATGPT_CLIENT_ID: "oaiapp_hosted_test",
    CHATGPT_TOKEN_AUTH_METHOD: "none",
    CHATGPT_SCOPES: scopes,
    AI_TOKEN_ENCRYPTION_KEY: "separate-chatgpt-encryption-test-key",
  }) as Env;
function req(path: string, method = "GET", body?: unknown) {
  return new Request(`http://example.test${path}`, {
    method,
    headers: { cookie, origin: "http://example.test", "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
beforeAll(async () => {
  const keys = await generateKeyPair("RS256");
  privateKey = keys.privateKey;
  publicJwk = await exportJWK(keys.publicKey);
});
beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
  const response = await SELF.fetch("http://example.test/api/install/bootstrap", {
    method: "POST",
    headers: { origin: "http://example.test", "content-type": "application/json" },
    body: JSON.stringify({
      bootstrapToken: "worker-bootstrap-token",
      workspaceName: "Hosted connection",
      name: "Owner",
      email: "owner@example.test",
      password: "password123",
    }),
  });
  cookie = await enrollAccount(response);
  member = await requireMember(req("/api/me"), env);
  tokenCalls = 0;
  refreshCalls = 0;
  scope = scopes;
  tokenNonce = null;
  issuer = "https://auth.openai.com";
  audience = "oaiapp_hosted_test";
  expires = 600;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (resource: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(resource instanceof Request ? resource.url : String(resource));
      if (url.pathname.endsWith("openid-configuration"))
        return Response.json({
          issuer: "https://auth.openai.com",
          authorization_endpoint: "https://auth.openai.com/api/accounts/authorize",
          token_endpoint: "https://auth.openai.com/api/accounts/oauth/token",
          jwks_uri: "https://auth.openai.com/.well-known/jwks.json",
        });
      if (url.pathname.endsWith("jwks.json"))
        return Response.json({ keys: [{ ...publicJwk, kid: "hosted-key", alg: "RS256", use: "sig" }] });
      if (!url.pathname.endsWith("oauth/token")) throw new Error("Unexpected external request.");
      tokenCalls++;
      const params = new URLSearchParams(String(init?.body));
      if (params.get("grant_type") === "refresh_token") {
        refreshCalls++;
        expect(params.get("refresh_token")).toBe("private-refresh");
        return Response.json({
          access_token: "rotated-access",
          refresh_token: "rotated-refresh",
          token_type: "Bearer",
          expires_in: 3600,
          scope,
        });
      }
      expect(params.get("client_id")).toBe("oaiapp_hosted_test");
      expect(params.get("code_verifier")?.length).toBeGreaterThanOrEqual(43);
      const id_token = await new SignJWT({ nonce: tokenNonce ?? nonce, email: "chatgpt@example.test" })
        .setProtectedHeader({ alg: "RS256", kid: "hosted-key" })
        .setIssuer(issuer)
        .setAudience(audience)
        .setSubject("chatgpt-member")
        .setIssuedAt()
        .setExpirationTime(Math.floor(Date.now() / 1000) + expires)
        .sign(privateKey);
      return Response.json({
        access_token: "private-access",
        refresh_token: "private-refresh",
        token_type: "Bearer",
        expires_in: 3600,
        scope,
        id_token,
      });
    }),
  );
  const started = await startChatgptConnection(configured(), member);
  const url = new URL(started.url);
  nonce = url.searchParams.get("nonce")!;
  state = url.searchParams.get("state")!;
  browser = started.browser;
  expect(url.origin).toBe("https://auth.openai.com");
  expect(url.searchParams.get("redirect_uri")).toBe("http://example.test/api/ai/chatgpt/callback");
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  expect(url.searchParams.get("resource")).toBe("https://api.openai.com/v1");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe("hosted ChatGPT plan connection", () => {
  it("gates the hosted contract and refuses the local dynamic client", () => {
    expect(chatgptConfigured(configured())).toBe(true);
    expect(chatgptConfigured({ ...configured(), CHATGPT_CLIENT_ID: "dynamic_agent_client" })).toBe(false);
    expect(chatgptConfigured({ ...configured(), CHATGPT_CONNECTION_ENABLED: "false" })).toBe(false);
    expect(chatgptConfigured({ ...configured(), CHATGPT_SCOPES: "openid profile email" })).toBe(false);
  });
  it("binds PKCE state to member, session, and browser, validates signed identity, and encrypts credentials", async () => {
    await expect(
      finishChatgptConnection(
        configured(),
        { ...member, session: { ...member.session, id: "different-session" } },
        state,
        "code",
        browser,
      ),
    ).rejects.toMatchObject({ code: "invalid_oauth_state" });
    await expect(finishChatgptConnection(configured(), member, state, "code", "wrong-browser")).rejects.toMatchObject({
      code: "invalid_oauth_state",
    });
    expect(tokenCalls).toBe(0);
    await finishChatgptConnection(configured(), member, state, "code", browser);
    expect(await chatgptAccessToken(configured(), member)).toBe("private-access");
    const record = await env.DB.prepare("SELECT * FROM ai_connections").first<{
      tokens_ciphertext: string;
      subject: string;
    }>();
    expect(record?.subject).toBe("chatgpt-member");
    expect(JSON.stringify(record)).not.toContain("private-access");
    expect(JSON.stringify(record)).not.toContain("private-refresh");
    await expect(finishChatgptConnection(configured(), member, state, "code", browser)).rejects.toMatchObject({
      code: "invalid_oauth_state",
    });
    await expect(startChatgptConnection(configured(), member)).rejects.toMatchObject({ code: "already_connected" });
    const context = createExecutionContext(),
      response = await worker.fetch(req("/api/ai/status"), configured(), context);
    await waitOnExecutionContext(context);
    const status = await response.json();
    expect(status).toMatchObject({ connected: true, accountLabel: "chatgpt@example.test" });
    expect(JSON.stringify(status)).not.toMatch(/private-access|private-refresh|id_token/);
  });
  it.each(["nonce", "issuer", "audience", "expiry", "scope"])(
    "rejects invalid %s before saving a connection",
    async (invalid) => {
      if (invalid === "nonce") tokenNonce = "forged-nonce";
      if (invalid === "issuer") issuer = "https://attacker.example";
      if (invalid === "audience") audience = "other-client";
      if (invalid === "expiry") expires = -600;
      if (invalid === "scope") scope = "openid profile email";
      await expect(finishChatgptConnection(configured(), member, state, "code", browser)).rejects.toMatchObject({
        code: invalid === "scope" ? "chatgpt_plan_scope_missing" : "invalid_chatgpt_identity",
      });
      expect(await env.DB.prepare("SELECT * FROM ai_connections").first()).toBeNull();
    },
  );
  it("serializes refresh across requests and atomically preserves one rotating credential", async () => {
    await finishChatgptConnection(configured(), member, state, "code", browser);
    await env.DB.prepare("UPDATE ai_connections SET expires_at=1").run();
    const tokens = await Promise.all([
      chatgptAccessToken(configured(), member),
      chatgptAccessToken(configured(), member),
      chatgptAccessToken(configured(), member),
    ]);
    expect(tokens).toEqual(["rotated-access", "rotated-access", "rotated-access"]);
    expect(refreshCalls).toBe(1);
    const record = await env.DB.prepare("SELECT tokens_ciphertext,refresh_lease FROM ai_connections").first<{
      tokens_ciphertext: string;
      refresh_lease: string | null;
    }>();
    expect(record?.refresh_lease).toBeNull();
    const credentials = await unseal(
      configured().AI_TOKEN_ENCRYPTION_KEY!,
      `ai-tokens:${member.workspace.id}:${member.user.id}`,
      record!.tokens_ciphertext,
    );
    expect(credentials).toMatchObject({ refresh_token: "rotated-refresh" });
  });
  it("removes pending state and stored credentials on disconnect without changing NoteFlare authentication", async () => {
    await finishChatgptConnection(configured(), member, state, "code", browser);
    const context = createExecutionContext(),
      response = await worker.fetch(req("/api/ai/chatgpt", "DELETE"), configured(), context);
    await waitOnExecutionContext(context);
    expect(response.status).toBe(200);
    expect(await env.DB.prepare("SELECT * FROM ai_connections").first()).toBeNull();
    expect((await requireMember(req("/api/me"), env)).user.id).toBe(member.user.id);
    await expect(chatgptAccessToken(configured(), member)).rejects.toMatchObject({ code: "chatgpt_reconnect" });
  });
  it("sets an HttpOnly browser binding through the existing authenticated UI route", async () => {
    const context = createExecutionContext(),
      response = await worker.fetch(req("/api/ai/chatgpt/connect", "POST"), configured(), context);
    await waitOnExecutionContext(context);
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("SameSite=Lax");
    expect(responseCookies(response, cookie)).toContain("noteflare-chatgpt=");
    const encrypted = await seal("secret", "member-one", { token: "private" });
    await expect(unseal("secret", "member-two", encrypted)).rejects.toThrow(/decrypt|operation|Operation/i);
  });
});
