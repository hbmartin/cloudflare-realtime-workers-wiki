import {
  AI_ACTIONS,
  AI_MAX_CHARACTERS,
  AI_GENERATION_TIMEOUT_MS,
  AI_GENERATION_DEADLINE_MS,
  type AiConversationAccess,
  AI_RETENTION_MS,
  aiGenerateSchema,
  aiInstructions,
  aiSettingsSchema,
  type AiConversation,
  type AiMessage,
  type AiSettings,
  type AiSource,
  type AiSourceSnapshot,
  type AiStatus,
  type AiStreamEvent,
} from "../shared/ai";
import { readSse } from "../shared/sse";
import type { Env, MemberContext } from "./env";
import { requireMember, requireOwner } from "./auth";
import { HttpError, sha256, assertSameOrigin } from "./http";
import { chatgptAccessToken, chatgptConfigured } from "./ai-auth";
import { seal, unseal } from "./ai-auth";
import { readAiSource } from "./ai-sources";
import { pageForMember, spaceVisibleSql } from "./page-access";
import { requireSecurity } from "./security";
import { providerModels, invalidateProviderModels } from "./ai-models";
import { readRoomContent } from "./ai-sources";
import type { DocumentContentEnvelope } from "../shared/types";
import { protectedCommentBlockIds } from "./comments";

const DAY = 86_400_000;
const DEFAULT_SETTINGS: AiSettings = {
  enabled: false,
  apiEnabled: false,
  dailyQuota: 20,
  models: {
    chatgpt: { fast: { id: "", maxCharacters: 60_000 }, best: { id: "", maxCharacters: 100_000 } },
    api: { fast: { id: "", maxCharacters: 60_000 }, best: { id: "", maxCharacters: 100_000 } },
  },
};
type ConversationRow = {
  id: string;
  workspace_id: string;
  user_id: string;
  page_id: string;
  title: string;
  sources_json: string;
  updated_at: number;
};
type MessageRow = {
  id: string;
  conversation_id: string;
  request_hash: string;
  action: AiMessage["action"];
  prompt: string;
  output: string;
  status: AiMessage["status"];
  funding: AiMessage["funding"];
  quality: AiMessage["quality"];
  sources_json: string;
  created_at: number;
};
const json = (value: unknown) => Response.json(value, { headers: { "cache-control": "private, no-store" } });

