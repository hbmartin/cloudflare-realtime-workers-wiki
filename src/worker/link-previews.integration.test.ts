import { applyD1Migrations, env, reset, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { linkPreview, linkPreviewImage, pruneLinkPreviews } from "./link-previews";

const pageUrl = "https://www.public-preview.org/article";
const imageUrl = "https://images.public-preview.org/cover.png";
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
});

afterEach(() => vi.unstubAllGlobals());

describe("link previews", () => {
  it("requires current membership for both routes", async () => {
    expect(
      (
        await SELF.fetch("http://example.test/api/link-previews", {
          method: "POST",
          body: JSON.stringify({ url: pageUrl }),
        })
      ).status,
    ).toBe(401);
    expect((await SELF.fetch("http://example.test/api/link-previews/" + "a".repeat(64) + "/image")).status).toBe(401);
  });

  it("caches bounded metadata and a same-origin image, then expires both", async () => {
    const fetcher = vi.fn(async (url: string) =>
      url === pageUrl
        ? new Response(
            '<title>Document title</title><meta property="og:title" content="Article"><meta property="og:description" content="A useful summary"><meta property="og:image" content="https://images.public-preview.org/cover.png">',
            { headers: { "content-type": "text/html" } },
          )
        : url === imageUrl
          ? new Response(png, { headers: { "content-type": "image/png" } })
          : new Response("missing", { status: 404 }),
    );
    vi.stubGlobal("fetch", fetcher);
    const first = await linkPreview(env, "workspace", pageUrl);
    expect(first).toMatchObject({
      title: "Article",
      description: "A useful summary",
      imageUrl: `/api/link-previews/${first.id}/image`,
    });
    expect((await linkPreview(env, "workspace", pageUrl)).id).toBe(first.id);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const image = await linkPreviewImage(env, "workspace", first.id);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(image.headers.get("x-content-type-options")).toBe("nosniff");
    await expect(linkPreviewImage(env, "other-workspace", first.id)).rejects.toMatchObject({ status: 404 });
    await env.DB.prepare("UPDATE link_preview_cache SET expires_at = 1 WHERE id = ?").bind(first.id).run();
    await pruneLinkPreviews(env);
    await expect(linkPreviewImage(env, "workspace", first.id)).rejects.toMatchObject({ status: 404 });
    expect(await env.DB.prepare("SELECT id FROM link_preview_cache WHERE id = ?").bind(first.id).first()).toBeNull();
  });

  it("decodes numeric titles and escaped image query strings", async () => {
    const encodedImage = `${imageUrl}?w=1200&amp;h=630`;
    const decodedImage = `${imageUrl}?w=1200&h=630`;
    const fetcher = vi.fn(async (url: string) =>
      url === pageUrl
        ? new Response(
            `<meta property="og:title" content="It&#8217;s useful"><meta property="og:image" content="${encodedImage}">`,
            {
              headers: { "content-type": "text/html" },
            },
          )
        : url === decodedImage
          ? new Response(png, { headers: { "content-type": "image/png" } })
          : new Response("missing", { status: 404 }),
    );
    vi.stubGlobal("fetch", fetcher);
    const preview = await linkPreview(env, "workspace", pageUrl);
    expect(preview.title).toBe("It’s useful");
    expect(preview.imageUrl).toBe(`/api/link-previews/${preview.id}/image`);
    expect(fetcher).toHaveBeenCalledWith(decodedImage, expect.anything());
  });

  it("keeps the card image-free when R2 rejects the image", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url === pageUrl
          ? new Response(`<meta property="og:image" content="${imageUrl}">`, {
              headers: { "content-type": "text/html" },
            })
          : new Response(png, { headers: { "content-type": "image/png" } }),
      ),
    );
    const bucket = new Proxy(env.BUCKET, {
      get(target, property) {
        if (property === "put")
          return async () => {
            throw new Error("R2 unavailable");
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const preview = await linkPreview({ ...env, BUCKET: bucket }, "workspace", pageUrl);
    expect(preview.imageUrl).toBeNull();
    expect(
      (
        await env.DB.prepare("SELECT image_key FROM link_preview_cache WHERE id = ?")
          .bind(preview.id)
          .first<{ image_key: string | null }>()
      )?.image_key,
    ).toBeNull();
  });

  it("returns one in-progress card for concurrent requests", async () => {
    let release!: (response: Response) => void;
    const fetcher = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetcher);
    const first = linkPreview(env, "workspace", pageUrl);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    const pending = await linkPreview(env, "workspace", pageUrl);
    expect(pending.title).toBe("www.public-preview.org");
    expect(fetcher).toHaveBeenCalledOnce();
    release(new Response("<title>Finished</title>", { headers: { "content-type": "text/html" } }));
    expect((await first).title).toBe("Finished");
  });

  it("caps cache rows before fetching a new URL", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const db = new Proxy(env.DB, {
      get(target, property) {
        if (property === "prepare")
          return (sql: string) =>
            sql.startsWith("SELECT COUNT(*) AS count FROM link_preview_cache")
              ? { bind: () => ({ first: async () => ({ count: 1_000 }) }) }
              : target.prepare(sql);
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(linkPreview({ ...env, DB: db }, "workspace", pageUrl)).rejects.toMatchObject({
      status: 429,
      code: "preview_cache_full",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects internal targets before fetch and never follows a private redirect", async () => {
    const fetcher = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: "https://127.0.0.1/admin" } }),
    );
    vi.stubGlobal("fetch", fetcher);
    await expect(linkPreview(env, "workspace", "https://127.0.0.1/admin")).rejects.toMatchObject({ status: 400 });
    const fallback = await linkPreview(env, "workspace", pageUrl);
    expect(fallback.imageUrl).toBeNull();
    expect(fallback.title).toBe("www.public-preview.org");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("stops after three public redirects", async () => {
    const fetcher = vi.fn(
      async (_url: string, _options: RequestInit) =>
        new Response(null, { status: 302, headers: { location: `/hop-${fetcher.mock.calls.length}` } }),
    );
    vi.stubGlobal("fetch", fetcher);
    expect((await linkPreview(env, "workspace", pageUrl)).title).toBe("www.public-preview.org");
    expect(fetcher).toHaveBeenCalledTimes(4);
    for (const call of fetcher.mock.calls) expect(call[1].redirect).toBe("manual");
  });

  it("turns oversized HTML and hostile image responses into plain links", async () => {
    const fetcher = vi.fn(async (url: string) =>
      url === pageUrl
        ? new Response("x".repeat(512 * 1024 + 1), { headers: { "content-type": "text/html" } })
        : new Response("<script>bad()</script>", { headers: { "content-type": "text/html" } }),
    );
    vi.stubGlobal("fetch", fetcher);
    expect((await linkPreview(env, "workspace", pageUrl)).imageUrl).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("retries an expired failure and replays the cache migration safely", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response("<title>Recovered</title>", { headers: { "content-type": "text/html" } }));
    vi.stubGlobal("fetch", fetcher);
    const fallback = await linkPreview(env, "workspace", pageUrl);
    expect(fallback.title).toBe("www.public-preview.org");
    expect(fallback.expiresAt - Date.now()).toBeLessThanOrEqual(5 * 60 * 1000);
    expect((await linkPreview(env, "workspace", pageUrl)).title).toBe(fallback.title);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await env.DB.prepare("UPDATE link_preview_cache SET expires_at = 1 WHERE id = ?").bind(fallback.id).run();
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
    const refreshed = await linkPreview(env, "workspace", pageUrl);
    expect(refreshed.title).toBe("Recovered");
    expect(refreshed.id).toBe(fallback.id);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not proxy HTML posing as an image or images over the byte limit", async () => {
    const fetcher = vi.fn(async (url: string) =>
      url === pageUrl
        ? new Response(`<title>Safe</title><meta property="og:image" content="${imageUrl}">`, {
            headers: { "content-type": "text/html" },
          })
        : new Response("<script>bad()</script>", { headers: { "content-type": "image/png" } }),
    );
    vi.stubGlobal("fetch", fetcher);
    expect((await linkPreview(env, "workspace", pageUrl)).imageUrl).toBeNull();
    await env.DB.prepare("UPDATE link_preview_cache SET expires_at = 1").run();
    fetcher.mockImplementation(async (url: string) =>
      url === pageUrl
        ? new Response(`<title>Safe</title><meta property="og:image" content="${imageUrl}">`, {
            headers: { "content-type": "text/html" },
          })
        : new Response(new Uint8Array(2 * 1024 * 1024 + 1), { headers: { "content-type": "image/png" } }),
    );
    expect((await linkPreview(env, "workspace", pageUrl)).imageUrl).toBeNull();
  });

  it("returns a safe miss when an R2 image disappears after metadata was cached", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url === pageUrl
          ? new Response(`<meta property="og:image" content="${imageUrl}">`, {
              headers: { "content-type": "text/html" },
            })
          : new Response(png, { headers: { "content-type": "image/png" } }),
      ),
    );
    const preview = await linkPreview(env, "workspace", pageUrl);
    const row = await env.DB.prepare("SELECT image_key FROM link_preview_cache WHERE id = ?")
      .bind(preview.id)
      .first<{ image_key: string }>();
    expect(row?.image_key).toBeTruthy();
    await env.BUCKET.delete(row!.image_key);
    await expect(linkPreviewImage(env, "workspace", preview.id)).rejects.toMatchObject({ status: 404 });
    expect((await linkPreview(env, "workspace", pageUrl)).url).toBe(pageUrl);
  });
});
