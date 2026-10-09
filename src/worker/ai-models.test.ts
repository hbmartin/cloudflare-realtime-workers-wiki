import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invalidateProviderModels, providerModels } from "./ai-models";

let workspace: string;
const fetcher = vi.fn();
beforeEach(() => {
  workspace = crypto.randomUUID();
  fetcher.mockReset().mockImplementation(async () => Response.json({ data: [{ id: "api-model" }] }));
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe("funding-specific model catalogs", () => {
  it("preserves the documented ChatGPT models[].slug contract and visibility", async () => {
    fetcher.mockResolvedValue(
      Response.json({
        models: [
          { slug: "chatgpt-model", visibility: "list", context_window: 32000 },
          { slug: "hidden-model", visibility: "hidden" },
        ],
      }),
    );
    expect(await providerModels(workspace, "chatgpt-token", "chatgpt")).toEqual([
      { id: "chatgpt-model", maxCharacters: 32000, contextTokens: 32000 },
    ]);
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.openai.com/v1/models",
      expect.objectContaining({
        headers: { authorization: "Bearer chatgpt-token" },
      }),
    );
  });
  it.each(["api", "chatgpt"] as const)(
    "rejects malformed %s catalogs instead of claiming empty model access",
    async (funding) => {
      fetcher.mockResolvedValueOnce(
        Response.json(funding === "api" ? { models: [{ slug: "wrong" }] } : { data: [{ id: "wrong" }] }),
      );
      await expect(providerModels(workspace, "credential", funding)).rejects.toMatchObject({ status: 502 });
      fetcher.mockResolvedValueOnce(Response.json(funding === "api" ? { data: [] } : { models: [] }));
      expect(await providerModels(workspace, "credential", funding)).toEqual([]);
      expect(fetcher).toHaveBeenCalledTimes(2);
    },
  );
  it.each([401, 403, 503])("maps provider %i without producing a NoteFlare 401 or caching failure", async (status) => {
    fetcher.mockResolvedValueOnce(new Response("rejected", { status }));
    await expect(providerModels(workspace, "credential", "api")).rejects.toMatchObject({
      status: status === 503 ? 503 : 502,
    });
    expect(await providerModels(workspace, "credential", "api")).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("deduplicates concurrent lookups and isolates workspace, funding, and credential", async () => {
    await Promise.all(Array.from({ length: 8 }, () => providerModels(workspace, "one", "api")));
    expect(fetcher).toHaveBeenCalledTimes(1);
    await providerModels(`${workspace}-other`, "one", "api");
    await providerModels(workspace, "two", "api");
    fetcher.mockResolvedValueOnce(Response.json({ models: [{ slug: "plan-model" }] }));
    await providerModels(workspace, "one", "chatgpt");
    expect(fetcher).toHaveBeenCalledTimes(4);
    await invalidateProviderModels(workspace, "one", "api");
    await providerModels(workspace, "one", "api");
    await providerModels(workspace, "two", "api");
    expect(fetcher).toHaveBeenCalledTimes(5);
  });
  it("expires successful entries at 60 seconds and caps the cache at 128", async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    await providerModels(workspace, "credential", "api");
    clock.mockReturnValue(now + 59999);
    await providerModels(workspace, "credential", "api");
    expect(fetcher).toHaveBeenCalledTimes(1);
    clock.mockReturnValue(now + 60000);
    await providerModels(workspace, "credential", "api");
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (let index = 0; index < 128; index++) await providerModels(`${workspace}-${index}`, "credential", "api");
    await providerModels(workspace, "credential", "api");
    expect(fetcher).toHaveBeenCalledTimes(131);
  });
});
