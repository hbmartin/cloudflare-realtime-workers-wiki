import { z } from "zod";
import { AI_MAX_CHARACTERS, type AiFunding } from "../shared/ai";
import { HttpError, sha256 } from "./http";

type ProviderModel = { id: string; maxCharacters: number; contextTokens: number | undefined };
const catalogCache = new Map<string, { expiresAt: number; models: ProviderModel[] }>();
let invalidation = 0;
const TTL = 60_000;
const apiCatalog = z.object({ data: z.array(z.object({ id: z.string().min(1) })) });
const chatgptCatalog = z.object({
  models: z.array(
    z.object({
      slug: z.string().min(1),
      visibility: z.string().nullish(),
      context_window: z.number().positive().nullish(),
    }),
  ),
});
async function cacheKey(workspaceId: string, token: string, funding: AiFunding) {
  return `${workspaceId}:${funding}:${await sha256(token)}`;
}
export async function invalidateProviderModels(workspaceId: string, token: string, funding: AiFunding) {
  const key = await cacheKey(workspaceId, token, funding);
  invalidation++;
  catalogCache.delete(key);
}
export async function providerModels(workspaceId: string, token: string, funding: AiFunding) {
  const key = await cacheKey(workspaceId, token, funding);
  const cached = catalogCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.models;
  catalogCache.delete(key);
  const revision = invalidation;
  // Fetches belong to the calling Worker request. Share only their parsed results.
  const models = await fetchModels(token, funding);
  if (revision === invalidation) {
    const now = Date.now();
    for (const [id, entry] of catalogCache) if (entry.expiresAt <= now) catalogCache.delete(id);
    if (!catalogCache.has(key)) {
      if (catalogCache.size >= 128) catalogCache.delete(catalogCache.keys().next().value!);
      catalogCache.set(key, { expiresAt: now + TTL, models });
    }
  }
  return models;
}
async function fetchModels(token: string, funding: AiFunding): Promise<ProviderModel[]> {
  let response: Response;
  try {
    response = await fetch("https://api.openai.com/v1/models", {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000),
      redirect: "error",
    });
  } catch {
    throw new HttpError(503, "ai_model_unavailable", "Model access is temporarily unavailable. Retry shortly.");
  }
  if (!response.ok)
    throw new HttpError(
      [401, 403].includes(response.status) ? 502 : 503,
      [401, 403].includes(response.status) ? "ai_provider_credentials" : "ai_model_unavailable",
      [401, 403].includes(response.status)
        ? funding === "api"
          ? "Workspace API model access could not be verified. Contact an owner."
          : "ChatGPT model access could not be verified. Reconnect or choose workspace API funding."
        : response.status === 429 || response.status >= 500
          ? "Model access is temporarily unavailable. Retry shortly."
          : "Model access could not be verified. Retry or contact an owner.",
    );
  const data: unknown = await response.json().catch(() => null);
  if (funding === "chatgpt") {
    const parsed = chatgptCatalog.safeParse(data);
    if (parsed.success)
      return parsed.data.models
        .filter((item) => !item.visibility || item.visibility === "list")
        .map((item) => ({
          id: item.slug,
          maxCharacters: Math.min(AI_MAX_CHARACTERS, item.context_window ?? AI_MAX_CHARACTERS),
          contextTokens: item.context_window ?? undefined,
        }));
  } else {
    const parsed = apiCatalog.safeParse(data);
    if (parsed.success)
      return parsed.data.data.map((item) => ({
        id: item.id,
        maxCharacters: AI_MAX_CHARACTERS,
        contextTokens: undefined,
      }));
  }
  throw new HttpError(
    502,
    "ai_model_unavailable",
    "The provider returned an invalid model catalog. Retry or contact an owner.",
  );
}
