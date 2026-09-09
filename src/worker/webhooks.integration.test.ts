import { verifyWebhookSignature } from "@notionhq/client";
import { applyD1Migrations, env, reset, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bytesToBase64Url } from "../shared/security";
import type { MemberContext } from "../shared/types";
import {
  createWebhookSubscription,
  deliverWebhook,
  fanoutWebhookEvent,
  safeWebhookUrl,
  sendWebhookVerification,
  verifyWebhookSubscription,
  webhookEventStatements,
} from "./webhooks";

async function bootstrap() {
  const response = await SELF.fetch("http://example.test/api/install/bootstrap", {
    method: "POST",
    headers: { origin: "http://example.test", "content-type": "application/json" },
    body: JSON.stringify({
      bootstrapToken: "worker-bootstrap-token",
      workspaceName: "Webhook Test",
      name: "Owner",
      email: "owner@example.test",
      password: "password123",
    }),
  });
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  const me = await (
    await SELF.fetch("http://example.test/api/me", { headers: { cookie, origin: "http://example.test" } })
  ).json<{
    user: { id: string; name: string; email: string };
    workspace: { id: string; name: string; locationHint: null };
  }>();
  const tree = await (
    await SELF.fetch("http://example.test/api/pages/tree", { headers: { cookie, origin: "http://example.test" } })
  ).json<{ pages: Array<{ id: string }> }>();
  return { me, pageId: tree.pages[0]!.id };
}

async function legacyEncryptedToken(secret: string, token: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  const key = await crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(token)),
  );
  const envelope = new Uint8Array(iv.length + encrypted.length);
  envelope.set(iv);
  envelope.set(encrypted, iv.length);
  return bytesToBase64Url(envelope);
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
});

afterEach(() => vi.unstubAllGlobals());