async function aiBody(request: Request) {
  if (!request.body) throw new HttpError(422, "invalid_input", "A JSON body is required.");
  const reader = request.body.getReader();
  let text = "",
    bytes = 0;
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 1_100_000) throw new HttpError(413, "ai_request_too_large", "Reduce the prompt or source selection.");
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new HttpError(422, "invalid_input", "Provide valid JSON.");
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
async function aiSettings(env: Env, member: MemberContext) {
  const row = await env.DB.prepare("SELECT settings_json FROM ai_settings WHERE workspace_id=?")
    .bind(member.workspace.id)
    .first<{ settings_json: string }>();
  return row ? aiSettingsSchema.parse(JSON.parse(row.settings_json)) : DEFAULT_SETTINGS;
}
async function quota(env: Env, member: MemberContext, settings: AiSettings): Promise<AiStatus["quota"]> {
  const day = Math.floor(Date.now() / DAY);
  const row = await env.DB.prepare(
    "SELECT COUNT(*) used FROM ai_requests WHERE workspace_id=? AND user_id=? AND day=? AND funding='api' AND counted=1",
  )
    .bind(member.workspace.id, member.user.id, day)
    .first<{ used: number }>();
  return {
    remaining: Math.max(0, settings.dailyQuota - (row?.used ?? 0)),
    limit: settings.dailyQuota,
    resetsAt: (day + 1) * DAY,
  };
}
export async function aiStatusResponse(request: Request, env: Env) {
  const member = await requireMember(request, env);
  const settings = await aiSettings(env, member);
  const connection = await env.DB.prepare("SELECT label FROM ai_connections WHERE workspace_id=? AND user_id=?")
    .bind(member.workspace.id, member.user.id)
    .first<{ label: string }>();
  const preference = await env.DB.prepare("SELECT funding FROM ai_preferences WHERE workspace_id=? AND user_id=?")
    .bind(member.workspace.id, member.user.id)
    .first<{ funding: AiStatus["preference"] }>();
  return json({
    settings,
    chatgptConfigured: chatgptConfigured(env),
    apiConfigured: !!env.OPENAI_API_KEY,
    connected: !!connection,
    accountLabel: connection?.label ?? null,
    preference: preference?.funding ?? null,
    quota: await quota(env, member, settings),
  } satisfies AiStatus);
}
export async function setAiSettings(request: Request, env: Env) {
  assertSameOrigin(request, env.BETTER_AUTH_URL);
  const member = await requireMember(request, env);
  requireOwner(member);
  const parsed = aiSettingsSchema.safeParse(await aiBody(request));
  if (!parsed.success)
    throw new HttpError(422, "invalid_ai_settings", "Choose valid models, context limits, and a daily quota.");
  await env.DB.prepare(
    "INSERT INTO ai_settings VALUES (?,?) ON CONFLICT(workspace_id) DO UPDATE SET settings_json=excluded.settings_json",
  )
    .bind(member.workspace.id, JSON.stringify(parsed.data))
    .run();
  return json({ ok: true });
}
async function conversationRow(env: Env, member: MemberContext, id: string) {
  const row = await env.DB.prepare(
    "SELECT * FROM ai_conversations WHERE id=? AND workspace_id=? AND user_id=? AND updated_at>?",
  )
    .bind(id, member.workspace.id, member.user.id, Date.now() - AI_RETENTION_MS)
    .first<ConversationRow>();
  if (!row) throw new HttpError(404, "conversation_not_found", "This conversation was deleted or expired.");
  return row;
}
function conversationLockSql(workspace: string, user: string, conversation: string, role = "?") {
  return `EXISTS(SELECT 1 FROM ai_conversation_pages cp LEFT JOIN pages p ON p.id=cp.page_id AND p.workspace_id=${workspace} LEFT JOIN spaces s ON s.id=p.space_id AND s.workspace_id=p.workspace_id LEFT JOIN space_members sm ON sm.space_id=s.id AND sm.user_id=${user} WHERE cp.conversation_id=${conversation} AND (p.id IS NULL OR p.archived_at IS NOT NULL OR p.import_job_id IS NOT NULL OR s.id IS NULL OR NOT ${spaceVisibleSql(role)}))`;
}
async function conversationLocked(env: Env, member: MemberContext, id: string) {
  const row = await env.DB.prepare(`SELECT ${conversationLockSql("?", "?", "?")} locked`)
    .bind(member.workspace.id, member.user.id, id, member.role)
    .first<{ locked: number }>();
  return !!row?.locked;
}
async function expireGenerations(env: Env, member: MemberContext, id: string) {
  const cutoff = Date.now() - AI_GENERATION_DEADLINE_MS;
  const expired = await env.DB.prepare(
    "SELECT 1 FROM ai_messages WHERE status='running' AND created_at<=? AND conversation_id IN (SELECT id FROM ai_conversations WHERE id=? AND workspace_id=? AND user_id=?) LIMIT 1",
  )
    .bind(cutoff, id, member.workspace.id, member.user.id)
    .first();
  if (!expired) return;
  await env.DB.prepare(
    "UPDATE ai_messages SET status='failed' WHERE status='running' AND created_at<=? AND conversation_id IN (SELECT id FROM ai_conversations WHERE id=? AND workspace_id=? AND user_id=?)",
  )
    .bind(cutoff, id, member.workspace.id, member.user.id)
    .run();
}
function conversationJson(row: ConversationRow, locked: boolean): AiConversation {
  return {
    id: row.id,
    pageId: row.page_id,
    title: locked ? "Unavailable conversation" : row.title,
    locked,
    updatedAt: row.updated_at,
    expiresAt: row.updated_at + AI_RETENTION_MS,
  };
}
function messageJson(row: MessageRow): AiMessage {
  return {
    id: row.id,
    action: row.action,
    prompt: row.prompt,
    output: row.output,
    status: row.status,
    funding: row.funding,
    quality: row.quality,
    sources: JSON.parse(row.sources_json),
    createdAt: row.created_at,
  };
}
export async function listAiConversations(request: Request, env: Env) {
  const member = await requireMember(request, env);
  const url = new URL(request.url),
    query = (url.searchParams.get("q") ?? "").trim().slice(0, 200),
    pageId = url.searchParams.get("pageId");
  const binding = `ai-history:${member.workspace.id}:${member.user.id}:${pageId ?? ""}:${query}`;
  let cursor: { time: number; id: string; expires: number } | null = null;
  if (url.searchParams.has("cursor")) {
    try {
      cursor = await unseal(env.BETTER_AUTH_SECRET, binding, url.searchParams.get("cursor")!);
      if (!cursor || cursor.expires < Date.now()) throw new Error("Expired.");
    } catch {
      throw new HttpError(422, "invalid_history_cursor", "Refresh history to continue browsing.");
    }
  }
  // Access and search are evaluated in the same statement. A locked title or
  // output cannot leak through the search result count or pagination.
  const rows = await env.DB.prepare(`WITH entries AS (
    SELECT c.*, ${conversationLockSql("c.workspace_id", "c.user_id", "c.id")} locked
    FROM ai_conversations c WHERE c.workspace_id=? AND c.user_id=? AND c.updated_at>? AND (? IS NULL OR c.page_id=?) AND (? IS NULL OR c.updated_at<? OR (c.updated_at=? AND c.id>?)))
    SELECT * FROM entries WHERE ?='' OR (locked=0 AND (instr(lower(title),lower(?))>0 OR EXISTS(SELECT 1 FROM ai_messages WHERE conversation_id=entries.id AND (instr(lower(prompt),lower(?))>0 OR instr(lower(output),lower(?))>0)))) ORDER BY updated_at DESC,id LIMIT 51`)
    .bind(
      member.role,
      member.workspace.id,
      member.user.id,
      Date.now() - AI_RETENTION_MS,
      pageId,
      pageId,
      cursor?.time ?? null,
      cursor?.time ?? null,
      cursor?.time ?? null,
      cursor?.id ?? null,
      query,
      query,
      query,
      query,
    )
    .all<ConversationRow & { locked: number }>();
  const visible = rows.results.slice(0, 50),
    last = visible.at(-1);
  return json({
    conversations: visible.map((row) => conversationJson(row, !!row.locked)),
    nextCursor:
      rows.results.length > 50 && last
        ? await seal(env.BETTER_AUTH_SECRET, binding, {
            time: last.updated_at,
            id: last.id,
            expires: Date.now() + 15 * 60_000,
          })
        : null,
  });
}
export async function aiConversationAccess(request: Request, env: Env, id: string) {
  const member = await requireMember(request, env),
    row = await conversationRow(env, member, id);
  await expireGenerations(env, member, id);
  const locked = await conversationLocked(env, member, id);
  const active = locked
    ? null
    : await env.DB.prepare("SELECT id,created_at FROM ai_messages WHERE conversation_id=? AND status='running'")
        .bind(id)
        .first<{ id: string; created_at: number }>();
  return json({
    locked,
    expiresAt: row.updated_at + AI_RETENTION_MS,
    activeGeneration: active
      ? {
          messageId: active.id,
          createdAt: active.created_at,
          deadlineAt: active.created_at + AI_GENERATION_DEADLINE_MS,
        }
      : null,
  } satisfies AiConversationAccess);
}
export async function openAiConversation(request: Request, env: Env, id: string, touch = true) {
  if (touch) assertSameOrigin(request, env.BETTER_AUTH_URL);
  const member = await requireMember(request, env),
    row = await conversationRow(env, member, id);
  await expireGenerations(env, member, id);
  const locked = await conversationLocked(env, member, id);
  if (touch) {
    const opened = Date.now();
    const touched = await env.DB.prepare(
      "UPDATE ai_conversations SET updated_at=? WHERE id=? AND workspace_id=? AND user_id=? AND updated_at>? RETURNING updated_at",
    )
      .bind(opened, id, member.workspace.id, member.user.id, opened - AI_RETENTION_MS)
      .first<{ updated_at: number }>();
    if (!touched) throw new HttpError(404, "conversation_not_found", "This conversation expired.");
    row.updated_at = touched.updated_at;
  }
  if (locked) return json({ conversation: conversationJson(row, true) });
  const messages = await env.DB.prepare("SELECT * FROM ai_messages WHERE conversation_id=? ORDER BY created_at,id")
    .bind(id)
    .all<MessageRow>();
  return json({
    conversation: {
      ...conversationJson(row, false),
      sources: JSON.parse(row.sources_json) as AiSource[],
      messages: messages.results.map(messageJson),
    } satisfies AiConversation,
  });
}
export async function deleteAiConversations(request: Request, env: Env, id?: string) {
  assertSameOrigin(request, env.BETTER_AUTH_URL);
  const member = await requireMember(request, env);
  await env.DB.prepare("DELETE FROM ai_conversations WHERE workspace_id=? AND user_id=? AND (? IS NULL OR id=?)")
    .bind(member.workspace.id, member.user.id, id ?? null, id ?? null)
    .run();
  return json({ ok: true });
}
export async function cancelAiGeneration(request: Request, env: Env, id: string) {
  assertSameOrigin(request, env.BETTER_AUTH_URL);
  const member = await requireMember(request, env);
  await env.DB.prepare(
    "UPDATE ai_messages SET status='cancelled' WHERE id=? AND status='running' AND conversation_id IN (SELECT id FROM ai_conversations WHERE workspace_id=? AND user_id=?)",
  )
    .bind(id, member.workspace.id, member.user.id)
    .run();
  return json({ ok: true });
}
export async function checkAiApply(request: Request, env: Env, id: string) {
  assertSameOrigin(request, env.BETTER_AUTH_URL);
  const member = await requireMember(request, env);
  const message = await env.DB.prepare(
    "SELECT m.*,c.page_id FROM ai_messages m JOIN ai_conversations c ON c.id=m.conversation_id WHERE m.id=? AND c.workspace_id=? AND c.user_id=? AND c.updated_at>?",
  )
    .bind(id, member.workspace.id, member.user.id, Date.now() - AI_RETENTION_MS)
    .first<MessageRow & { page_id: string }>();
  if (!message) throw new HttpError(404, "conversation_not_found", "The result was deleted or expired.");
  if (message.status !== "complete")
    throw new HttpError(409, "ai_result_incomplete", "Only completed results can be applied.");
  if (await conversationLocked(env, member, message.conversation_id))
    throw new HttpError(403, "conversation_locked", "A referenced page is no longer accessible.");
  const page = await pageForMember(env, member, message.page_id);
  if (page.effective_role === "viewer")
    throw new HttpError(403, "read_only", "Your role in this space is read-only. You can copy the result.");
  const envelope = await readRoomContent<DocumentContentEnvelope>(env, member, page);
  return json({
    contentEpoch: page.content_epoch,
    protectedBlockIds: [...(await protectedCommentBlockIds(env, page.id, envelope.document))],
  });
}
export async function pruneAi(env: Env) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM ai_conversations WHERE updated_at<=?").bind(Date.now() - AI_RETENTION_MS),
    env.DB.prepare("DELETE FROM ai_oauth_states WHERE expires_at<=?").bind(Date.now()),
    env.DB.prepare("DELETE FROM ai_requests WHERE created_at<=?").bind(Date.now() - AI_RETENTION_MS),
    env.DB.prepare("UPDATE ai_messages SET status='failed' WHERE status='running' AND created_at<?").bind(
      Date.now() - AI_GENERATION_DEADLINE_MS,
    ),
  ]);
}
function sourceMetadata(source: AiSourceSnapshot) {
  const { text: _text, ...metadata } = source;
  return metadata;
}
export async function aiModelAvailability(request: Request, env: Env) {
  const member = await requireMember(request, env),
    settings = await aiSettings(env, member);
  const funding = new URL(request.url).searchParams.get("funding");
  if (funding !== "chatgpt" && funding !== "api")
    throw new HttpError(422, "invalid_funding", "Choose a funding source.");
  if (!settings.enabled || (funding === "api" && (!settings.apiEnabled || !env.OPENAI_API_KEY)))
    return json({ fast: false, best: false });
  const token = funding === "api" ? env.OPENAI_API_KEY! : await chatgptAccessToken(env, member);
  const models = await providerModels(member.workspace.id, token, funding);
  return json({
    fast: models.some((model) => model.id === settings.models[funding].fast.id),
    best: models.some((model) => model.id === settings.models[funding].best.id),
  });
}
export async function setAiPreference(request: Request, env: Env) {
  assertSameOrigin(request, env.BETTER_AUTH_URL);
  const member = await requireMember(request, env),
    value = (await aiBody(request)) as { funding?: unknown };
  if (value?.funding !== "api" && value?.funding !== "chatgpt")
    throw new HttpError(422, "invalid_funding", "Choose a funding source.");
  await env.DB.prepare(
    "INSERT INTO ai_preferences VALUES(?,?,?) ON CONFLICT(workspace_id,user_id) DO UPDATE SET funding=excluded.funding",
  )
    .bind(member.workspace.id, member.user.id, value.funding)
    .run();
  return json({ ok: true });
}
function streamResponse(
  run: (send: (event: AiStreamEvent) => void, signal: AbortSignal) => Promise<void>,
  context: Pick<ExecutionContext, "waitUntil">,
) {
  const abort = new AbortController();
  let ended = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: AiStreamEvent) => {
        if (!ended) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      const pump = run(send, abort.signal)
        .catch(() => {
          send({
            type: "error",
            code: "ai_stream_failed",
            message: "Generation stopped unexpectedly. Partial text can be copied. Retry explicitly.",
          });
        })
        .finally(() => {
          if (!ended) {
            ended = true;
            controller.close();
          }
        });
      context.waitUntil(pump);
    },
    cancel() {
      ended = true;
      abort.abort();
    },
  });
  return new Response(body, {
    headers: { "content-type": "text/event-stream", "cache-control": "private, no-store", "x-accel-buffering": "no" },
  });
}
export async function generateAi(request: Request, env: Env, context: Pick<ExecutionContext, "waitUntil">) {
  assertSameOrigin(request, env.BETTER_AUTH_URL);
  const member = await requireMember(request, env);
  const parsed = aiGenerateSchema.safeParse(await aiBody(request));
  if (!parsed.success)
    throw new HttpError(422, "invalid_ai_request", parsed.error.issues[0]?.message ?? "Check the writing request.");
  const input = parsed.data,
    settings = await aiSettings(env, member);
  if (!settings.enabled) throw new HttpError(503, "ai_disabled", "An owner has disabled AI writing.");
  const page = await pageForMember(env, member, input.pageId);
  if (page.kind !== "document") throw new HttpError(422, "document_required", "Start writing from a document page.");
  if (input.funding === "api" && (!settings.apiEnabled || !env.OPENAI_API_KEY))
    throw new HttpError(503, "api_funding_unavailable", "Workspace API funding is unavailable. Contact an owner.");
  if (input.funding === "chatgpt" && !chatgptConfigured(env))
    throw new HttpError(503, "chatgpt_unavailable", "ChatGPT plan funding is not configured for this installation.");
  const model = settings.models[input.funding][input.quality];
  if (!model.id) throw new HttpError(422, "ai_model_unconfigured", "An owner must configure this quality mode.");
  const hash = await sha256(JSON.stringify(input));
  const existing = await env.DB.prepare(
    "SELECT r.workspace_id,r.user_id,r.request_hash receipt_hash,m.* FROM ai_requests r LEFT JOIN ai_messages m ON m.id=r.id WHERE r.id=?",
  )
    .bind(input.operationId)
    .first<MessageRow & { workspace_id: string; user_id: string; receipt_hash: string }>();
  if (existing) {
    if (
      existing.workspace_id !== member.workspace.id ||
      existing.user_id !== member.user.id ||
      existing.receipt_hash !== hash
    )
      throw new HttpError(409, "ai_operation_conflict", "Use a new operation ID for a different request.");
    if (!existing.conversation_id)
      throw new HttpError(
        409,
        "ai_operation_deleted",
        "This request belongs to a deleted conversation. Start a new request.",
      );
    await conversationRow(env, member, existing.conversation_id);
    if (await conversationLocked(env, member, existing.conversation_id))
      throw new HttpError(403, "conversation_locked", "Access to a referenced page was removed.");
    if (existing.status !== "complete")
      throw new HttpError(
        409,
        "ai_operation_used",
        "This request already started. Open its saved result or retry with a new request.",
      );
    return streamResponse(async (send) => {
      send({
        type: "start",
        conversationId: existing.conversation_id,
        messageId: existing.id,
        sources: JSON.parse(existing.sources_json),
        changedPageIds: [],
        canApply: page.effective_role !== "viewer",
        quota: await quota(env, member, settings),
      });
      send({ type: "delta", text: existing.output });
      send({ type: "complete" });
    }, context);
  }
  const conversationId = input.conversationId ?? crypto.randomUUID();
  let history: MessageRow[] = [];
  if (input.conversationId) {
    const conversation = await conversationRow(env, member, conversationId);
    await expireGenerations(env, member, conversationId);
    if (conversation.page_id !== page.id)
      throw new HttpError(422, "conversation_page_mismatch", "Continue from the conversation's original document.");
    if (await conversationLocked(env, member, conversationId))
      throw new HttpError(
        403,
        "conversation_locked",
        "Access to a referenced page was removed. This conversation is locked.",
      );
    history = (
      await env.DB.prepare("SELECT * FROM ai_messages WHERE conversation_id=? ORDER BY created_at,id")
        .bind(conversationId)
        .all<MessageRow>()
    ).results;
    if (history.some((message) => message.status === "running"))
      throw new HttpError(409, "generation_running", "Cancel the active generation or wait for it to finish.");
  }
  const savedPrompt =
    input.action === "translate"
      ? `${input.prompt}\nTranslation language: ${input.targetLanguage}`.trim()
      : input.action === "change_tone"
        ? `${input.prompt}\nTone: ${input.tone}`.trim()
        : input.prompt;
  const sources: AiSourceSnapshot[] = [];
  let characters =
    savedPrompt.length + history.reduce((total, message) => total + message.prompt.length + message.output.length, 0);
  for (const source of input.sources) {
    const snapshot = await readAiSource(env, member, source);
    sources.push(snapshot);
    characters += snapshot.text.length;
    if (characters > Math.min(AI_MAX_CHARACTERS, model.maxCharacters))
      throw new HttpError(
        413,
        "ai_context_too_large",
        "The complete sources, prompt, and history exceed this quality mode's context limit. Narrow the source scope, remove references, choose a larger configured mode, or start a new conversation.",
      );
  }
  const token = input.funding === "api" ? env.OPENAI_API_KEY! : await chatgptAccessToken(env, member);
  const providerModel = (await providerModels(member.workspace.id, token, input.funding)).find(
    (item) => item.id === model.id,
  );
  if (!providerModel)
    throw new HttpError(
      422,
      "ai_model_unavailable",
      "This quality mode is unavailable with the chosen funding source.",
    );
  if (characters > providerModel.maxCharacters)
    throw new HttpError(
      413,
      "ai_context_too_large",
      "The provider's context limit is smaller than this request. Narrow its sources or start a new conversation.",
    );
  const providerInput = [
    ...history.flatMap((message) => [
      { role: "user", content: `Action: ${AI_ACTIONS[message.action]}\n${message.prompt}` },
      ...(message.status === "complete" ? [{ role: "assistant", content: message.output }] : []),
    ]),
    { role: "user", content: JSON.stringify({ instruction: savedPrompt, currentPageId: page.id, sources }) },
  ];
  const instructions = aiInstructions(input);
  // UTF-8 bytes bound byte-fallback tokenizers conservatively; leave room for
  // output and protocol overhead when the plan advertises a context window.
  if (
    providerModel.contextTokens &&
    new TextEncoder().encode(instructions + JSON.stringify(providerInput)).length + 4096 > providerModel.contextTokens
  )
    throw new HttpError(
      413,
      "ai_context_too_large",
      "The provider's context window is smaller than this complete request. Narrow sources or start a new conversation.",
    );
  const createdAt = Date.now(),
    day = Math.floor(createdAt / DAY),
    claim = crypto.randomUUID();
  const claimedSql = "EXISTS(SELECT 1 FROM ai_requests WHERE id=? AND claim_id=?)";
  const statements = [
    env.DB.prepare(
      "INSERT OR IGNORE INTO ai_requests(id,workspace_id,user_id,request_hash,day,claim_id,funding,counted,created_at) SELECT ?,?,?,?,?,?,?,1,? WHERE (? IS NULL OR EXISTS(SELECT 1 FROM ai_conversations WHERE id=? AND workspace_id=? AND user_id=? AND updated_at>?)) AND (?='chatgpt' OR (SELECT COUNT(*) FROM ai_requests WHERE workspace_id=? AND user_id=? AND day=? AND funding='api' AND counted=1)<?)",
    ).bind(
      input.operationId,
      member.workspace.id,
      member.user.id,
      hash,
      day,
      claim,
      input.funding,
      createdAt,
      input.conversationId ?? null,
      conversationId,
      member.workspace.id,
      member.user.id,
      createdAt - AI_RETENTION_MS,
      input.funding,
      member.workspace.id,
      member.user.id,
      day,
      settings.dailyQuota,
    ),
    ...(input.conversationId
      ? []
      : [
          env.DB.prepare(`INSERT INTO ai_conversations SELECT ?,?,?,?,?,?,? WHERE ${claimedSql}`).bind(
            conversationId,
            member.workspace.id,
            member.user.id,
            page.id,
            (input.prompt || AI_ACTIONS[input.action]).slice(0, 100),
            JSON.stringify(input.sources),
            createdAt,
            input.operationId,
            claim,
          ),
        ]),
    env.DB.prepare(
      `INSERT INTO ai_messages(id,conversation_id,request_hash,action,prompt,output,status,funding,quality,sources_json,created_at) SELECT ?,?,?,?,?,'','running',?,?,?,? WHERE ${claimedSql}`,
    ).bind(
      input.operationId,
      conversationId,
      hash,
      input.action,
      savedPrompt,
      input.funding,
      input.quality,
      JSON.stringify(sources.map(sourceMetadata)),
      createdAt,
      input.operationId,
      claim,
    ),
    env.DB.prepare(
      `UPDATE ai_conversations SET sources_json=?,updated_at=? WHERE id=? AND updated_at>? AND ${claimedSql}`,
    ).bind(
      JSON.stringify(input.sources),
      createdAt,
      conversationId,
      createdAt - AI_RETENTION_MS,
      input.operationId,
      claim,
    ),
    ...input.sources.map((source) =>
      env.DB.prepare(`INSERT OR IGNORE INTO ai_conversation_pages SELECT ?,? WHERE ${claimedSql}`).bind(
        conversationId,
        source.pageId,
        input.operationId,
        claim,
      ),
    ),
    env.DB.prepare(
      `INSERT INTO ai_preferences SELECT ?,?,? WHERE ${claimedSql} ON CONFLICT(workspace_id,user_id) DO UPDATE SET funding=excluded.funding`,
    ).bind(member.workspace.id, member.user.id, input.funding, input.operationId, claim),
  ];
  let batch: D1Result[];
  try {
    batch = await env.DB.batch(statements);
  } catch (error) {
    if (error instanceof Error && error.message.includes("ai_messages.conversation_id"))
      throw new HttpError(
        409,
        "generation_running",
        "Another generation started in this conversation. Wait for it to finish.",
      );
    // Bound SQL arguments include private writing. Do not log D1's raw error.
    throw new HttpError(503, "ai_history_unavailable", "The writing request could not be reserved. Retry explicitly.");
  }
  if (!batch[0]!.meta.changes) {
    if (input.conversationId) await conversationRow(env, member, conversationId);
    throw new HttpError(
      429,
      "ai_quota_or_duplicate",
      "Your daily API allowance is exhausted or this request already started. Check history and the remaining allowance.",
    );
  }
  const previousSources: Omit<AiSourceSnapshot, "text">[] = history.length
    ? JSON.parse(history.at(-1)!.sources_json)
    : [];
  const changedPageIds = sources
    .filter((source) => {
      const previous = previousSources.find((item) => item.pageId === source.pageId);
      return (
        previous &&
        (previous.revision !== source.revision ||
          previous.contentEpoch !== source.contentEpoch ||
          previous.sequence !== source.sequence)
      );
    })
    .map((source) => source.pageId);
  return streamResponse(async (send, signal) => {
    let output = "",
      completed = false,
      cancelled = false;
    const upstreamAbort = new AbortController();
    const combinedSignal = AbortSignal.any([
      signal,
      upstreamAbort.signal,
      AbortSignal.timeout(AI_GENERATION_TIMEOUT_MS),
    ]);
    let accessCheck: Promise<boolean> | null = null,
      accessError: HttpError | undefined;
    const stopGeneration = (row: { status: string | null; created_at: number | null } | null) => {
      cancelled = row?.status === "cancelled";
      const expired =
        typeof row?.created_at === "number" && row.created_at <= Date.now() - AI_GENERATION_DEADLINE_MS && !cancelled;
      accessError = new HttpError(
        409,
        expired ? "ai_generation_expired" : "ai_stream_failed",
        expired
          ? "Generation expired. Partial text can be copied. Retry explicitly."
          : "Generation stopped before completion. Partial text can be copied. Retry explicitly.",
      );
      upstreamAbort.abort();
      return false;
    };
    const checkAccess = async () => {
      // Identity was authenticated once at dispatch. Revalidate the live session,
      // protection and grants without rebuilding Better Auth on every tick.
      await requireSecurity(env, member.user.id, member.session.id);
      const row = await env.DB.prepare(
        `SELECT m.status,m.created_at,wm.user_id member_id,${conversationLockSql("c.workspace_id", "c.user_id", "c.id", "wm.role")} locked FROM (SELECT ? workspace_id,? user_id) actor LEFT JOIN workspace_members wm ON wm.workspace_id=actor.workspace_id AND wm.user_id=actor.user_id LEFT JOIN ai_conversations c ON c.id=? AND c.workspace_id=actor.workspace_id AND c.user_id=actor.user_id LEFT JOIN ai_messages m ON m.id=? AND m.conversation_id=c.id`,
      )
        .bind(member.workspace.id, member.user.id, conversationId, input.operationId)
        .first<{ status: string | null; created_at: number | null; member_id: string | null; locked: number }>();
      if (row && (!row.member_id || row.locked))
        throw new HttpError(403, "conversation_locked", "A referenced page or workspace is no longer accessible.");
      if (
        !row ||
        row.status !== "running" ||
        (row.created_at !== null && row.created_at <= Date.now() - AI_GENERATION_DEADLINE_MS)
      )
        return stopGeneration(row);
      return true;
    };
    const verifyAccess = async () => {
      for (const delay of [0, 250, 750]) {
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
        if (combinedSignal.aborted) return false;
        try {
          return await checkAccess();
        } catch (error) {
          if (error instanceof HttpError && [401, 403, 404].includes(error.status)) {
            accessError =
              error.status === 401
                ? error
                : new HttpError(
                    403,
                    "conversation_locked",
                    "This conversation is unavailable because access was removed.",
                  );
            upstreamAbort.abort();
            return false;
          }
          if (delay === 750) {
            accessError = new HttpError(503, "ai_access_unavailable", "Access could not be checked. Retry explicitly.");
            upstreamAbort.abort();
          }
        }
      }
      return false;
    };
    const startAccessCheck = () => {
      if (accessCheck) return accessCheck;
      const task = verifyAccess();
      accessCheck = task;
      void task.finally(() => {
        if (accessCheck === task) accessCheck = null;
      });
      return task;
    };
    const poll = setInterval(() => {
      if (!combinedSignal.aborted) void startAccessCheck();
    }, 1000);
    const waitForAccessCheck = async () => {
      const pending = accessCheck;
      return pending ? pending : true;
    };
    try {
      send({
        type: "start",
        conversationId,
        messageId: input.operationId,
        sources: sources.map(sourceMetadata),
        changedPageIds,
        canApply: page.effective_role !== "viewer",
        quota: await quota(env, member, settings),
      });
      const upstream = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: model.id,
          store: false,
          stream: true,
          instructions,
          input: providerInput,
        }),
        signal: combinedSignal,
        redirect: "error",
      });
      if (!upstream.ok) {
        if ([401, 403].includes(upstream.status))
          await invalidateProviderModels(member.workspace.id, token, input.funding);
        // A definite pre-generation rejection refunds the reservation. Network
        // failures and 5xx responses retain it because dispatch may have started.
        if ([400, 401, 403, 404, 422, 429].includes(upstream.status))
          await env.DB.prepare("UPDATE ai_requests SET counted=0 WHERE id=?").bind(input.operationId).run();
        throw new HttpError(
          upstream.status === 429 ? 429 : upstream.status >= 500 ? 503 : 502,
          "ai_provider_rejected",
          `The provider declined this ${input.funding === "api" ? "workspace API" : "ChatGPT plan"} request. Check model access or allowance and retry explicitly.`,
        );
      }
      if (!upstream.body) throw new HttpError(502, "ai_stream_failed", "The provider returned no stream.");
      for await (const raw of readSse(upstream.body)) {
        if (combinedSignal.aborted) throw new Error("Generation cancelled.");
        if (raw === "[DONE]") continue;
        const event = JSON.parse(raw) as {
          type?: string;
          delta?: string;
          response?: { status?: string; error?: { code?: string } };
        };
        if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
          output += event.delta;
          if (output.length > AI_MAX_CHARACTERS)
            throw new HttpError(
              413,
              "ai_output_too_large",
              "The generated result exceeded the writing limit. Narrow the request.",
            );
          if (!(await waitForAccessCheck())) throw new Error("Access check stopped generation.");
          if (combinedSignal.aborted) throw new Error("Generation stopped.");
          send({ type: "delta", text: event.delta });
        } else if (event.type === "response.completed" && event.response?.status === "completed") {
          // Check the cumulative access union and membership again immediately
          // before releasing the complete result. Deletion/cancellation wins.
          if (!(await waitForAccessCheck())) throw new Error("Access check stopped generation.");
          if (!(await startAccessCheck())) throw new Error("Access check stopped generation.");
          const saved = await env.DB.prepare(
            "UPDATE ai_messages SET output=?,status='complete' WHERE id=? AND status='running' AND created_at>?",
          )
            .bind(output, input.operationId, Date.now() - AI_GENERATION_DEADLINE_MS)
            .run();
          if (!saved.meta.changes) {
            const row = await env.DB.prepare("SELECT status,created_at FROM ai_messages WHERE id=?")
              .bind(input.operationId)
              .first<{ status: string; created_at: number }>();
            stopGeneration(row);
            throw new Error("Generation stopped.");
          }
          completed = true;
          send({ type: "complete" });
          break;
        } else if (event.type === "response.failed" || event.type === "response.incomplete" || event.type === "error")
          throw new HttpError(
            502,
            "ai_stream_failed",
            event.response?.error?.code === "subscription_sharing_usage_limit_exceeded"
              ? "Your ChatGPT plan allowance is exhausted. Wait for it to reset or explicitly choose workspace API funding."
              : "The provider stopped before completing the result. Partial text can be copied. Retry explicitly.",
          );
      }
      if (!completed)
        throw new HttpError(
          502,
          "ai_stream_incomplete",
          "The connection ended before completion. Partial text can be copied. Retry explicitly.",
        );
    } catch (cause) {
      const error = accessError ?? cause;
      if (!completed) {
        await env.DB.prepare(
          "UPDATE ai_messages SET output=CASE WHEN length(output)>length(?) THEN output ELSE ? END,status=CASE WHEN status='running' THEN CASE WHEN ? THEN 'cancelled' ELSE 'failed' END ELSE status END WHERE id=? AND status<>'complete'",
        )
          .bind(output, output, cancelled || signal.aborted ? 1 : 0, input.operationId)
          .run();
        send({
          type: "error",
          status: error instanceof HttpError ? error.status : 502,
          code: error instanceof HttpError ? error.code : "ai_stream_failed",
          message:
            cancelled || signal.aborted
              ? "Generation cancelled. Partial text can be copied."
              : error instanceof HttpError
                ? error.message
                : "Generation stopped unexpectedly. Partial text can be copied. Retry explicitly.",
        });
      }
    } finally {
      clearInterval(poll);
      upstreamAbort.abort();
    }
  }, context);
}
