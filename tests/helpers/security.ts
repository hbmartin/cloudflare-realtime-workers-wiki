/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { SELF } from "cloudflare:test";
import { createOTP } from "@better-auth/utils/otp";
import { base32 } from "@better-auth/utils/base32";
import { splitSetCookieHeader } from "better-auth/cookies";

export function responseCookies(response: Response, previous = "") {
  const jar = new Map(
    previous
      .split(";")
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        return [part.slice(0, index).trim(), part.slice(index + 1)];
      }),
  );
  for (const cookie of splitSetCookieHeader(response.headers.get("set-cookie") ?? "")) {
    const part = cookie.split(";", 1)[0]!;
    const index = part.indexOf("=");
    if (part.slice(index + 1)) jar.set(part.slice(0, index), part.slice(index + 1));
    else jar.delete(part.slice(0, index));
  }
  return [...jar].map(([key, value]) => `${key}=${value}`).join("; ");
}

export function securityRequest(cookie: string, path: string, body?: object) {
  return SELF.fetch(`http://example.test${path}`, {
    method: body ? "POST" : "GET",
    headers: { cookie, origin: "http://example.test", "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

export function otpFromUri(uri: string, offset = 0) {
  const secret = new TextDecoder().decode(base32.decode(new URL(uri).searchParams.get("secret")!));
  return createOTP(secret).hotp(Math.floor(Date.now() / 30_000) + offset);
}

export async function enrollAccount(response: Response, inviteToken?: string) {
  let cookie = responseCookies(response);
  const setup = await securityRequest(cookie, "/api/security/setup-totp", { password: "password123" });
  if (!setup.ok) throw new Error(`Setup failed: ${await setup.text()}`);
  const { totpURI } = await setup.json<{ totpURI: string }>();
  const verified = await securityRequest(cookie, "/api/security/confirm-totp", { code: await otpFromUri(totpURI) });
  if (!verified.ok) throw new Error(`Confirmation failed: ${await verified.text()}`);
  cookie = responseCookies(verified, cookie);
  const codes = await securityRequest(cookie, "/api/security/recovery-codes", {});
  if (!codes.ok) throw new Error(`Recovery setup failed: ${await codes.text()}`);
  const { receipt } = await codes.json<{ receipt: string }>();
  const acknowledged = await securityRequest(cookie, "/api/security/acknowledge-codes", { receipt });
  if (!acknowledged.ok) throw new Error(`Acknowledgment failed: ${await acknowledged.text()}`);
  if (inviteToken) {
    const complete = await securityRequest(cookie, "/api/invites/complete", { token: inviteToken });
    if (!complete.ok) throw new Error(`Invite completion failed: ${await complete.text()}`);
  }
  return cookie;
}
