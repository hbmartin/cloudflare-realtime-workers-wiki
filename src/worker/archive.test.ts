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
    const prepare = vi.fn((query: string) => ({
      bind: vi.fn(() => query.includes("SELECT content_epoch")
        ? { first: vi.fn(async () => ({ content_epoch: 1, archived_at: Date.now() })) }
        : { run: vi.fn(async () => undefined) }),
    }));
    const env = {
      BETTER_AUTH_SECRET: "test-secret",
      DB: { prepare },
      DOCUMENT: { getByName: vi.fn(() => ({ fetch })) },
    } as unknown as Env;

    try {
      await processArchiveDisconnectTargets(env, [{
        page_id: "page",
        workspace_id: "workspace",
        content_epoch: 1,
        room: "page~1",
        attempts: 0,
      }]);

      expect(timeout).toHaveBeenCalledWith(30_000);
      expect(fetch).toHaveBeenCalledOnce();
      expect(requestSignal?.aborted).toBe(false);
      timeoutController.abort();
      expect(requestSignal?.aborted).toBe(true);
    } finally {
      timeout.mockRestore();
    }
  });
});
