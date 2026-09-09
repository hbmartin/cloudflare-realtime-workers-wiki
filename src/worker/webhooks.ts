import { sha256Hex } from "../shared/import-integrity";
import { base64UrlToBytes, bytesToBase64Url, constantTimeEqual, hmacSha256Hex } from "../shared/security";
import type { Env, MemberContext } from "./env";
import { publicPageId } from "./integrations";
import { HttpError } from "./http";

const WEBHOOK_EVENT_TYPES = [
  "page.created",
  "page.content_updated",
  "page.properties_updated",
  "page.moved",
  "page.deleted",
  "page.undeleted",
  "comment.created",
  "comment.updated",
  "comment.deleted",
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

type SubscriptionRow = {
  id: string;
  integration_id: string;
  url: string;
  events_json: string;
  status: "pending_verification" | "active" | "paused" | "deleted";
  encrypted_verification_token: string;
  verification_token_hash: string;
  verified_at: number | null;
  created_at: number;
  updated_at: number;
  integration_name?: string;
};

type EventRow = {
  id: string;
  workspace_id: string;
  event_type: WebhookEventType;
  entity_type: "page" | "block" | "comment";
  entity_id: string;
  page_id: string | null;
  actor_id: string | null;
  data_json: string;
  created_at: number;
};

const RETRY_DELAYS = [
  0,
  60_000,
  5 * 60_000,
  30 * 60_000,
  2 * 60 * 60_000,
  6 * 60 * 60_000,
  12 * 60 * 60_000,
  24 * 60 * 60_000,
];

function verificationToken() {
  return `secret_${bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)))}`;
}

function encryptionMaterial(env: Env) {
  const encoded = env.WEBHOOK_ENCRYPTION_KEY;
  let key: Uint8Array;
  try {
    if (!encoded || !/^[A-Za-z0-9_-]{43}$/.test(encoded)) throw new Error("invalid key");
    key = base64UrlToBytes(encoded);
    if (key.byteLength !== 32 || bytesToBase64Url(key) !== encoded) throw new Error("invalid key");
  } catch {
    throw new HttpError(
      503,
      "webhook_encryption_unavailable",
      "Configure WEBHOOK_ENCRYPTION_KEY as 32 random bytes encoded with unpadded base64url.",
    );
  }
  return { encoded, key: Uint8Array.from(key) };
}

async function encryptionKey(env: Env) {
  return crypto.subtle.importKey("raw", encryptionMaterial(env).key, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

async function legacyEncryptionKey(env: Env) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(encryptionMaterial(env).encoded));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["decrypt"]);
}

async function encryptToken(env: Env, token: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await encryptionKey(env), new TextEncoder().encode(token)),
  );
  const output = new Uint8Array(iv.length + encrypted.length);
  output.set(iv);
  output.set(encrypted, iv.length);
  return bytesToBase64Url(output);
}

async function decryptToken(env: Env, encrypted: string) {
  const input = base64UrlToBytes(encrypted);
  const algorithm = { name: "AES-GCM", iv: input.slice(0, 12) };
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt(algorithm, await encryptionKey(env), input.slice(12));
  } catch {
    // Before the key format was made explicit, configured strings were hashed.
    // Keep valid, already-formatted deployments able to read their stored tokens.
    plain = await crypto.subtle.decrypt(algorithm, await legacyEncryptionKey(env), input.slice(12));
  }
  return new TextDecoder().decode(plain);
}

export function safeWebhookUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(422, "invalid_webhook_url", "Enter a valid HTTPS webhook URL.");
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  // Workers global fetch does not support IP-address URLs and mediates DNS so
  // resolved destinations cannot reach Cloudflare's internal network. Rejecting
  // every literal here also keeps local and alternate runtimes from having to
  // duplicate an ever-growing list of private IPv4 and IPv6 ranges.
  const isIpLiteral = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || /^\[[0-9a-f:.]+\]$/.test(hostname);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    isIpLiteral
  ) {
    throw new HttpError(422, "invalid_webhook_url", "Webhook URLs must be public HTTPS endpoints.");
  }
  url.hash = "";
  return url.toString();
}

