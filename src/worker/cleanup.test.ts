import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "./env";
import { processDeletionJob, pruneBulkWriteReceipts } from "./cleanup";

describe("deletion job cleanup", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses the workspace location and a timeout for document purges", async () => {
    const timeout = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    let capturedRequest: Request | undefined;
    const fetch = vi.fn(async (request: Request) => {
      capturedRequest = request;
      return new Response(null, { status: 204 });
    });
    const getByName = vi.fn(() => ({ fetch }));
    const binds: Array<{ query: string; args: unknown[] }> = [];
    const runs: Array<{ query: string; args: unknown[] }> = [];
    const prepare = vi.fn((query: string) => ({
      bind: vi.fn((...args: unknown[]) => {
        const statement = { query, args };
        binds.push(statement);
        return {
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
          all: vi.fn(async () =>
            query.includes("FROM deletion_targets")
              ? { results: [{ kind: "document_do", target: "page-1~1" }] }
              : { results: [] },
          ),
          run: vi.fn(async () => {
            runs.push(statement);
          }),
        };
      }),
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
    expect(capturedRequest?.headers.get("x-notes-internal")).toBe("secret");
    expect(capturedRequest?.signal.aborted).toBe(false);
    timeout.abort();
    expect(capturedRequest?.signal.aborted).toBe(true);
    const claim = binds.find(({ query }) => query.includes("RETURNING id, attempts, workspace_id"));
    const deletion = runs.find(({ query }) => query.includes("DELETE FROM deletion_jobs"));
    expect(deletion?.query).toMatch(/next_attempt_at = \?/);
    expect(deletion?.args).toEqual(["job-1", claim?.args[0]]);
  });

  it("skips the workspace location lookup for R2-only jobs", async () => {
    const queries: string[] = [];
    const prepare = vi.fn((query: string) => {
      queries.push(query);
      return {
        bind: vi.fn(() => ({
          first: vi.fn(async () => {
            if (query.includes("RETURNING id, attempts, workspace_id")) {
              return { id: "job-1", attempts: 0, workspace_id: "workspace-1" };
            }
            if (query.includes("SELECT COUNT(*) count")) return { count: 0 };
            return null;
          }),
          all: vi.fn(async () =>
            query.includes("FROM deletion_targets")
              ? { results: [{ kind: "r2_object", target: "attachments/file" }] }
              : { results: [] },
          ),
          run: vi.fn(async () => undefined),
        })),
      };
    });
    const env = {
      DB: { prepare },
      BUCKET: { delete: vi.fn(async () => undefined) },
    } as unknown as Env;

    await processDeletionJob(env, "job-1");

    expect(env.BUCKET.delete).toHaveBeenCalledWith("attachments/file");
    expect(queries.some((query) => query.includes("SELECT location_hint FROM workspaces"))).toBe(false);
  });
});

describe("bulk write receipt pruning", () => {
  it("deletes only receipts older than the retention window", async () => {
    const run = vi.fn(async () => ({}));
    const bind = vi.fn((_cutoff: number) => ({ run }));
    const prepare = vi.fn(() => ({ bind }));
    const env = { DB: { prepare } } as unknown as Env;

    await pruneBulkWriteReceipts(env, 1_000);

    expect(prepare).toHaveBeenCalledWith(expect.stringContaining("DELETE FROM table_bulk_writes"));
    expect(bind).toHaveBeenCalledWith(1_000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("defaults the cutoff to the retention window before now", async () => {
    const run = vi.fn(async () => ({}));
    const bind = vi.fn((_cutoff: number) => ({ run }));
    const env = { DB: { prepare: vi.fn(() => ({ bind })) } } as unknown as Env;

    await pruneBulkWriteReceipts(env);

    expect(bind).toHaveBeenCalledWith(expect.any(Number));
    expect(bind.mock.calls[0]?.[0]).toBeLessThan(Date.now());
  });
});