describe("Notion-compatible webhooks", () => {
  it("accepts public HTTPS hosts and rejects local or literal-IP destinations", () => {
    expect(safeWebhookUrl("https://hooks.example.test/notion#ignored")).toBe("https://hooks.example.test/notion");
    for (const url of [
      "http://hooks.example.test/notion",
      "https://localhost/notion",
      "https://receiver.localhost/notion",
      "https://receiver.local/notion",
      "https://127.0.0.1/notion",
      "https://2130706433/notion",
      "https://[::1]/notion",
      "https://[fc00::1]/notion",
      "https://[fe80::1]/notion",
      "https://[::ffff:7f00:1]/notion",
    ]) {
      expect(() => safeWebhookUrl(url)).toThrow(/public HTTPS/);
    }
  });

  it("encrypts verification tokens, signs exact bodies, and records successful delivery", async () => {
    const { me, pageId } = await bootstrap();
    const member: MemberContext = {
      user: me.user,
      workspace: me.workspace,
      role: "owner",
      session: { id: "test", expiresAt: new Date(Date.now() + 60_000) },
    };
    const integrationId = crypto.randomUUID();
    const botId = crypto.randomUUID();
    const timestamp = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt, account_type)
         VALUES (?, 'Webhook bot', ?, 1, ?, ?, 'bot')`,
      ).bind(botId, `${botId}@integrations.invalid`, timestamp, timestamp),
      env.DB.prepare(
        `INSERT INTO integrations (id, workspace_id, bot_user_id, name, read_content, created_by, created_at, updated_at)
         VALUES (?, ?, ?, 'Webhook integration', 1, ?, ?, ?)`,
      ).bind(integrationId, me.workspace.id, botId, me.user.id, timestamp, timestamp),
      env.DB.prepare(
        `INSERT INTO integration_grants (integration_id, root_page_id, created_by, created_at)
         VALUES (?, ?, ?, ?)`,
      ).bind(integrationId, pageId, me.user.id, timestamp),
    ]);

    const invalidKeyEnv = new Proxy(env, {
      get(target, property, receiver) {
        if (property === "WEBHOOK_ENCRYPTION_KEY") return "passphrase-like-key";
        return Reflect.get(target, property, receiver);
      },
    });
    await expect(
      createWebhookSubscription(invalidKeyEnv, member, integrationId, "https://hooks.example.test/notion", [
        "page.content_updated",
      ]),
    ).rejects.toMatchObject({ status: 503, code: "webhook_encryption_unavailable" });

    const { subscription, token } = await createWebhookSubscription(
      env,
      member,
      integrationId,
      "https://hooks.example.test/notion",
      ["page.content_updated"],
    );
    const stored = await env.DB.prepare(
      `SELECT encrypted_verification_token, verification_token_hash FROM webhook_subscriptions WHERE id = ?`,
    )
      .bind(subscription.id)
      .first<{ encrypted_verification_token: string; verification_token_hash: string }>();
    expect(stored?.encrypted_verification_token).not.toContain(token);
    expect(stored?.verification_token_hash).not.toBe(token);
    await env.DB.prepare(`UPDATE webhook_subscriptions SET encrypted_verification_token = ? WHERE id = ?`)
      .bind(await legacyEncryptedToken(env.WEBHOOK_ENCRYPTION_KEY!, token), subscription.id)
      .run();
    await verifyWebhookSubscription(env, member, subscription.id, token);

    await env.DB.batch(
      webhookEventStatements(env.DB, {
        workspaceId: me.workspace.id,
        type: "page.content_updated",
        entityType: "page",
        entityId: pageId,
        pageId,
        actorId: me.user.id,
        sourceKey: "webhook-test-event",
        data: { sequence: 1 },
        createdAt: timestamp,
      }),
    );
    const event = await env.DB.prepare(`SELECT id FROM webhook_events WHERE source_key = 'webhook-test-event'`).first<{
      id: string;
    }>();
    await fanoutWebhookEvent(env, event!.id);
    const delivery = await env.DB.prepare(`SELECT id FROM webhook_deliveries WHERE event_id = ?`)
      .bind(event!.id)
      .first<{ id: string }>();
    let receivedBody = "";
    let receivedSignature = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        receivedBody = String(init?.body ?? "");
        receivedSignature = new Headers(init?.headers).get("x-notion-signature") ?? "";
        return new Response("accepted", { status: 202, headers: { "x-request-id": "receiver-1" } });
      }),
    );

    await deliverWebhook(env, delivery!.id);
    expect(
      await verifyWebhookSignature({ body: receivedBody, signature: receivedSignature, verificationToken: token }),
    ).toBe(true);
    expect(JSON.parse(receivedBody)).toMatchObject({
      id: event!.id,
      subscription_id: subscription.id,
      type: "page.content_updated",
      attempt_number: 1,
    });
    await expect(
      env.DB.prepare(`SELECT status, attempts, response_status FROM webhook_deliveries WHERE id = ?`)
        .bind(delivery!.id)
        .first(),
    ).resolves.toMatchObject({ status: "sent", attempts: 1, response_status: 202 });

    const createDelivery = async (sourceKey: string, sequence: number) => {
      await env.DB.batch(
        webhookEventStatements(env.DB, {
          workspaceId: me.workspace.id,
          type: "page.content_updated",
          entityType: "page",
          entityId: pageId,
          pageId,
          actorId: me.user.id,
          sourceKey,
          data: { sequence },
          createdAt: timestamp + sequence,
        }),
      );
      const createdEvent = await env.DB.prepare(`SELECT id FROM webhook_events WHERE source_key = ?`)
        .bind(sourceKey)
        .first<{ id: string }>();
      await fanoutWebhookEvent(env, createdEvent!.id);
      return (await env.DB.prepare(`SELECT id FROM webhook_deliveries WHERE event_id = ?`)
        .bind(createdEvent!.id)
        .first<{ id: string }>())!;
    };

    vi.mocked(fetch).mockResolvedValueOnce(new Response("receiver error", { status: 500 }));
    const failedDelivery = await createDelivery("webhook-test-failed-event", 3);
    const failedAt = Date.now();
    await deliverWebhook(env, failedDelivery.id);
    const failed = await env.DB.prepare(
      `SELECT status, attempts, response_status, next_attempt_at, last_error
         FROM webhook_deliveries WHERE id = ?`,
    )
      .bind(failedDelivery.id)
      .first<{
        status: string;
        attempts: number;
        response_status: number;
        next_attempt_at: number;
        last_error: string;
      }>();
    expect(failed).toMatchObject({ status: "pending", attempts: 1, response_status: 500, last_error: "HTTP 500" });
    expect(failed!.next_attempt_at).toBeGreaterThanOrEqual(failedAt + 60_000);
    expect(failed!.next_attempt_at).toBeLessThanOrEqual(Date.now() + 60_000);
    await expect(
      env.DB.prepare(
        `SELECT COUNT(*) count FROM outbox
          WHERE topic = 'webhook_delivery' AND json_extract(payload_json, '$.deliveryId') = ?`,
      )
        .bind(failedDelivery.id)
        .first(),
    ).resolves.toEqual({ count: 2 });

    const suppressedDelivery = await createDelivery("webhook-test-suppressed-event", 4);
    await env.DB.prepare(`DELETE FROM integration_grants WHERE integration_id = ?`).bind(integrationId).run();
    await deliverWebhook(env, suppressedDelivery.id);
    await expect(
      env.DB.prepare(`SELECT status, attempts, last_error FROM webhook_deliveries WHERE id = ?`)
        .bind(suppressedDelivery.id)
        .first(),
    ).resolves.toEqual({ status: "suppressed", attempts: 0, last_error: "Access or capability revoked" });
    await env.DB.prepare(
      `INSERT INTO integration_grants (integration_id, root_page_id, created_by, created_at)
       VALUES (?, ?, ?, ?)`,
    )
      .bind(integrationId, pageId, me.user.id, Date.now())
      .run();

    const corruptDelivery = await createDelivery("webhook-test-corrupt-token-event", 5);
    await env.DB.prepare(`UPDATE webhook_subscriptions SET encrypted_verification_token = 'malformed' WHERE id = ?`)
      .bind(subscription.id)
      .run();
    await deliverWebhook(env, corruptDelivery.id);
    await expect(
      env.DB.prepare(`SELECT status, attempts, next_attempt_at, last_error FROM webhook_deliveries WHERE id = ?`)
        .bind(corruptDelivery.id)
        .first(),
    ).resolves.toMatchObject({
      status: "pending",
      attempts: 1,
      next_attempt_at: expect.any(Number),
      last_error: expect.any(String),
    });
    await env.DB.prepare(`UPDATE webhook_subscriptions SET encrypted_verification_token = ? WHERE id = ?`)
      .bind(stored!.encrypted_verification_token, subscription.id)
      .run();

    await env.DB.batch(
      webhookEventStatements(env.DB, {
        workspaceId: me.workspace.id,
        type: "page.content_updated",
        entityType: "page",
        entityId: pageId,
        pageId,
        actorId: me.user.id,
        sourceKey: "webhook-test-queued-event",
        data: { sequence: 2 },
        createdAt: timestamp + 1,
      }),
    );
    const queuedEvent = await env.DB.prepare(
      `SELECT id FROM webhook_events WHERE source_key = 'webhook-test-queued-event'`,
    ).first<{ id: string }>();
    await fanoutWebhookEvent(env, queuedEvent!.id);
    const queuedDelivery = await env.DB.prepare(`SELECT id FROM webhook_deliveries WHERE event_id = ?`)
      .bind(queuedEvent!.id)
      .first<{ id: string }>();
    const retryRowsBefore = await env.DB.prepare(
      `SELECT COUNT(*) count FROM outbox
        WHERE topic = 'webhook_delivery' AND json_extract(payload_json, '$.deliveryId') = ?`,
    )
      .bind(queuedDelivery!.id)
      .first<{ count: number }>();
    await env.DB.prepare(
      `UPDATE webhook_subscriptions SET url = 'https://[::1]/notion', status = 'active' WHERE id = ?`,
    )
      .bind(subscription.id)
      .run();
    vi.mocked(fetch).mockClear();
    await deliverWebhook(env, queuedDelivery!.id);
    await expect(
      env.DB.prepare(`SELECT status, attempts, next_attempt_at FROM webhook_deliveries WHERE id = ?`)
        .bind(queuedDelivery!.id)
        .first(),
    ).resolves.toEqual({ status: "failed", attempts: 1, next_attempt_at: null });
    await expect(
      env.DB.prepare(`SELECT status FROM webhook_subscriptions WHERE id = ?`).bind(subscription.id).first(),
    ).resolves.toEqual({ status: "paused" });
    await expect(
      env.DB.prepare(
        `SELECT COUNT(*) count FROM outbox
          WHERE topic = 'webhook_delivery' AND json_extract(payload_json, '$.deliveryId') = ?`,
      )
        .bind(queuedDelivery!.id)
        .first(),
    ).resolves.toEqual(retryRowsBefore);
    expect(fetch).not.toHaveBeenCalled();

    await env.DB.prepare(
      `UPDATE webhook_subscriptions SET url = 'https://hooks.example.test/notion', status = 'pending_verification'
        WHERE id = ?`,
    )
      .bind(subscription.id)
      .run();
    vi.mocked(fetch).mockResolvedValueOnce(new Response("receiver error", { status: 500 }));
    await expect(sendWebhookVerification(env, subscription.id)).resolves.toEqual({
      ok: false,
      error: "Webhook endpoint returned HTTP 500.",
    });
    vi.mocked(fetch).mockRejectedValueOnce(new Error("network unavailable"));
    await expect(sendWebhookVerification(env, subscription.id)).resolves.toEqual({
      ok: false,
      error: "network unavailable",
    });
    vi.mocked(fetch).mockClear();
    await env.DB.prepare(`UPDATE webhook_subscriptions SET url = 'https://[::1]/notion' WHERE id = ?`)
      .bind(subscription.id)
      .run();
    await expect(sendWebhookVerification(env, subscription.id)).rejects.toMatchObject({
      code: "invalid_webhook_url",
    });
    await expect(
      env.DB.prepare(`SELECT status FROM webhook_subscriptions WHERE id = ?`).bind(subscription.id).first(),
    ).resolves.toEqual({ status: "paused" });
    expect(fetch).not.toHaveBeenCalled();
    await expect(
      env.DB.prepare(`SELECT status FROM webhook_subscriptions WHERE id = ?`).bind(subscription.id).first(),
    ).resolves.toEqual({ status: "paused" });
  });
});