async function storedWebhookUrl(env: Env, subscriptionId: string, value: string) {
  try {
    return safeWebhookUrl(value);
  } catch (error) {
    await env.DB.prepare(
      `UPDATE webhook_subscriptions SET status = 'paused', updated_at = ?
        WHERE id = ? AND status <> 'deleted'`,
    )
      .bind(Date.now(), subscriptionId)
      .run();
    throw error;
  }
}

function events(value: unknown) {
  if (!Array.isArray(value) || !value.length || value.length > WEBHOOK_EVENT_TYPES.length) {
    throw new HttpError(422, "invalid_webhook_events", "Choose at least one supported event.");
  }
  const selected = value.map(String);
  if (
    new Set(selected).size !== selected.length ||
    selected.some((event) => !WEBHOOK_EVENT_TYPES.includes(event as WebhookEventType))
  ) {
    throw new HttpError(422, "invalid_webhook_events", "A webhook event is unsupported or duplicated.");
  }
  return selected as WebhookEventType[];
}

async function ownerIntegration(env: Env, member: MemberContext, integrationId: string) {
  const row = await env.DB.prepare(`SELECT id, revoked_at FROM integrations WHERE id = ? AND workspace_id = ?`)
    .bind(integrationId, member.workspace.id)
    .first<{ id: string; revoked_at: number | null }>();
  if (!row) throw new HttpError(404, "integration_not_found", "Integration not found.");
  if (row.revoked_at) throw new HttpError(409, "integration_revoked", "This integration is revoked.");
}

