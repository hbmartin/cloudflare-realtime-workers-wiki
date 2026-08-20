import { describe, expect, it, vi } from "vitest";
import type { Env } from "./env";
import { processDueUploadReaps } from "./attachments";

function cleanupEnv(
  state: "active" | "completing" | "reaping" | "aborting",
  object: object | null = null,
  abortError: Error | null = null,
) {
  const queries: Array<{ sql: string; args: unknown[] }> = [];
  const abort = vi.fn(async () => {
    if (abortError) throw abortError;
  });
  const prepare = vi.fn((sql: string) => ({
    bind: vi.fn((...args: unknown[]) => {
      queries.push({ sql, args });
      return {
        all: vi.fn(async () => ({ results: [{ id: "upload-1", state }] })),
        first: vi.fn(async () =>
          sql.includes("RETURNING id, r2_key")
            ? {
                id: "upload-1",
                r2_key: "assets/workspace/upload-1",
                r2_upload_id: "r2-upload-1",
                attempts: 1,
              }
            : null,
        ),
        run: vi.fn(async () => undefined),
      };
    }),
  }));
  const env = {
    DB: { prepare },
    BUCKET: {
      head: vi.fn(async () => object),
      resumeMultipartUpload: vi.fn(() => ({ abort })),
    },
  } as unknown as Env;
  return { env, queries, abort };
}

describe("multipart upload cleanup", () => {
  it("claims only a due active upload before aborting it", async () => {
    const { env, queries, abort } = cleanupEnv("active");

    await processDueUploadReaps(env);

    expect(abort).toHaveBeenCalledOnce();
    expect(queries.some(({ sql }) => /state = 'reaping'.*state = 'active'/s.test(sql))).toBe(true);
    expect(queries.some(({ sql }) => /DELETE FROM attachment_uploads.*state = 'reaping'/s.test(sql))).toBe(true);
  });

  it("keeps an ambiguously failed abort fenced for terminal retry", async () => {
    const { env, queries, abort } = cleanupEnv("active", null, new Error("connection lost"));

    await processDueUploadReaps(env);

    expect(abort).toHaveBeenCalledOnce();
    const reschedule = queries.find(({ sql }) => sql.includes("SET state = ?"));
    expect(reschedule?.args[0]).toBe("reaping");
  });

  it("promotes stale completion to r2_complete when the object exists", async () => {
    const { env, queries, abort } = cleanupEnv("completing", {});

    await processDueUploadReaps(env);

    expect(abort).not.toHaveBeenCalled();
    expect(queries.some(({ sql }) => sql.includes("SET state = 'r2_complete'"))).toBe(true);
  });

  it("returns a stale completion with no object to a due active state", async () => {
    const { env, queries, abort } = cleanupEnv("completing", null);

    await processDueUploadReaps(env);

    expect(abort).not.toHaveBeenCalled();
    const recovery = queries.find(({ sql }) => sql.includes("SET state = 'active'"));
    expect(recovery).toBeTruthy();
    expect(recovery!.args[0]).toEqual(expect.any(Number));
  });

  it.each(["reaping", "aborting"] as const)("finishes a fenced %s cleanup without reviving it", async (state) => {
    const { env, queries, abort } = cleanupEnv(state);

    await processDueUploadReaps(env);

    expect(abort).toHaveBeenCalledOnce();
    expect(queries.some(({ sql }) => /DELETE FROM attachment_uploads.*state = \?/s.test(sql))).toBe(true);
    expect(queries.some(({ sql }) => sql.includes("SET state = 'active'"))).toBe(false);
  });
});
