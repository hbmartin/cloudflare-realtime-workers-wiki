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
    const claim = prepare.mock.calls.map(([query]) => query)
      .find((query) => query.includes("RETURNING workspace_id"));
    expect(claim).toMatch(/UPDATE archive_disconnect_targets/);
    expect(claim).toMatch(/attempts = attempts \+ 1/);
    expect(claim).toMatch(/next_attempt_at <= \?/);
  });

  it("completes a claim when the room reports that archiving is no longer applicable", async () => {
    const fetch = vi.fn(async () => Response.json(null, { status: 410 }));
    const run = vi.fn(async () => undefined);
    const binds: Array<{ query: string; args: unknown[] }> = [];
    let lease: number | undefined;
    const prepare = vi.fn((query: string) => ({
      bind: vi.fn((...args: unknown[]) => {
        binds.push({ query, args });
        if (query.includes("RETURNING workspace_id")) lease = args[0] as number;
        return {
          first: vi.fn(async () =>
            query.includes("RETURNING workspace_id")
              ? { workspace_id: "workspace", room: "page~1", attempts: 1 }
              : { content_epoch: 1, archived_at: Date.now(), location_hint: null },
          ),
          run,
        };
      }),
    }));
    const env = {
      BETTER_AUTH_SECRET: "test-secret",
      DB: { prepare },
      DOCUMENT: { getByName: vi.fn(() => ({ fetch })) },
    } as unknown as Env;

    const pending = await processArchiveDisconnectTargets(env, [{
      page_id: "page",
      content_epoch: 1,
    }]);

    expect(pending).toEqual([]);
    const deletion = binds.find(({ query }) => query.includes("DELETE FROM archive_disconnect_targets"));
    expect(deletion?.query).toMatch(/next_attempt_at = \?/);
    expect(deletion?.args.at(-1)).toBe(lease);
    expect(run).toHaveBeenCalledOnce();
  });

  it("keeps transient room conflicts in the retry queue", async () => {
    const fetch = vi.fn(async () => Response.json(null, { status: 409 }));
    const run = vi.fn(async () => undefined);
    const binds: Array<{ query: string; args: unknown[] }> = [];
    let lease: number | undefined;
    const prepare = vi.fn((query: string) => ({
      bind: vi.fn((...args: unknown[]) => {
        binds.push({ query, args });
        if (query.includes("RETURNING workspace_id")) lease = args[0] as number;
        return {
          first: vi.fn(async () =>
            query.includes("RETURNING workspace_id")
              ? { workspace_id: "workspace", room: "page~1", attempts: 1 }
              : { content_epoch: 1, archived_at: Date.now(), location_hint: null },
          ),
          run,
        };
      }),
    }));
    const env = {
      BETTER_AUTH_SECRET: "test-secret",
      DB: { prepare },
      DOCUMENT: { getByName: vi.fn(() => ({ fetch })) },
    } as unknown as Env;

    const pending = await processArchiveDisconnectTargets(env, [{
      page_id: "page",
      content_epoch: 1,
    }]);

    expect(pending).toEqual(["page"]);
    const reschedule = binds.find(({ query }) => query.includes("SET attempts = ?"));
    expect(reschedule?.query).toMatch(/next_attempt_at = \?/);
    expect(reschedule?.args[0]).toBe(1);
    expect(reschedule?.args.at(-1)).toBe(lease);
    expect(run).toHaveBeenCalledOnce();
  });
});
