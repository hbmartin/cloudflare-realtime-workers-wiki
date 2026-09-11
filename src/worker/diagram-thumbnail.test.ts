import { describe, expect, it, vi } from "vitest";
import type { Env } from "./env";
import { diagramThumbnailResponse } from "./diagram-thumbnail";

function thumbnailEnv(objectExists: boolean) {
  const get = vi.fn();
  const head = vi.fn(async () => (objectExists ? ({} as R2Object) : null));
  const first = vi.fn(async () => ({ thumbnail_r2_key: "diagrams/page/thumbnail.svg", thumbnail_hash: "hash" }));
  const env = {
    DB: { prepare: vi.fn(() => ({ bind: vi.fn(() => ({ first })) })) },
    BUCKET: { get, head },
  } as unknown as Env;
  return { env, get, head };
}

describe("diagram thumbnail responses", () => {
  it("uses a metadata check instead of downloading a matching cached thumbnail", async () => {
    const { env, get, head } = thumbnailEnv(true);

    const response = await diagramThumbnailResponse(
      env,
      { id: "page", content_epoch: 1, title: "Diagram" },
      { cacheControl: "private", ifNoneMatch: '"hash"' },
    );

    expect(response.status).toBe(304);
    expect(head).toHaveBeenCalledWith("diagrams/page/thumbnail.svg");
    expect(get).not.toHaveBeenCalled();
  });

  it("serves the correctly validated placeholder when the cached object is missing", async () => {
    const { env, get } = thumbnailEnv(false);

    const response = await diagramThumbnailResponse(
      env,
      { id: "page", content_epoch: 1, title: "Diagram" },
      { cacheControl: "private", ifNoneMatch: '"hash"' },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toMatch(/^"empty-[a-f0-9]{64}"$/);
    expect(get).toHaveBeenCalledWith("diagrams/page/thumbnail.svg");
  });
});
