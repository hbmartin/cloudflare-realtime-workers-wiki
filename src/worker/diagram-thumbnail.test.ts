import { describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../shared/import-integrity";
import type { Env } from "./env";
import { diagramThumbnailResponse } from "./diagram-thumbnail";

vi.mock("../shared/import-integrity", async (importOriginal) => {
  const original = await importOriginal<typeof import("../shared/import-integrity")>();
  return { ...original, sha256Hex: vi.fn(original.sha256Hex) };
});

function thumbnailEnv(objectExists: boolean, thumbnailBody?: string) {
  const get = vi.fn(async () =>
    thumbnailBody === undefined ? null : ({ body: thumbnailBody } as unknown as R2ObjectBody),
  );
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
      { cacheControl: "private", validators: true, ifNoneMatch: '"stale", W/"hash"' },
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
      { cacheControl: "private", validators: true, ifNoneMatch: '"hash"' },
    );

    expect(response.status).toBe(200);
    const placeholder = await response.text();
    expect(response.headers.get("etag")).toBe(`"empty-${await sha256Hex(placeholder)}"`);
    expect(get).toHaveBeenCalledWith("diagrams/page/thumbnail.svg");
  });

  it("uses weak comparison for a placeholder validator list", async () => {
    const { env } = thumbnailEnv(false);
    const page = { id: "page", content_epoch: 1, title: "Diagram" };
    const first = await diagramThumbnailResponse(env, page, { cacheControl: "private", validators: true });
    const etag = first.headers.get("etag");

    const response = await diagramThumbnailResponse(env, page, {
      cacheControl: "private",
      validators: true,
      ifNoneMatch: `"stale", W/${etag}`,
    });

    expect(response.status).toBe(304);
  });

  it("does not attach a validator to a cached no-store thumbnail", async () => {
    const { env, get, head } = thumbnailEnv(false, "<svg>cached</svg>");

    const response = await diagramThumbnailResponse(
      env,
      { id: "page", content_epoch: 1, title: "Diagram" },
      { cacheControl: "no-store", validators: false, ifNoneMatch: '"hash"' },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBeNull();
    expect(await response.text()).toBe("<svg>cached</svg>");
    expect(head).not.toHaveBeenCalled();
    expect(get).toHaveBeenCalledWith("diagrams/page/thumbnail.svg");
  });

  it("does not hash or attach a validator to a no-store placeholder", async () => {
    const { env } = thumbnailEnv(false);
    const hash = vi.mocked(sha256Hex);
    hash.mockClear();

    const response = await diagramThumbnailResponse(
      env,
      { id: "page", content_epoch: 1, title: "Diagram" },
      { cacheControl: "no-store", validators: false },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBeNull();
    expect(await response.text()).toContain("<svg");
    expect(hash).not.toHaveBeenCalled();
  });
});
