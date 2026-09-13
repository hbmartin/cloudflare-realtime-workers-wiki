import { expect, test } from "@playwright/test";
import { createOTP } from "@better-auth/utils/otp";
import { base32 } from "@better-auth/utils/base32";
import { signInOwner } from "./security-helpers";

test("passkey enrollment, passwordless sign-in, replay rejection, and mandatory user verification", async ({
  page,
  browser,
}) => {
  test.setTimeout(60_000);
  await signInOwner(page);
  const invitation = await page.request.post("/api/invites", { data: { role: "viewer" } });
  const { invite } = (await invitation.json()) as { invite: { token: string } };
  const context = await browser.newContext({ extraHTTPHeaders: { origin: "http://localhost:4173" } });
  const guest = await context.newPage();
  const cdp = await context.newCDPSession(guest);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  const signupBody = {
    token: invite.token,
    name: "Passkey guest",
    email: `passkey-${Date.now()}@example.test`,
    password: "password123",
  };
  let signup = await context.request.post("http://localhost:4173/api/invites/accept", { data: signupBody });
  for (let attempt = 0; signup.status() === 429 && attempt < 3; attempt++) {
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(15, Number(signup.headers()["retry-after"]) || 10) * 1000),
    );
    signup = await context.request.post("http://localhost:4173/api/invites/accept", { data: signupBody });
  }
  expect(signup.ok()).toBe(true);
  await guest.goto(`/?invite=${invite.token}`);
  await expect(guest.getByRole("heading", { name: "Protect your account" })).toBeVisible();
  await guest.screenshot({ path: "test-results/security-enrollment.png" });
  await guest.getByRole("button", { name: "Create a passkey", exact: true }).click();
  await expect(guest.getByLabel("I saved my recovery codes")).toBeVisible();
  await guest.getByLabel("I saved my recovery codes").check();
  await guest.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(guest.getByLabel("Page title")).toBeVisible();
  await guest.getByRole("button", { name: "Sign out", exact: true }).click();
  const assertion = guest.waitForRequest((request) => request.url().endsWith("/passkey/verify-authentication"));
  await guest.getByRole("button", { name: "Sign in with a passkey" }).click();
  const captured = await assertion;
  await expect(guest.getByLabel("Page title")).toBeVisible();
  const replay = await context.request.post("/api/auth/passkey/verify-authentication", {
    data: captured.postDataJSON(),
  });
  expect(replay.ok()).toBe(false);
  const wrongAccount = await page.request.post("/api/auth/passkey/verify-authentication", {
    headers: { origin: "http://localhost:4173" },
    data: captured.postDataJSON(),
  });
  expect(wrongAccount.status()).toBe(403);
  await guest.getByRole("button", { name: "Sign out", exact: true }).click();
  for (const invalidPart of ["origin", "rpId"]) {
    await context.route("**/api/auth/passkey/verify-authentication", async (route) => {
      const body = route.request().postDataJSON();
      if (invalidPart === "origin") {
        const clientData = JSON.parse(Buffer.from(body.response.response.clientDataJSON, "base64url").toString());
        clientData.origin = "https://wrong-origin.example";
        body.response.response.clientDataJSON = Buffer.from(JSON.stringify(clientData)).toString("base64url");
      } else {
        const data = Buffer.from(body.response.response.authenticatorData, "base64url");
        data[0] = data[0]! ^ 1;
        body.response.response.authenticatorData = data.toString("base64url");
      }
      await route.continue({ postData: JSON.stringify(body) });
    });
    await guest.getByRole("button", { name: "Sign in with a passkey" }).click();
    await expect(guest.getByText("Passkey sign-in failed.", { exact: true })).toBeVisible();
    expect((await context.request.get("/api/me")).status()).toBe(401);
    await context.unroute("**/api/auth/passkey/verify-authentication");
  }
  await cdp.send("WebAuthn.setUserVerified", { authenticatorId, isUserVerified: false });
  await guest.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(guest.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
  await expect(guest.getByText("Passkey sign-in failed.", { exact: true })).toBeVisible();
  expect((await context.request.get("/api/me")).status()).toBe(401);
  await cdp.send("WebAuthn.setUserVerified", { authenticatorId, isUserVerified: true });
  await guest.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(guest.getByLabel("Page title")).toBeVisible();
  const setup = await context.request.post("/api/security/setup-totp", { data: { password: "password123" } });
  expect(setup.ok()).toBe(true);
  const { totpURI } = await setup.json();
  const secret = new TextDecoder().decode(base32.decode(new URL(totpURI).searchParams.get("secret")!));
  const confirmed = await context.request.post("/api/security/confirm-totp", {
    data: { code: await createOTP(secret).totp() },
  });
  expect(confirmed.ok()).toBe(true);
  const { passkeys } = await (await context.request.get("/api/security/methods")).json();
  const removals = await Promise.all([
    context.request.post("/api/security/remove-factor", { data: { kind: "totp" } }),
    context.request.post("/api/security/remove-factor", { data: { kind: "passkey", id: passkeys[0].id } }),
  ]);
  expect(removals.map((response) => response.status()).sort((a, b) => a - b)).toEqual([200, 403]);
  const remaining = await (await context.request.get("/api/security/status")).json();
  expect(Number(remaining.totp) + remaining.passkeys).toBe(1);
  expect(remaining.state).toBe("ready");
  await context.close();
});
