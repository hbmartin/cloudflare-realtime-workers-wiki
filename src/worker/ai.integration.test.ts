import {
  applyD1Migrations,
  createExecutionContext,
  env,
  reset,
  runInDurableObject,
  SELF,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { enrollAccount } from "../../tests/helpers/security";
import type {
  AiConversation,
  AiConversationAccess,
  AiGenerate,
  AiSettings,
  AiStatus,
  AiStreamEvent,
} from "../shared/ai";
import { AI_GENERATION_DEADLINE_MS, AI_RETENTION_MS } from "../shared/ai";
import type { Page } from "../shared/types";
import { diagramNodeMap, diagramRoots } from "../shared/diagram";
import type { Env, MemberContext } from "./env";
import worker from "./index";
import { requireMember } from "./auth";
import { readAiSource, fetchDiagramSource, fetchTableSource } from "./ai-sources";
import { pruneAi } from "./ai";
/* oxlint-disable vitest/no-standalone-expect -- Fixture setup validates authenticated bootstrap and mocked provider credentials. */

const ORIGIN = "http://example.test";
let cookie: string, member: MemberContext, page: Page;
let providerStatus: number, finish: boolean, output: string, providerCalls: Record<string, unknown>[];
const settings: AiSettings = {
  enabled: true,
  apiEnabled: true,
  dailyQuota: 20,
  models: {
    api: { fast: { id: "test-fast", maxCharacters: 250000 }, best: { id: "test-best", maxCharacters: 250000 } },
    chatgpt: { fast: { id: "chatgpt-test", maxCharacters: 250000 }, best: { id: "", maxCharacters: 250000 } },
  },
};
const bindings = () => ({ ...env, OPENAI_API_KEY: "operator-private-test-key" }) as Env;
function request(path: string, method = "GET", body?: unknown) {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
async function call(path: string, method = "GET", body?: unknown) {
  const context = createExecutionContext(),
    response = await worker.fetch(request(path, method, body), bindings(), context);
  await waitOnExecutionContext(context);
  return response;
}
function input(overrides: Partial<AiGenerate> = {}): AiGenerate {
  return {
    operationId: crypto.randomUUID(),
    pageId: page.id,
    action: "rewrite",
    prompt: "",
    funding: "api",
    quality: "fast",
    sources: [{ pageId: page.id, scope: { kind: "page" } }],
    ...overrides,
  };
}
async function generate(value = input()) {
  const response = await call("/api/ai/generate", "POST", value);
  const text = await response.text();
  return {
    response,
    text,
    events: response.ok
      ? text
          .split("\n\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line.slice(6)) as AiStreamEvent)
      : [],
  };
}
async function documentText(value: string, blockId = "selected") {
  const room = env.DOCUMENT.getByName(`${page.id}~${page.contentEpoch}`);
  await room.fetch(
    new Request("https://document.internal/content", { headers: { "x-notes-internal": env.BETTER_AUTH_SECRET } }),
  );
  await runInDurableObject(room, async (instance) => {
    const object = instance as unknown as { document: Y.Doc; compact(): Promise<void> };
    const block = new Y.XmlElement("blockContainer");
    block.setAttribute("id", blockId);
    const paragraph = new Y.XmlElement("paragraph"),
      text = new Y.XmlText();
    text.insert(0, value);
    paragraph.insert(0, [text]);
    block.insert(0, [paragraph]);
    const group = new Y.XmlElement("blockGroup");
    group.insert(0, [block]);
    const fragment = object.document.getXmlFragment("document-store");
    object.document.transact(() => {
      if (fragment.length) fragment.delete(0, fragment.length);
      fragment.insert(0, [group]);
    });
    await object.compact();
  });
}
async function liveGeneration() {
  let upstream!: ReadableStreamDefaultController<Uint8Array>, ready!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (resource: RequestInfo | URL, init?: RequestInit) => {
      if (String(resource).endsWith("/models")) return Response.json({ data: [{ id: "test-fast" }] });
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            upstream = controller;
            ready();
            init?.signal?.addEventListener(
              "abort",
              () => {
                try {
                  controller.error(new DOMException("Stopped", "AbortError"));
                } catch {
                  /* The upstream may already be closed. */
                }
              },
              { once: true },
            );
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    }),
  );
  const value = input(),
    context = createExecutionContext();
  const response = await worker.fetch(request("/api/ai/generate", "POST", value), bindings(), context),
    reader = response.body!.getReader();
  const start = JSON.parse(
    new TextDecoder()
      .decode((await reader.read()).value)
      .slice(6)
      .trim(),
  ) as Extract<AiStreamEvent, { type: "start" }>;
  await started;
  return {
    value,
    context,
    reader,
    start,
    send: (event: unknown) => upstream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)),
  };
}
async function anotherOwner() {
  await env.DB.prepare(
    "INSERT INTO user(id,name,email,createdAt,updatedAt) VALUES('other-owner','Other owner','other@example.test',1,1)",
  ).run();
  await env.DB.prepare("INSERT INTO workspace_members VALUES(?,'other-owner','owner',1)")
    .bind(member.workspace.id)
    .run();
}
beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
  const response = await SELF.fetch(`${ORIGIN}/api/install/bootstrap`, {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({
      bootstrapToken: "worker-bootstrap-token",
      workspaceName: "Writing tests",
      name: "Owner",
      email: "owner@example.test",
      password: "password123",
    }),
  });
  expect(response.status).toBe(200);
  cookie = await enrollAccount(response);
  member = await requireMember(request("/api/me"), env);
  page = (await (await call("/api/pages/tree")).json<{ pages: Page[] }>()).pages.find(
    (value) => value.kind === "document",
  )!;
  await env.DB.prepare("INSERT INTO ai_settings VALUES(?,?)").bind(member.workspace.id, JSON.stringify(settings)).run();
  await documentText("Original source paragraph");
  providerStatus = 200;
  finish = true;
  output = "Improved **source** paragraph";
  providerCalls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (resource: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(resource instanceof Request ? resource.url : String(resource));
      if (url.pathname === "/v1/models") return Response.json({ data: [{ id: "test-fast" }, { id: "test-best" }] });
      if (url.pathname !== "/v1/responses") throw new Error("Unexpected external request.");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer operator-private-test-key");
      providerCalls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (providerStatus !== 200)
        return Response.json({ error: { message: "Private provider diagnostic" } }, { status: providerStatus });
      return new Response(
        `data: ${JSON.stringify({ type: "response.output_text.delta", delta: output })}\n\n${finish ? `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed" } })}\n\n` : ""}`,
        { headers: { "content-type": "text/event-stream" } },
      );
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AI writing dispatch and quota", () => {
  it("streams complete results, saves private history, uses the selected model, and replays without dispatch or quota", async () => {
    const value = input({ quality: "best" });
    const result = await generate(value);
    expect(result.response.status).toBe(200);
    expect(result.events.at(-1)).toEqual({ type: "complete" });
    expect(providerCalls).toHaveLength(1);
    expect(providerCalls[0]).toMatchObject({ model: "test-best", store: false, stream: true });
    expect(providerCalls[0]).not.toHaveProperty("previous_response_id");
    const start = result.events[0] as Extract<AiStreamEvent, { type: "start" }>;
    const saved = await (
      await call(`/api/ai/conversations/${start.conversationId}`)
    ).json<{ conversation: AiConversation }>();
    expect(saved.conversation.messages?.[0]).toMatchObject({
      output,
      status: "complete",
      funding: "api",
      quality: "best",
    });
    const replay = await generate(value);
    expect(replay.events.at(-1)).toEqual({ type: "complete" });
    expect(providerCalls).toHaveLength(1);
    const status = await (await call("/api/ai/status")).json<AiStatus>();
    expect(status.quota.remaining).toBe(19);
    expect(status.quota.resetsAt % 86400000).toBe(0);
    expect(JSON.stringify(status)).not.toContain("operator-private-test-key");
  });
  it("keeps translation parameters in follow-ups and retains idempotency after deletion", async () => {
    const value = input({ action: "translate", targetLanguage: "Japanese", prompt: "Keep names unchanged" });
    const first = await generate(value);
    const start = first.events[0] as Extract<AiStreamEvent, { type: "start" }>;
    const followup = await generate(
      input({ conversationId: start.conversationId, action: "custom", prompt: "Make it more concise" }),
    );
    expect(followup.events.at(-1)).toEqual({ type: "complete" });
    expect(JSON.stringify(providerCalls[1]?.input)).toContain("Translation language: Japanese");
    await call(`/api/ai/conversations/${start.conversationId}`, "DELETE");
    const replay = await generate(value);
    expect(replay.response.status).toBe(409);
    expect(replay.text).toContain("ai_operation_deleted");
    expect(providerCalls).toHaveLength(2);
    expect((await (await call("/api/ai/status")).json<AiStatus>()).quota.remaining).toBe(18);
  });
  it("counts one request under concurrent duplicate dispatch, and atomically enforces the daily quota", async () => {
    const value = input();
    const results = await Promise.all([generate(value), generate(value)]);
    expect(results.some((result) => result.response.ok)).toBe(true);
    expect(providerCalls).toHaveLength(1);
    await call("/api/ai/settings", "POST", { ...settings, dailyQuota: 1 });
    expect((await generate()).response.status).toBe(429);
    expect(providerCalls).toHaveLength(1);
    const day = Math.floor(Date.now() / 86400000);
    await env.DB.prepare("UPDATE ai_requests SET day=?")
      .bind(day - 1)
      .run();
    expect((await generate()).response.ok).toBe(true);
    expect(providerCalls).toHaveLength(2);
  });
  it("refunds confirmed pre-generation rejections, counts uncertain failures, and makes partial text copy only", async () => {
    providerStatus = 429;
    const rejected = await generate();
    expect(rejected.text).toContain("ai_provider_rejected");
    expect((await (await call("/api/ai/status")).json<AiStatus>()).quota.remaining).toBe(20);
    providerStatus = 503;
    await generate();
    expect((await (await call("/api/ai/status")).json<AiStatus>()).quota.remaining).toBe(19);
    providerStatus = 200;
    finish = false;
    const partial = await generate();
    expect(partial.events.at(-1)?.type).toBe("error");
    const start = partial.events[0] as Extract<AiStreamEvent, { type: "start" }>;
    expect((await call(`/api/ai/results/${start.messageId}/apply-check`, "POST", {})).status).toBe(409);
    expect(
      await env.DB.prepare("SELECT output,status FROM ai_messages WHERE id=?").bind(start.messageId).first(),
    ).toEqual({ output, status: "failed" });
    expect(partial.text).not.toContain("Private provider diagnostic");
  });
  it("validates language, complete source budget, funding, and model configuration before spending quota", async () => {
    expect((await generate(input({ action: "translate" }))).response.status).toBe(422);
    expect((await generate(input({ funding: "chatgpt" }))).response.status).toBe(503);
    await call("/api/ai/settings", "POST", {
      ...settings,
      models: { ...settings.models, api: { ...settings.models.api, fast: { id: "", maxCharacters: 1000 } } },
    });
    expect((await generate()).response.status).toBe(422);
    await call("/api/ai/settings", "POST", {
      ...settings,
      models: { ...settings.models, api: { ...settings.models.api, fast: { id: "test-fast", maxCharacters: 1000 } } },
    });
    await documentText("x".repeat(1001));
    expect((await generate()).response.status).toBe(413);
    expect(providerCalls).toHaveLength(0);
    expect((await (await call("/api/ai/status")).json<AiStatus>()).quota.remaining).toBe(20);
  });
  it("cancels the upstream stream, preserves partial history, and counts the started request once", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (resource: RequestInfo | URL, init?: RequestInit) => {
        if (String(resource).endsWith("/models")) return Response.json({ data: [{ id: "test-fast" }] });
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Partial cancelled draft" })}\n\n`,
                ),
              );
              init?.signal?.addEventListener(
                "abort",
                () => controller.error(new DOMException("Cancelled", "AbortError")),
                { once: true },
              );
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    const value = input(),
      context = createExecutionContext();
    const response = await worker.fetch(request("/api/ai/generate", "POST", value), bindings(), context);
    const reader = response.body!.getReader();
    await reader.read();
    const delta = await reader.read();
    expect(new TextDecoder().decode(delta.value)).toContain("Partial cancelled draft");
    expect((await call(`/api/ai/generations/${value.operationId}/cancel`, "POST", {})).status).toBe(200);
    await waitOnExecutionContext(context);
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("Generation cancelled");
    await reader.cancel();
    expect(
      await env.DB.prepare("SELECT output,status FROM ai_messages WHERE id=?").bind(value.operationId).first(),
    ).toEqual({ output: "Partial cancelled draft", status: "cancelled" });
    expect((await (await call("/api/ai/status")).json<AiStatus>()).quota.remaining).toBe(19);
  });
  it("stops an active stream when a supplied source is archived and hides the saved history", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (resource: RequestInfo | URL, init?: RequestInit) => {
        if (String(resource).endsWith("/models")) return Response.json({ data: [{ id: "test-fast" }] });
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Private partial draft" })}\n\n`,
                ),
              );
              init?.signal?.addEventListener(
                "abort",
                () => controller.error(new DOMException("Revoked", "AbortError")),
                { once: true },
              );
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    const context = createExecutionContext();
    const response = await worker.fetch(request("/api/ai/generate", "POST", input()), bindings(), context);
    const reader = response.body!.getReader();
    const start = JSON.parse(
      new TextDecoder()
        .decode((await reader.read()).value)
        .slice(6)
        .trim(),
    ) as Extract<AiStreamEvent, { type: "start" }>;
    await reader.read();
    await env.DB.prepare("UPDATE pages SET archived_at=1 WHERE id=?").bind(page.id).run();
    await waitOnExecutionContext(context);
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("conversation_locked");
    await reader.cancel();
    const saved = await (
      await call(`/api/ai/conversations/${start.conversationId}`)
    ).json<{ conversation: AiConversation }>();
    expect(saved.conversation.locked).toBe(true);
    expect(saved.conversation).not.toHaveProperty("messages");
    expect(JSON.stringify(saved)).not.toContain("Private partial draft");
  });
  it.each(["membership", "session"])("stops a running stream on live %s revocation", async (kind) => {
    const live = await liveGeneration();
    if (kind === "membership") {
      await anotherOwner();
      await env.DB.prepare("DELETE FROM workspace_members WHERE user_id=? AND workspace_id=?")
        .bind(member.user.id, member.workspace.id)
        .run();
    } else await env.DB.prepare("DELETE FROM session WHERE id=?").bind(member.session.id).run();
    await waitOnExecutionContext(live.context);
    const event = JSON.parse(
      new TextDecoder()
        .decode((await live.reader.read()).value)
        .slice(6)
        .trim(),
    );
    expect(event).toMatchObject({ type: "error", status: kind === "session" ? 401 : 403 });
    await live.reader.cancel();
  });
  it.each(["cancelled", "expired"])("prevents a late completion after the request is %s", async (kind) => {
    const live = await liveGeneration();
    live.send({ type: "response.output_text.delta", delta: "Partial saved text" });
    await live.reader.read();
    if (kind === "cancelled") await call(`/api/ai/generations/${live.value.operationId}/cancel`, "POST");
    else {
      await env.DB.prepare("UPDATE ai_messages SET created_at=? WHERE id=?")
        .bind(Date.now() - AI_GENERATION_DEADLINE_MS - 1, live.value.operationId)
        .run();
      await call(`/api/ai/conversations/${live.start.conversationId}/access`);
    }
    live.send({ type: "response.completed", response: { status: "completed" } });
    await waitOnExecutionContext(live.context);
    const event = new TextDecoder().decode((await live.reader.read()).value);
    expect(event).toContain('"type":"error"');
    expect(event).not.toContain('"type":"complete"');
    expect(
      await env.DB.prepare("SELECT status,output FROM ai_messages WHERE id=?").bind(live.value.operationId).first(),
    ).toEqual({ status: kind === "cancelled" ? "cancelled" : "failed", output: "Partial saved text" });
    await live.reader.cancel();
  });
  it("uses two SQL queries for the final live authorization check", async () => {
    const live = await liveGeneration();
    const original = env.DB.prepare.bind(env.DB),
      queries: string[] = [];
    vi.spyOn(env.DB, "prepare").mockImplementation((sql: string) => {
      queries.push(sql);
      return original(sql);
    });
    live.send({ type: "response.completed", response: { status: "completed" } });
    await waitOnExecutionContext(live.context);
    expect(new TextDecoder().decode((await live.reader.read()).value)).toContain('"type":"complete"');
    expect(queries.filter((sql) => sql.trimStart().startsWith("SELECT"))).toHaveLength(2);
    expect(queries.some((sql) => sql.startsWith("SELECT m.status"))).toBe(true);
    await live.reader.cancel();
  });
  it.each([1, 3])("withholds deltas during access failures and %i attempts", async (failures) => {
    const live = await liveGeneration();
    const original = env.DB.prepare.bind(env.DB);
    let attempts = 0,
      firstFailure!: () => void;
    const failed = new Promise<void>((resolve) => {
      firstFailure = resolve;
    });
    vi.spyOn(env.DB, "prepare").mockImplementation((sql: string) => {
      if (sql.startsWith("SELECT m.status") && ++attempts <= failures) {
        firstFailure();
        throw new Error("Transient D1 failure");
      }
      return original(sql);
    });
    await failed;
    live.send({ type: "response.output_text.delta", delta: "Withheld private text" });
    let released = false;
    const next = live.reader.read().then((value) => {
      released = true;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(released).toBe(false);
    const event = new TextDecoder().decode((await next).value);
    expect(event).toContain(failures === 1 ? '"type":"delta"' : "ai_access_unavailable");
    expect(attempts).toBe(failures === 1 ? 2 : 3);
    expect(event.includes("Withheld private text")).toBe(failures === 1);
    if (failures === 1) live.send({ type: "response.completed", response: { status: "completed" } });
    await waitOnExecutionContext(live.context);
    const terminal = failures === 1 ? new TextDecoder().decode((await live.reader.read()).value) : event;
    expect(terminal).toContain(failures === 1 ? '"type":"complete"' : "ai_access_unavailable");
    await live.reader.cancel();
  });
  it("lets effective viewers generate and copy, while refusing application and owner settings", async () => {
    await anotherOwner();
    await env.DB.prepare("UPDATE workspace_members SET role='editor' WHERE workspace_id=? AND user_id=?")
      .bind(member.workspace.id, member.user.id)
      .run();
    await env.DB.prepare("UPDATE spaces SET visibility='private' WHERE id=?").bind(page.spaceId).run();
    await env.DB.prepare("INSERT INTO space_members(space_id,user_id,role,created_at) VALUES(?,?,'viewer',1)")
      .bind(page.spaceId, member.user.id)
      .run();
    const result = await generate(),
      start = result.events[0] as Extract<AiStreamEvent, { type: "start" }>;
    expect(start.canApply).toBe(false);
    expect(result.events.at(-1)?.type).toBe("complete");
    expect((await call(`/api/ai/results/${start.messageId}/apply-check`, "POST", {})).status).toBe(403);
    expect((await call("/api/ai/settings", "POST", settings)).status).toBe(403);
  });
});
describe("writing failure contracts and stale recovery", () => {
  it.each([401, 403, 503])(
    "isolates model discovery HTTP %i from NoteFlare sign-in and preserves quota",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json({ error: "provider" }, { status })),
      );
      const response = await call("/api/ai/models?funding=api");
      expect(response.status).toBe(status === 503 ? 503 : 502);
      expect((await call("/api/me")).status).toBe(200);
      expect((await (await call("/api/ai/status")).json<AiStatus>()).quota.remaining).toBe(20);
    },
  );
  it("invalidates model access on upstream credential rejection and refunds only confirmed rejection", async () => {
    providerStatus = 401;
    const result = await generate();
    expect(result.events.at(-1)).toMatchObject({ type: "error", status: 502 });
    expect((await (await call("/api/ai/status")).json<AiStatus>()).quota.remaining).toBe(20);
    const fetcher = vi.mocked(fetch);
    const modelCount = () => fetcher.mock.calls.filter(([resource]) => String(resource).endsWith("/models")).length;
    expect(modelCount()).toBe(1);
    await call("/api/ai/models?funding=api");
    expect(modelCount()).toBe(2);
    providerStatus = 503;
    expect((await generate()).events.at(-1)).toMatchObject({ type: "error", status: 503 });
    expect((await (await call("/api/ai/status")).json<AiStatus>()).quota.remaining).toBe(19);
  });
  it("keeps actual session failure a NoteFlare 401", async () => {
    await env.DB.prepare("DELETE FROM session WHERE id=?").bind(member.session.id).run();
    expect((await call("/api/ai/models?funding=api")).status).toBe(401);
    expect((await generate()).response.status).toBe(401);
    expect(providerCalls).toHaveLength(0);
  });
  it.each(["read", "open", "access", "follow-up"])(
    "recovers an abandoned request during %s without cron, preserving output and receipts",
    async (kind) => {
      const value = input(),
        first = await generate(value);
      const start = first.events[0] as Extract<AiStreamEvent, { type: "start" }>;
      await env.DB.prepare("UPDATE ai_messages SET status='running',created_at=?,output='Saved partial' WHERE id=?")
        .bind(Date.now() - AI_GENERATION_DEADLINE_MS - 1, value.operationId)
        .run();
      const suffix = kind === "read" ? "" : `/${kind}`;
      const response =
        kind === "follow-up"
          ? (await generate(input({ conversationId: start.conversationId }))).response
          : await call(`/api/ai/conversations/${start.conversationId}${suffix}`, kind === "open" ? "POST" : "GET");
      expect(response.ok).toBe(true);
      expect(
        await env.DB.prepare("SELECT status,output FROM ai_messages WHERE id=?").bind(value.operationId).first(),
      ).toEqual({ status: "failed", output: "Saved partial" });
      expect(
        await env.DB.prepare("SELECT counted FROM ai_requests WHERE id=?").bind(value.operationId).first(),
      ).toEqual({ counted: 1 });
      expect((await (await call("/api/ai/status")).json<AiStatus>()).quota.remaining).toBe(
        kind === "follow-up" ? 18 : 19,
      );
    },
  );
  it("exposes and cancels saved running work without extending retention", async () => {
    const value = input(),
      first = await generate(value),
      start = first.events[0] as Extract<AiStreamEvent, { type: "start" }>;
    const createdAt = Date.now(),
      yesterday = createdAt - 86400000;
    await env.DB.prepare("UPDATE ai_messages SET status='running',created_at=? WHERE id=?")
      .bind(createdAt, value.operationId)
      .run();
    await env.DB.prepare("UPDATE ai_conversations SET updated_at=? WHERE id=?")
      .bind(yesterday, start.conversationId)
      .run();
    const response = await call(`/api/ai/conversations/${start.conversationId}/access`);
    expect(await response.json()).toMatchObject({
      activeGeneration: { messageId: value.operationId, createdAt, deadlineAt: createdAt + AI_GENERATION_DEADLINE_MS },
    });
    expect((await generate(input({ conversationId: start.conversationId }))).response.status).toBe(409);
    expect((await call(`/api/ai/generations/${value.operationId}/cancel`, "POST")).status).toBe(200);
    expect(
      await env.DB.prepare("SELECT updated_at FROM ai_conversations WHERE id=?").bind(start.conversationId).first(),
    ).toEqual({ updated_at: yesterday });
    expect(
      (await (await call(`/api/ai/conversations/${start.conversationId}/access`)).json<AiConversationAccess>())
        .activeGeneration,
    ).toBeNull();
    expect((await generate(input({ conversationId: start.conversationId }))).events.at(-1)).toEqual({
      type: "complete",
    });
  });
  it("admits only one concurrent follow-up after stale recovery", async () => {
    const value = input(),
      first = await generate(value),
      start = first.events[0] as Extract<AiStreamEvent, { type: "start" }>;
    await env.DB.prepare("UPDATE ai_messages SET status='running',created_at=? WHERE id=?")
      .bind(Date.now() - AI_GENERATION_DEADLINE_MS - 1, value.operationId)
      .run();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (resource: RequestInfo | URL, init?: RequestInit) => {
        if (String(resource).endsWith("/responses")) await gate;
        return original(resource, init);
      }),
    );
    const contexts = [createExecutionContext(), createExecutionContext()];
    const responses = await Promise.all(
      contexts.map((context) =>
        worker.fetch(
          request("/api/ai/generate", "POST", input({ conversationId: start.conversationId })),
          bindings(),
          context,
        ),
      ),
    );
    expect(responses.map((response) => response.status).sort((a, b) => a - b)).toEqual([200, 409]);
    release();
    await Promise.all(responses.map((response) => response.text()));
    await Promise.all(contexts.map(waitOnExecutionContext));
    expect((await (await call("/api/ai/status")).json<AiStatus>()).quota.remaining).toBe(18);
  });
});
describe("private conversation retention and sources", () => {
  it("searches only the author's readable history; opening extends expiry but reads and listing do not", async () => {
    const result = await generate(input({ prompt: "Secret writing instruction" })),
      start = result.events[0] as Extract<AiStreamEvent, { type: "start" }>;
    const yesterday = Date.now() - 86400000;
    await env.DB.prepare("UPDATE ai_conversations SET updated_at=? WHERE id=?")
      .bind(yesterday, start.conversationId)
      .run();
    await call("/api/ai/conversations?q=Secret");
    await call(`/api/ai/conversations/${start.conversationId}`);
    await call(`/api/ai/conversations/${start.conversationId}/access`);
    expect(
      await env.DB.prepare("SELECT updated_at FROM ai_conversations WHERE id=?").bind(start.conversationId).first(),
    ).toEqual({ updated_at: yesterday });
    await call(`/api/ai/conversations/${start.conversationId}/open`, "POST", {});
    expect(
      (await env.DB.prepare("SELECT updated_at FROM ai_conversations WHERE id=?")
        .bind(start.conversationId)
        .first<{ updated_at: number }>())!.updated_at,
    ).toBeGreaterThan(yesterday);
    await anotherOwner();
    await env.DB.prepare(
      "INSERT INTO ai_conversations VALUES('foreign',?,'other-owner',?,'Foreign private title','[]',?)",
    )
      .bind(member.workspace.id, page.id, Date.now())
      .run();
    const listed = await (await call("/api/ai/conversations?q=Foreign")).json<{ conversations: AiConversation[] }>();
    expect(listed.conversations).toEqual([]);
    expect((await call("/api/ai/conversations/foreign/open", "POST", {})).status).toBe(404);
  });
  it("locks the cumulative union of referenced pages, restores access, expires irreversibly, and deletes history", async () => {
    const created = await (
      await call("/api/pages", "POST", { title: "Reference", kind: "document", spaceId: page.spaceId })
    ).json<{ page: Page }>();
    const first = await generate(
        input({
          sources: [
            { pageId: page.id, scope: { kind: "page" } },
            { pageId: created.page.id, scope: { kind: "page" } },
          ],
        }),
      ),
      start = first.events[0] as Extract<AiStreamEvent, { type: "start" }>;
    await generate(
      input({
        conversationId: start.conversationId,
        prompt: "Refine again",
        sources: [{ pageId: page.id, scope: { kind: "page" } }],
      }),
    );
    await env.DB.prepare("UPDATE pages SET archived_at=1 WHERE id=?").bind(created.page.id).run();
    const locked = await (
      await call(`/api/ai/conversations/${start.conversationId}/open`, "POST", {})
    ).json<{ conversation: AiConversation }>();
    expect(locked.conversation).toMatchObject({ locked: true, title: "Unavailable conversation" });
    expect(locked.conversation).not.toHaveProperty("messages");
    expect((await generate(input({ conversationId: start.conversationId }))).response.status).toBe(403);
    await env.DB.prepare("UPDATE pages SET archived_at=NULL WHERE id=?").bind(created.page.id).run();
    expect(
      (await (await call(`/api/ai/conversations/${start.conversationId}`)).json<{ conversation: AiConversation }>())
        .conversation.locked,
    ).toBe(false);
    await env.DB.prepare("UPDATE ai_conversations SET updated_at=? WHERE id=?")
      .bind(Date.now() - AI_RETENTION_MS - 1, start.conversationId)
      .run();
    expect((await call(`/api/ai/conversations/${start.conversationId}/open`, "POST", {})).status).toBe(404);
    await pruneAi(env);
    expect(
      await env.DB.prepare("SELECT id FROM ai_conversations WHERE id=?").bind(start.conversationId).first(),
    ).toBeNull();
    await generate();
    await call("/api/ai/conversations", "DELETE");
    expect(await env.DB.prepare("SELECT COUNT(*) count FROM ai_messages").first()).toEqual({ count: 0 });
  });
  it("reloads sources on follow-up and rejects a lost selection instead of silently substituting text", async () => {
    const first = await generate(),
      start = first.events[0] as Extract<AiStreamEvent, { type: "start" }>;
    await documentText("Updated source paragraph");
    const follow = await generate(input({ conversationId: start.conversationId }));
    expect((follow.events[0] as Extract<AiStreamEvent, { type: "start" }>).changedPageIds).toContain(page.id);
    expect(JSON.stringify(providerCalls.at(-1)?.input)).toContain("Updated source paragraph");
    expect(
      (
        await generate(
          input({
            sources: [
              {
                pageId: page.id,
                scope: {
                  kind: "selection",
                  blockIds: ["selected"],
                  text: "Original source",
                  contentEpoch: page.contentEpoch,
                },
              },
            ],
          }),
        )
      ).response.status,
    ).toBe(409);
    expect(
      (
        await generate(
          input({
            sources: [
              { pageId: page.id, scope: { kind: "blocks", blockIds: ["deleted"], contentEpoch: page.contentEpoch } },
            ],
          }),
        )
      ).response.status,
    ).toBe(409);
  });
  it("purges private history, preferences, credentials, and quota receipts on membership removal", async () => {
    await generate();
    await anotherOwner();
    await env.DB.prepare(
      "INSERT INTO ai_connections(workspace_id,user_id,subject,label,tokens_ciphertext,expires_at) VALUES(?,?,'sub','Account','cipher',1)",
    )
      .bind(member.workspace.id, member.user.id)
      .run();
    expect((await call(`/api/members/${member.user.id}`, "DELETE")).status).toBe(200);
    for (const table of ["ai_connections", "ai_preferences", "ai_conversations", "ai_messages", "ai_requests"])
      expect(await env.DB.prepare(`SELECT COUNT(*) count FROM ${table}`).first()).toEqual({ count: 0 });
  });
  it("reads complete typed tables, filters explicitly, and binds MCP pagination to revision, query, and actor", async () => {
    const table = (
      await (
        await call("/api/pages", "POST", { kind: "table", title: "Typed data", spaceId: page.spaceId })
      ).json<{ page: Page }>()
    ).page;
    await env.DB.prepare("DELETE FROM table_columns WHERE page_id=?").bind(table.id).run();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO table_columns VALUES('text-column',?,'Text','text',0)").bind(table.id),
      env.DB.prepare("INSERT INTO table_columns VALUES('number-column',?,'Number','number',1)").bind(table.id),
    ]);
    for (let index = 0; index < 55; index++)
      await env.DB.batch([
        env.DB.prepare("INSERT INTO table_rows VALUES(?,?,?,?,?,?)").bind(
          `row-${index}`,
          table.id,
          index,
          member.user.id,
          1,
          1,
        ),
        env.DB.prepare(
          "INSERT INTO table_cells(row_id,column_id,text_value,updated_at) VALUES(?,'text-column',?,1)",
        ).bind(`row-${index}`, index === 2 ? "special" : `Text ${index}`),
        env.DB.prepare(
          "INSERT INTO table_cells(row_id,column_id,number_value,updated_at) VALUES(?,'number-column',?,1)",
        ).bind(`row-${index}`, index),
      ]);
    const source = await readAiSource(env, member, { pageId: table.id, scope: { kind: "page" } });
    expect(JSON.parse(source.text).rows).toHaveLength(55);
    const filtered = await readAiSource(env, member, { pageId: table.id, scope: { kind: "table", filter: "special" } });
    expect(JSON.parse(filtered.text).rows).toHaveLength(1);
    const first = await fetchTableSource(env, member, "grant-one", { page_id: table.id });
    expect(first.rows).toHaveLength(50);
    expect(first.complete).toBe(false);
    expect(first.rows[0]?.cells["number-column"]).toBe(0);
    const next = await fetchTableSource(env, member, "grant-one", { page_id: table.id, cursor: first.nextCursor! });
    expect(next.rows).toHaveLength(5);
    expect(next.complete).toBe(true);
    await expect(
      fetchTableSource(env, member, "grant-two", { page_id: table.id, cursor: first.nextCursor! }),
    ).rejects.toMatchObject({ code: "invalid_source_cursor" });
    await expect(
      fetchTableSource(env, member, "grant-one", { page_id: table.id, filter: "special", cursor: first.nextCursor! }),
    ).rejects.toMatchObject({ code: "invalid_source_cursor" });
    await env.DB.prepare("UPDATE table_state SET revision=revision+1 WHERE page_id=?").bind(table.id).run();
    await expect(
      fetchTableSource(env, member, "grant-one", { page_id: table.id, cursor: first.nextCursor! }),
    ).rejects.toMatchObject({ code: "source_changed" });
    expect(JSON.stringify(first)).not.toMatch(/lease|session|holder/);
  });
  it("reads diagram labels and relationships without assets and rejects a changing diagram cursor", async () => {
    const diagram = (
      await (
        await call("/api/pages", "POST", { kind: "diagram", title: "Diagram", spaceId: page.spaceId })
      ).json<{ page: Page }>()
    ).page;
    const room = env.DOCUMENT.getByName(`${diagram.id}~${diagram.contentEpoch}`);
    await room.fetch(
      new Request("https://document.internal/content", { headers: { "x-notes-internal": env.BETTER_AUTH_SECRET } }),
    );
    await runInDurableObject(room, async (instance) => {
      const object = instance as unknown as { document: Y.Doc; compact(): Promise<void> };
      const roots = diagramRoots(object.document);
      object.document.transact(() => {
        for (let index = 0; index < 251; index++)
          roots.nodes.set(
            `node-${index}`,
            diagramNodeMap({
              id: `node-${index}`,
              type: "image",
              label: `Node ${index}`,
              notes: "Textual notes",
              parentId: null,
              assetId: "excluded-private-asset",
              references: [{ id: page.id, label: "Document reference" }],
              mentions: [],
              x: 0,
              y: 0,
              width: 100,
              height: 100,
              zIndex: 0,
              color: "slate",
            }),
          );
      });
      await object.compact();
    });
    const source = await readAiSource(env, member, {
      pageId: diagram.id,
      scope: { kind: "diagram", nodeIds: ["node-1"] },
    });
    expect(JSON.parse(source.text).nodes).toHaveLength(1);
    expect(source.text).not.toContain("excluded-private-asset");
    const first = await fetchDiagramSource(env, member, "grant", { page_id: diagram.id });
    expect(first.items.length).toBeGreaterThan(0);
    expect(first.complete).toBe(false);
    expect(
      (await fetchDiagramSource(env, member, "grant", { page_id: diagram.id, cursor: first.nextCursor! })).complete,
    ).toBe(true);
    await env.DB.prepare("UPDATE pages SET content_epoch=content_epoch+1 WHERE id=?").bind(diagram.id).run();
    await expect(
      fetchDiagramSource(env, member, "grant", { page_id: diagram.id, cursor: first.nextCursor! }),
    ).rejects.toMatchObject({ code: "source_changed" });
  });
});
