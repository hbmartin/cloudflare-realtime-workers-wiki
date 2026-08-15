import { describe, expect, it, vi } from "vitest";
import type { Env } from "./env";
import { processArchiveDisconnectTargets } from "./archive";

describe("archive disconnect processing", () => {
  it("bounds document-room requests with an abort signal", async () => {
    const timeoutController = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);
    let requestSignal: AbortSignal | undefined;
    const fetch = vi.fn(async (request: Request) => {
      requestSignal = request.signal;
      return new Response(null, { status: 200 });
    });
    const prepare = vi.fn((query: string) => ({ bind: vi.fn(() => ({
      first: vi.fn(async () => query.includes("RETURNING workspace_id")
        ? { workspace_id: "workspace", room: "page~1", attempts: 0 }
        : { content_epoch: 1, archived_at: Date.now(), location_hint: "weur" }),
      run: vi.fn(async () => undefined),
    })) }));
    const getByName = vi.fn(() => ({ fetch }));
    const env = {
      BETTER_AUTH_SECRET: "test-secret",
      DB: { prepare },
      DOCUMENT: { getByName },
    } as unknown as Env;

    try {
      await processArchiveDisconnectTargets(env, [{
        page_id: "page",
        content_epoch: 1,
      }]);

      expect(timeout).toHaveBeenCalledWith(30_000);
      expect(getByName).toHaveBeenCalledWith("page~1", { locationHint: "weur" });
      expect(fetch).toHaveBeenCalledOnce();
      expect(requestSignal?.aborted).toBe(false);
      timeoutController.abort();
      expect(requestSignal?.aborted).toBe(true);
    } finally {
      timeout.mockRestore();
    }
  });

  it("claims a target before contacting its document room", async () => {
    let claims = 0;
    const fetch = vi.fn(async () => new Response(null, { status: 200 }));
    const prepare = vi.fn((query: string) => ({ bind: vi.fn(() => ({
      first: vi.fn(async () => {
        if (query.includes("RETURNING workspace_id")) {
          claims += 1;
          return claims === 1
            ? { workspace_id: "workspace", room: "page~1", attempts: 0 }
            : null;
        }
        return { content_epoch: 1, archived_at: Date.now(), location_hint: null };
      }),
      run: vi.fn(async () => undefined),
    })) }));
    const env = {
      BETTER_AUTH_SECRET: "test-secret",
      DB: { prepare },
      DOCUMENT: { getByName: vi.fn(() => ({ fetch })) },
    } as unknown as Env;

    await Promise.all([
      processArchiveDisconnectTargets(env, [{ page_id: "page", content_epoch: 1 }]),
      processArchiveDisconnectTargets(env, [{ page_id: "page", content_epoch: 1 }]),
    ]);

    expect(fetch).toHaveBeenCalledOnce();
  });
});
