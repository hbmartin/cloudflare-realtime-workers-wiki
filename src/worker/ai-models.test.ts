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
  it("accepts null optional ChatGPT metadata alongside valid and hidden entries", async () => {
    fetcher.mockResolvedValue(
      Response.json({
        models: [
          { slug: "null-metadata", visibility: null, context_window: null },
          { slug: "known-model", visibility: "list", context_window: 32000 },
          { slug: "hidden-model", visibility: "hidden", context_window: null },
        ],
      }),
    );
    expect(await providerModels(workspace, "credential", "chatgpt")).toEqual([
      { id: "null-metadata", maxCharacters: 250000, contextTokens: undefined },
      { id: "known-model", maxCharacters: 32000, contextTokens: 32000 },
    ]);
  });
  it.each([
    { slug: "" },
    { slug: 42 },
    { slug: "model", visibility: 42 },
    { slug: "model", context_window: "32000" },
    { slug: "model", context_window: 0 },
    { slug: "model", context_window: -1 },
  ])("still rejects invalid ChatGPT metadata %j", async (model) => {
    fetcher.mockResolvedValue(Response.json({ models: [{ slug: "valid" }, model] }));
    await expect(providerModels(workspace, "credential", "chatgpt")).rejects.toMatchObject({ status: 502 });
  });
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
  it("reuses settled results and isolates workspace, funding, and credential", async () => {
    await providerModels(workspace, "one", "api");
    await providerModels(workspace, "one", "api");
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
  it("lets concurrent misses finish independently and keeps a success after another caller fails", async () => {
    let resolve!: (response: Response) => void;
    let reject!: (cause: Error) => void;
    fetcher.mockImplementationOnce(
      () =>
        new Promise<Response>((complete) => {
          resolve = complete;
        }),
    );
    fetcher.mockImplementationOnce(
      () =>
        new Promise<Response>((_complete, fail) => {
          reject = fail;
        }),
    );
    const first = providerModels(workspace, "credential", "api");
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    const second = providerModels(workspace, "credential", "api");
    const failed = second.catch((cause: unknown) => cause);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    resolve(Response.json({ data: [{ id: "independent" }] }));
    expect(await first).toMatchObject([{ id: "independent" }]);
    reject(new Error("Originating request ended"));
    expect(await failed).toMatchObject({ status: 503 });
    expect(await providerModels(workspace, "credential", "api")).toMatchObject([{ id: "independent" }]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("does not let a lookup started before invalidation refill the cache", async () => {
    let resolve!: (response: Response) => void;
    fetcher.mockImplementationOnce(
      () =>
        new Promise<Response>((complete) => {
          resolve = complete;
        }),
    );
    const pending = providerModels(workspace, "credential", "api");
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    await invalidateProviderModels(workspace, "credential", "api");
    resolve(Response.json({ data: [{ id: "outdated" }] }));
    expect(await pending).toMatchObject([{ id: "outdated" }]);
    expect(await providerModels(workspace, "credential", "api")).toMatchObject([{ id: "api-model" }]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("starts the TTL when a successful catalog finishes loading", async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    let resolve!: (response: Response) => void;
    fetcher.mockImplementationOnce(
      () =>
        new Promise<Response>((complete) => {
          resolve = complete;
        }),
    );
    const pending = providerModels(workspace, "credential", "api");
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    clock.mockReturnValue(now + 120000);
    resolve(Response.json({ data: [{ id: "slow-model" }] }));
    await pending;
    clock.mockReturnValue(now + 179999);
    expect(await providerModels(workspace, "credential", "api")).toMatchObject([{ id: "slow-model" }]);
    expect(fetcher).toHaveBeenCalledOnce();
    clock.mockReturnValue(now + 180000);
    expect(await providerModels(workspace, "credential", "api")).toMatchObject([{ id: "api-model" }]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it.each(["api", "chatgpt"] as const)("uses status-appropriate model errors for %s funding", async (funding) => {
    for (const status of [401, 403, 429, 503, 404]) {
      fetcher.mockResolvedValueOnce(new Response("rejected", { status }));
      await expect(providerModels(workspace, "credential", funding)).rejects.toMatchObject({
        status: [401, 403].includes(status) ? 502 : 503,
        code: [401, 403].includes(status) ? "ai_provider_credentials" : "ai_model_unavailable",
        message: [401, 403].includes(status)
          ? funding === "api"
            ? "Workspace API model access could not be verified. Contact an owner."
            : "ChatGPT model access could not be verified. Reconnect or choose workspace API funding."
          : status === 429 || status >= 500
            ? "Model access is temporarily unavailable. Retry shortly."
            : "Model access could not be verified. Retry or contact an owner.",
      });
    }
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
