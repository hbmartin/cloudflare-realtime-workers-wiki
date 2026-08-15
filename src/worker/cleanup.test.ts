import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "./env";
import { processDeletionJob } from "./cleanup";

describe("deletion job cleanup", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses the workspace location and a timeout for document purges", async () => {
    const timeout = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    const fetch = vi.fn(async (request: Request) => {
      expect(request.signal.aborted).toBe(false);
      timeout.abort();
      expect(request.signal.aborted).toBe(true);
      return new Response(null, { status: 204 });
    });
    const getByName = vi.fn(() => ({ fetch }));
    const prepare = vi.fn((query: string) => ({
      bind: vi.fn(() => ({
        first: vi.fn(async () => {
          if (query.includes("RETURNING id, attempts, workspace_id")) {
            return { id: "job-1", attempts: 0, workspace_id: "workspace-1" };
          }
          if (query.includes("SELECT location_hint FROM workspaces")) {
            return { location_hint: "weur" };
          }
          if (query.includes("SELECT COUNT(*) count")) return { count: 0 };
          return null;
        }),
        all: vi.fn(async () => query.includes("FROM deletion_targets")
          ? { results: [{ kind: "document_do", target: "page-1~1" }] }
          : { results: [] }),
        run: vi.fn(async () => undefined),
      })),
    }));
    const env = {
      BETTER_AUTH_SECRET: "secret",
      DB: { prepare },
      DOCUMENT: { getByName },
    } as unknown as Env;

    await processDeletionJob(env, "job-1");

    expect(getByName).toHaveBeenCalledWith("page-1~1", { locationHint: "weur" });
    expect(timeoutSpy).toHaveBeenCalledWith(30_000);
    expect(fetch).toHaveBeenCalledOnce();
  });
});