function subscriptionJson(row: SubscriptionRow) {
  return {
    id: row.id,
    integrationId: row.integration_id,
    integrationName: row.integration_name,
    url: row.url,
    events: JSON.parse(row.events_json) as WebhookEventType[],
    status: row.status,
    verifiedAt: row.verified_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listWebhookSubscriptions(env: Env, member: MemberContext) {
  const rows = await env.DB.prepare(
    `SELECT subscription.*, integration.name integration_name FROM webhook_subscriptions subscription
       JOIN integrations integration ON integration.id = subscription.integration_id
      WHERE integration.workspace_id = ? AND subscription.status <> 'deleted'
      ORDER BY subscription.created_at DESC`,
  )
    .bind(member.workspace.id)
    .all<SubscriptionRow>();
  return rows.results.map(subscriptionJson);
}

export async function createWebhookSubscription(
  env: Env,
  member: MemberContext,
  integrationId: string,
  url: string,
  requestedEvents: unknown,
) {
  await ownerIntegration(env, member, integrationId);
  const token = verificationToken();
  const timestamp = Date.now();
  const id = crypto.randomUUID();
  const row: SubscriptionRow = {
    id,
    integration_id: integrationId,
    url: safeWebhookUrl(url),
    events_json: JSON.stringify(events(requestedEvents)),
    status: "pending_verification",
    encrypted_verification_token: await encryptToken(env, token),
    verification_token_hash: await sha256Hex(token),
    verified_at: null,
    created_at: timestamp,
    updated_at: timestamp,
  };
  await env.DB.prepare(
    `INSERT INTO webhook_subscriptions
      (id, integration_id, url, events_json, encrypted_verification_token, verification_token_hash,
       created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      row.id,
      row.integration_id,
      row.url,
      row.events_json,
      row.encrypted_verification_token,
      row.verification_token_hash,
      member.user.id,
      timestamp,
      timestamp,
    )
    .run();
  return { subscription: subscriptionJson(row), token };
}

async function ownedSubscription(env: Env, member: MemberContext, id: string) {
  const row = await env.DB.prepare(
    `SELECT subscription.* FROM webhook_subscriptions subscription
       JOIN integrations integration ON integration.id = subscription.integration_id
      WHERE subscription.id = ? AND integration.workspace_id = ? AND subscription.status <> 'deleted'`,
  )
    .bind(id, member.workspace.id)
    .first<SubscriptionRow>();
  if (!row) throw new HttpError(404, "webhook_not_found", "Webhook subscription not found.");
  return row;
}

export async function sendWebhookVerification(env: Env, subscriptionId: string) {
  const row = await env.DB.prepare(
    `SELECT * FROM webhook_subscriptions WHERE id = ? AND status = 'pending_verification'`,
  )
    .bind(subscriptionId)
    .first<SubscriptionRow>();
  if (!row) return { ok: false as const, error: "Webhook subscription is no longer pending verification." };
  const destination = await storedWebhookUrl(env, row.id, row.url);
  const token = await decryptToken(env, row.encrypted_verification_token);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(destination, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "Realtime-Notes-Webhook/1.0" },
      body: JSON.stringify({ verification_token: token }),
      redirect: "manual",
      signal: controller.signal,
    });
    if (!response.ok) return { ok: false as const, error: `Webhook endpoint returned HTTP ${response.status}.` };
    return { ok: true as const };
  } catch (error) {
    return {
      ok: false as const,
      error: error instanceof Error ? error.message.slice(0, 500) : "Webhook verification request failed.",
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function resendWebhookVerification(env: Env, member: MemberContext, id: string) {
  const row = await ownedSubscription(env, member, id);
  if (row.status !== "pending_verification") {
    throw new HttpError(409, "webhook_already_verified", "Only pending subscriptions can resend verification.");
  }
  return sendWebhookVerification(env, id);
}

export async function verifyWebhookSubscription(env: Env, member: MemberContext, id: string, token: string) {
  const row = await ownedSubscription(env, member, id);
  if (row.status !== "pending_verification") {
    throw new HttpError(409, "webhook_already_verified", "This subscription is already verified.");
  }
  const suppliedHash = await sha256Hex(token);
  if (!constantTimeEqual(suppliedHash, row.verification_token_hash)) {
    throw new HttpError(422, "invalid_verification_token", "The verification token does not match.");
  }
  const timestamp = Date.now();
  await env.DB.prepare(
    `UPDATE webhook_subscriptions SET status = 'active', verified_at = ?, updated_at = ?
      WHERE id = ? AND status = 'pending_verification'`,
  )
    .bind(timestamp, timestamp, id)
    .run();
}

export async function updateWebhookSubscription(
  env: Env,
  member: MemberContext,
  id: string,
  input: { url?: string; events?: unknown; paused?: boolean },
) {
  const row = await ownedSubscription(env, member, id);
  if (input.url !== undefined && row.status !== "pending_verification") {
    throw new HttpError(409, "webhook_url_locked", "A verified webhook URL cannot be changed.");
  }
  const url = input.url === undefined ? row.url : safeWebhookUrl(input.url);
  const selected = input.events === undefined ? row.events_json : JSON.stringify(events(input.events));
  const status =
    input.paused === undefined
      ? row.status
      : input.paused
        ? "paused"
        : row.verified_at
          ? "active"
          : "pending_verification";
  await env.DB.prepare(
    `UPDATE webhook_subscriptions SET url = ?, events_json = ?, status = ?, updated_at = ? WHERE id = ?`,
  )
    .bind(url, selected, status, Date.now(), id)
    .run();
}

export async function deleteWebhookSubscription(env: Env, member: MemberContext, id: string) {
  await ownedSubscription(env, member, id);
  await env.DB.prepare(`UPDATE webhook_subscriptions SET status = 'deleted', updated_at = ? WHERE id = ?`)
    .bind(Date.now(), id)
    .run();
}

export async function listWebhookDeliveries(env: Env, member: MemberContext, subscriptionId?: string) {
  const rows = await env.DB.prepare(
    `SELECT delivery.id, delivery.subscription_id subscriptionId, delivery.status, delivery.attempts,
            delivery.next_attempt_at nextAttemptAt, delivery.response_status responseStatus,
            delivery.response_headers_json responseHeaders, delivery.response_body responseBody,
            delivery.last_error lastError, delivery.delivered_at deliveredAt, delivery.created_at createdAt,
            event.event_type eventType, event.entity_id entityId
       FROM webhook_deliveries delivery JOIN webhook_events event ON event.id = delivery.event_id
       JOIN webhook_subscriptions subscription ON subscription.id = delivery.subscription_id
       JOIN integrations integration ON integration.id = subscription.integration_id
      WHERE integration.workspace_id = ? AND (? IS NULL OR delivery.subscription_id = ?)
      ORDER BY delivery.created_at DESC LIMIT 200`,
  )
    .bind(member.workspace.id, subscriptionId ?? null, subscriptionId ?? null)
    .all<Record<string, unknown>>();
  return rows.results.map((row) => ({
    ...row,
    responseHeaders: typeof row.responseHeaders === "string" ? JSON.parse(row.responseHeaders) : null,
  }));
}

export function webhookEventStatements(
  database: D1Database,
  input: {
    workspaceId: string;
    type: WebhookEventType;
    entityType: "page" | "block" | "comment";
    entityId: string;
    pageId: string | null;
    actorId: string | null;
    sourceKey: string;
    data?: Record<string, unknown>;
    createdAt: number;
  },
) {
  const eventId = crypto.randomUUID();
  const outboxId = crypto.randomUUID();
  return [
    database
      .prepare(
        `INSERT OR IGNORE INTO webhook_events
        (id, workspace_id, event_type, entity_type, entity_id, page_id, actor_id, data_json, source_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        eventId,
        input.workspaceId,
        input.type,
        input.entityType,
        input.entityId,
        input.pageId,
        input.actorId,
        JSON.stringify(input.data ?? {}),
        input.sourceKey,
        input.createdAt,
      ),
    database
      .prepare(
        `INSERT INTO outbox (id, workspace_id, topic, payload_json, available_at, created_at)
       SELECT ?, ?, 'webhook_event', ?, ?, ? WHERE changes() > 0`,
      )
      .bind(outboxId, input.workspaceId, JSON.stringify({ eventId }), input.createdAt, input.createdAt),
  ];
}

async function deliveryAllowed(env: Env, event: EventRow, subscription: SubscriptionRow) {
  const row = await env.DB.prepare(
    `WITH RECURSIVE ancestors(id, parent_id) AS (
       SELECT id, parent_id FROM pages WHERE id = ?
       UNION ALL SELECT parent.id, parent.parent_id FROM pages parent JOIN ancestors child ON parent.id = child.parent_id
     ) SELECT integration.read_content, integration.read_comments FROM integrations integration
       WHERE integration.id = ? AND integration.revoked_at IS NULL
         AND EXISTS (
           SELECT 1 FROM integration_grants grant_row JOIN pages root ON root.id = grant_row.root_page_id
             JOIN ancestors ON ancestors.id = grant_row.root_page_id WHERE grant_row.integration_id = integration.id
         )`,
  )
    .bind(event.page_id, subscription.integration_id)
    .first<{ read_content: number; read_comments: number }>();
  return Boolean(row && (event.event_type.startsWith("comment.") ? row.read_comments : row.read_content));
}

export async function fanoutWebhookEvent(env: Env, eventId: string) {
  const event = await env.DB.prepare(`SELECT * FROM webhook_events WHERE id = ?`).bind(eventId).first<EventRow>();
  if (!event || !event.page_id) return;
  const subscriptions = await env.DB.prepare(
    `SELECT subscription.* FROM webhook_subscriptions subscription
       JOIN integrations integration ON integration.id = subscription.integration_id
      WHERE integration.workspace_id = ? AND integration.revoked_at IS NULL
        AND subscription.status = 'active'
        AND EXISTS (SELECT 1 FROM json_each(subscription.events_json) WHERE value = ?)`,
  )
    .bind(event.workspace_id, event.event_type)
    .all<SubscriptionRow>();
  const timestamp = Date.now();
  const statements: D1PreparedStatement[] = [];
  for (const subscription of subscriptions.results) {
    try {
      await storedWebhookUrl(env, subscription.id, subscription.url);
    } catch {
      continue;
    }
    if (!(await deliveryAllowed(env, event, subscription))) continue;
    const deliveryId = crypto.randomUUID();
    const outboxId = crypto.randomUUID();
    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO webhook_deliveries
          (id, event_id, subscription_id, status, attempts, next_attempt_at, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)`,
      ).bind(deliveryId, event.id, subscription.id, timestamp, timestamp, timestamp),
      env.DB.prepare(
        `INSERT INTO outbox (id, workspace_id, topic, payload_json, available_at, created_at)
         SELECT ?, ?, 'webhook_delivery', ?, ?, ? WHERE changes() > 0`,
      ).bind(outboxId, event.workspace_id, JSON.stringify({ deliveryId }), timestamp, timestamp),
    );
  }
  if (statements.length) await env.DB.batch(statements);
}

async function responseBody(response: Response) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (length < 64 * 1024) {
    const { value, done } = await reader.read();
    if (done) break;
    const chunk = value.slice(0, 64 * 1024 - length);
    chunks.push(chunk);
    length += chunk.byteLength;
  }
  await reader.cancel().catch(() => undefined);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export async function deliverWebhook(env: Env, deliveryId: string) {
  const row = await env.DB.prepare(
    `SELECT delivery.attempts, delivery.status delivery_status, event.*,
            subscription.id subscription_id, subscription.integration_id, subscription.url,
            subscription.status subscription_status, subscription.events_json,
            subscription.encrypted_verification_token
       FROM webhook_deliveries delivery JOIN webhook_events event ON event.id = delivery.event_id
       JOIN webhook_subscriptions subscription ON subscription.id = delivery.subscription_id
      WHERE delivery.id = ?`,
  )
    .bind(deliveryId)
    .first<
      EventRow & {
        attempts: number;
        delivery_status: string;
        subscription_id: string;
        integration_id: string;
        url: string;
        subscription_status: SubscriptionRow["status"];
        events_json: string;
        encrypted_verification_token: string;
      }
    >();
  if (!row || row.delivery_status !== "pending") return;
  const subscription: SubscriptionRow = {
    id: row.subscription_id,
    integration_id: row.integration_id,
    url: row.url,
    events_json: row.events_json,
    status: row.subscription_status,
    encrypted_verification_token: row.encrypted_verification_token,
    verification_token_hash: "",
    verified_at: null,
    created_at: row.created_at,
    updated_at: row.created_at,
  };
  if (
    subscription.status !== "active" ||
    !JSON.parse(subscription.events_json).includes(row.event_type) ||
    !(await deliveryAllowed(env, row, subscription))
  ) {
    await env.DB.prepare(
      `UPDATE webhook_deliveries SET status = 'suppressed', last_error = 'Access or capability revoked', updated_at = ? WHERE id = ?`,
    )
      .bind(Date.now(), deliveryId)
      .run();
    return;
  }
  const attempt = row.attempts + 1;
  let destination: string;
  try {
    destination = await storedWebhookUrl(env, subscription.id, subscription.url);
  } catch (error) {
    const timestamp = Date.now();
    await env.DB.prepare(
      `UPDATE webhook_deliveries SET status = 'failed', attempts = ?, next_attempt_at = NULL,
       last_error = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(
        attempt,
        error instanceof Error ? error.message.slice(0, 500) : "Webhook URL is invalid",
        timestamp,
        deliveryId,
      )
      .run();
    return;
  }
  const entityId = row.entity_type === "page" ? await publicPageId(env, row.entity_id) : row.entity_id;
  const payload = JSON.stringify({
    id: row.id,
    timestamp: new Date(row.created_at).toISOString(),
    workspace_id: row.workspace_id,
    subscription_id: subscription.id,
    integration_id: subscription.integration_id,
    type: row.event_type,
    authors: row.actor_id ? [{ id: row.actor_id, type: "person" }] : [],
    entity: { id: entityId, type: row.entity_type },
    data: JSON.parse(row.data_json),
    attempt_number: attempt,
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  let status: number | null = null;
  let headers: Record<string, string> = {};
  let received = "";
  let failure: string | null = null;
  try {
    const token = await decryptToken(env, subscription.encrypted_verification_token);
    const signature = `sha256=${await hmacSha256Hex(token, payload)}`;
    const response = await fetch(destination, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "Realtime-Notes-Webhook/1.0",
        "x-notion-signature": signature,
      },
      body: payload,
      redirect: "manual",
      signal: controller.signal,
    });
    status = response.status;
    headers = Object.fromEntries(
      ["content-type", "date", "retry-after", "x-request-id"]
        .map((name) => [name, response.headers.get(name)] as const)
        .filter((entry): entry is [string, string] => entry[1] !== null),
    );
    received = await responseBody(response);
    if (status < 200 || status >= 300) failure = `HTTP ${status}`;
  } catch (error) {
    failure = error instanceof Error ? error.message.slice(0, 500) : "Webhook request failed";
  } finally {
    clearTimeout(timer);
  }
  const timestamp = Date.now();
  if (!failure) {
    await env.DB.prepare(
      `UPDATE webhook_deliveries SET status = 'sent', attempts = ?, next_attempt_at = NULL,
       response_status = ?, response_headers_json = ?, response_body = ?, last_error = NULL,
       delivered_at = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(attempt, status, JSON.stringify(headers), received, timestamp, timestamp, deliveryId)
      .run();
    return;
  }
  if (attempt >= RETRY_DELAYS.length) {
    await env.DB.prepare(
      `UPDATE webhook_deliveries SET status = 'failed', attempts = ?, next_attempt_at = NULL,
       response_status = ?, response_headers_json = ?, response_body = ?, last_error = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(attempt, status, JSON.stringify(headers), received, failure, timestamp, deliveryId)
      .run();
    return;
  }
  const availableAt = timestamp + RETRY_DELAYS[attempt]!;
  const outboxId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE webhook_deliveries SET attempts = ?, next_attempt_at = ?, response_status = ?,
       response_headers_json = ?, response_body = ?, last_error = ?, updated_at = ? WHERE id = ?`,
    ).bind(attempt, availableAt, status, JSON.stringify(headers), received, failure, timestamp, deliveryId),
    env.DB.prepare(
      `INSERT INTO outbox (id, workspace_id, topic, payload_json, available_at, created_at)
       VALUES (?, ?, 'webhook_delivery', ?, ?, ?)`,
    ).bind(outboxId, row.workspace_id, JSON.stringify({ deliveryId }), availableAt, timestamp),
  ]);
  try {
    // Put the future retry on the queue immediately. The consumer defers it until
    // available_at, while the durable outbox still recovers ambiguous enqueue failures.
    await env.DELIVERY_QUEUE.send({ outboxId });
    await env.DB.prepare(`UPDATE outbox SET enqueued_at = ?, attempts = attempts + 1, last_error = NULL WHERE id = ?`)
      .bind(Date.now(), outboxId)
      .run();
  } catch (error) {
    await env.DB.prepare(`UPDATE outbox SET last_error = ? WHERE id = ?`)
      .bind(error instanceof Error ? error.message.slice(0, 500) : "Queue enqueue failed.", outboxId)
      .run();
  }
}

export async function pruneWebhookHistory(env: Env) {
  const cutoff = Date.now() - 30 * 24 * 60 * 60_000;
  await env.DB.prepare(`DELETE FROM webhook_events WHERE created_at < ?`).bind(cutoff).run();
}
