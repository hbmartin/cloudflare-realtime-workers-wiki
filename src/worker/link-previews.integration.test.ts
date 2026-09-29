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
    const oldKey = (await env.DB.prepare("SELECT image_key FROM link_preview_cache WHERE id = ?")
      .bind(first.id)
      .first<{ image_key: string }>())!.image_key;
    await pruneLinkPreviews(env);
    await expect(linkPreviewImage(env, "workspace", first.id)).rejects.toMatchObject({ status: 404 });
    expect(await env.DB.prepare("SELECT id FROM link_preview_cache WHERE id = ?").bind(first.id).first()).toBeNull();
    expect(await env.BUCKET.get(oldKey)).toBeNull();
  });

  it("retries R2 cleanup after a bucket failure without losing the key", async () => {
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
    const key = (await env.DB.prepare("SELECT image_key FROM link_preview_cache WHERE id = ?")
      .bind(preview.id)
      .first<{ image_key: string }>())!.image_key;
    await env.DB.prepare("UPDATE link_preview_cache SET expires_at = 1 WHERE id = ?").bind(preview.id).run();
    const bucket = new Proxy(env.BUCKET, {
      get(target, property) {
        if (property === "delete")
          return async () => {
            throw new Error("R2 unavailable");
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(pruneLinkPreviews({ ...env, BUCKET: bucket })).rejects.toThrow("R2 unavailable");
    expect(await env.DB.prepare("SELECT id FROM link_preview_cache WHERE id = ?").bind(preview.id).first()).toBeNull();
    expect(
      await env.DB.prepare("SELECT image_key FROM link_preview_image_gc WHERE image_key = ?").bind(key).first(),
    ).toBeTruthy();
    await pruneLinkPreviews(env);
    expect(await env.BUCKET.get(key)).toBeNull();
    expect(
      await env.DB.prepare("SELECT image_key FROM link_preview_image_gc WHERE image_key = ?").bind(key).first(),
    ).toBeNull();
  });

  it("reclaims a superseded image without removing the refreshed one", async () => {
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
    const first = await linkPreview(env, "workspace", pageUrl);
    const oldKey = (await env.DB.prepare("SELECT image_key FROM link_preview_cache WHERE id = ?")
      .bind(first.id)
      .first<{ image_key: string }>())!.image_key;
    await env.DB.prepare("UPDATE link_preview_cache SET expires_at = 1 WHERE id = ?").bind(first.id).run();
    const second = await linkPreview(env, "workspace", pageUrl);
    const newKey = (await env.DB.prepare("SELECT image_key FROM link_preview_cache WHERE id = ?")
      .bind(first.id)
      .first<{ image_key: string }>())!.image_key;
    expect(second.imageUrl).toBe(first.imageUrl);
    expect(newKey).not.toBe(oldKey);
    await pruneLinkPreviews(env);
    expect(await env.BUCKET.get(oldKey)).toBeNull();
    expect(await env.BUCKET.get(newKey)).toBeTruthy();
  });

  it("removes a stale image when refreshed metadata has no usable image", async () => {
    const fetcher = vi.fn(async (url: string) =>
      url === pageUrl
        ? new Response(`<title>Updated</title><meta property="og:image" content="${imageUrl}">`, {
            headers: { "content-type": "text/html" },
          })
        : new Response(png, { headers: { "content-type": "image/png" } }),
    );
    vi.stubGlobal("fetch", fetcher);
    const first = await linkPreview(env, "workspace", pageUrl);
    const key = (await env.DB.prepare("SELECT image_key FROM link_preview_cache WHERE id=?")
      .bind(first.id)
      .first<{ image_key: string }>())!.image_key;
    await env.DB.prepare("UPDATE link_preview_cache SET expires_at=1 WHERE id=?").bind(first.id).run();
    fetcher.mockImplementation(async (url: string) => {
      if (url === imageUrl) throw new Error("Image unavailable");
      return new Response(`<title>New title</title><meta property="og:image" content="${imageUrl}">`, {
        headers: { "content-type": "text/html" },
      });
    });
    const refreshed = await linkPreview(env, "workspace", pageUrl);
    expect(refreshed.title).toBe("New title");
    expect(refreshed.imageUrl).toBeNull();
    await pruneLinkPreviews(env);
    expect(await env.BUCKET.get(key)).toBeNull();
  });

  it("does not claim a replacement row using a stale cache snapshot", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<title>Original</title>", { headers: { "content-type": "text/html" } })),
    );
    const first = await linkPreview(env, "workspace", pageUrl);
    await env.DB.prepare("UPDATE link_preview_cache SET expires_at=1 WHERE id=?").bind(first.id).run();
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const db = new Proxy(env.DB, {
      get(target, property) {
        if (property === "prepare")
          return (sql: string) => {
            const prepared = target.prepare(sql);
            if (!sql.startsWith("UPDATE link_preview_cache SET refresh_until")) return prepared;
            return {
              bind: (...args: unknown[]) => ({
                run: async () => {
                  await target.prepare("DELETE FROM link_preview_cache WHERE id=?").bind(first.id).run();
                  await target
                    .prepare(
                      `INSERT INTO link_preview_cache
                     (id,workspace_id,canonical_url,title,description,site_name,expires_at,fetched_at,refresh_until)
                     VALUES (?,?,?,?,?,?,?,?,0)`,
                    )
                    .bind(first.id, "workspace", pageUrl, "Replacement", "", "site", 1, Date.now())
                    .run();
                  return prepared.bind(...args).run();
                },
              }),
            };
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(linkPreview({ ...env, DB: db as D1Database }, "workspace", pageUrl)).rejects.toMatchObject({
      status: 503,
      code: "preview_pending",
    });
    expect(
      (
        await env.DB.prepare("SELECT title FROM link_preview_cache WHERE id=?")
          .bind(first.id)
          .first<{ title: string }>()
      )?.title,
    ).toBe("Replacement");
    expect(fetcher).not.toHaveBeenCalled();
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

  it("decodes common named entities in preview titles", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response('<meta property="og:title" content="Tips &amp; Tricks &mdash; It&rsquo;s here">', {
            headers: { "content-type": "text/html" },
          }),
      ),
    );
    expect((await linkPreview(env, "workspace", pageUrl)).title).toBe("Tips & Tricks — It’s here");
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
    expect(
      (await env.DB.prepare("SELECT COUNT(*) AS count FROM link_preview_image_gc").first<{ count: number }>())?.count,
    ).toBe(0);
  });

  it("reclaims a staged image when D1 fails and immediate R2 cleanup fails", async () => {
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
    const db = new Proxy(env.DB, {
      get(target, property) {
        if (property === "batch")
          return async () => {
            throw new Error("D1 unavailable");
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const bucket = new Proxy(env.BUCKET, {
      get(target, property) {
        if (property === "delete")
          return async () => {
            throw new Error("R2 unavailable");
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(linkPreview({ ...env, DB: db, BUCKET: bucket }, "workspace", pageUrl)).rejects.toThrow(
      "D1 unavailable",
    );
    const staged = await env.DB.prepare("SELECT image_key FROM link_preview_image_gc").first<{ image_key: string }>();
    expect(staged).toBeTruthy();
    expect(await env.BUCKET.get(staged!.image_key)).toBeTruthy();
    await env.DB.prepare("UPDATE link_preview_image_gc SET queued_at = 1").run();
    await pruneLinkPreviews(env);
    expect(await env.BUCKET.get(staged!.image_key)).toBeNull();
  });

  it("retains an image when D1 commits but its batch response fails", async () => {
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
    const db = new Proxy(env.DB, {
      get(target, property) {
        if (property === "batch")
          return async (statements: D1PreparedStatement[]) => {
            await target.batch(statements);
            throw new Error("D1 response lost");
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const preview = await linkPreview({ ...env, DB: db }, "workspace", pageUrl);
    expect(preview.imageUrl).toBe(`/api/link-previews/${preview.id}/image`);
    const row = await env.DB.prepare("SELECT image_key FROM link_preview_cache WHERE workspace_id=?")
      .bind("workspace")
      .first<{ image_key: string }>();
    expect(row?.image_key).toBeTruthy();
    expect(await env.BUCKET.get(row!.image_key)).toBeTruthy();
    await pruneLinkPreviews(env);
    expect(await env.BUCKET.get(row!.image_key)).toBeTruthy();
  });

  it("cannot overwrite a newer preview after losing the refresh lease", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url === pageUrl
          ? new Response(`<title>Older result</title><meta property="og:image" content="${imageUrl}">`, {
              headers: { "content-type": "text/html" },
            })
          : new Response(png, { headers: { "content-type": "image/png" } }),
      ),
    );
    const winnerKey = "link-previews/workspace/newer-winner";
    let loserKey = "";
    const db = new Proxy(env.DB, {
      get(target, property) {
        if (property === "batch")
          return async (statements: D1PreparedStatement[]) => {
            loserKey = (await env.DB.prepare("SELECT image_key FROM link_preview_image_gc").first<{
              image_key: string;
            }>())!.image_key;
            await env.BUCKET.put(winnerKey, png, { httpMetadata: { contentType: "image/png" } });
            await env.DB.prepare(
              `UPDATE link_preview_cache SET title='Newer result',image_key=?,image_mime='image/png',
               fetched_at=?,expires_at=?,refresh_until=0 WHERE workspace_id='workspace'`,
            )
              .bind(winnerKey, Date.now(), Date.now() + 60_000)
              .run();
            return target.batch(statements);
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const preview = await linkPreview({ ...env, DB: db }, "workspace", pageUrl);
    expect(preview.title).toBe("Newer result");
    expect(loserKey).toBeTruthy();
    expect(await env.BUCKET.get(loserKey)).toBeNull();
    expect(await env.BUCKET.get(winnerKey)).toBeTruthy();
    expect(
      await env.DB.prepare("SELECT image_key FROM link_preview_image_gc WHERE image_key=?").bind(loserKey).first(),
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
    const pending = linkPreview(env, "workspace", pageUrl);
    expect(fetcher).toHaveBeenCalledOnce();
    release(new Response("<title>Finished</title>", { headers: { "content-type": "text/html" } }));
    expect((await first).title).toBe("Finished");
    expect((await pending).title).toBe("Finished");
  });

  it("charges in-progress callers before they poll D1", async () => {
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
    const gate = vi.fn(async () => {
      throw new Error("rate limited");
    });
    await expect(linkPreview(env, "workspace", pageUrl, gate)).rejects.toThrow("rate limited");
    expect(gate).toHaveBeenCalledOnce();
    release(new Response("<title>Finished</title>", { headers: { "content-type": "text/html" } }));
    await first;
  });

  it("caps cache rows before fetching a new URL", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const db = new Proxy(env.DB, {
      get(target, property) {
        if (property === "prepare")
          return (sql: string) =>
            sql.startsWith("SELECT (SELECT COUNT(*) FROM link_preview_cache")
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

  it("returns a cache-limit response when R2 cleanup fails at the cap", async () => {
    await env.DB.prepare(
      `INSERT INTO link_preview_image_gc (image_key,queued_at)
       WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<1000)
       SELECT printf('link-previews/workspace/orphan-%04d',n), 1 FROM seq`,
    ).run();
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const bucket = new Proxy(env.BUCKET, {
      get(target, property) {
        if (property === "delete")
          return async () => {
            throw new Error("R2 unavailable");
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(linkPreview({ ...env, BUCKET: bucket }, "workspace", pageUrl)).rejects.toMatchObject({
      status: 429,
      code: "preview_cache_full",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reclaims expired rows at the cap while counting queued R2 images", async () => {
    await env.DB.prepare(
      `INSERT INTO link_preview_cache
       (id,workspace_id,canonical_url,title,description,site_name,image_key,image_mime,expires_at,fetched_at)
       WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<100)
       SELECT printf('other-%04d',n),'other-workspace',printf('https://www.public-preview.org/other/%d',n),
         'Other','','site',NULL,NULL,0,1 FROM seq`,
    ).run();
    await env.DB.prepare(
      `INSERT INTO link_preview_cache
       (id,workspace_id,canonical_url,title,description,site_name,image_key,image_mime,expires_at,fetched_at)
       WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<1000)
       SELECT printf('expired-%04d',n),'workspace',printf('https://www.public-preview.org/%d',n),
         'Old','','site',NULL,NULL,1,1 FROM seq`,
    ).run();
    const fetcher = vi.fn(async () => new Response("<title>New</title>", { headers: { "content-type": "text/html" } }));
    vi.stubGlobal("fetch", fetcher);
    expect((await linkPreview(env, "workspace", pageUrl)).title).toBe("New");
    expect(
      (
        await env.DB.prepare("SELECT COUNT(*) AS count FROM link_preview_cache WHERE workspace_id='workspace'").first<{
          count: number;
        }>()
      )?.count,
    ).toBe(901);
    expect(
      (
        await env.DB.prepare(
          "SELECT COUNT(*) AS count FROM link_preview_cache WHERE workspace_id='other-workspace'",
        ).first<{ count: number }>()
      )?.count,
    ).toBe(100);
    await env.DB.prepare(
      `INSERT INTO link_preview_image_gc (image_key,queued_at)
       WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<1000)
       SELECT printf('link-previews/workspace/orphan-%04d',n), ? FROM seq`,
    )
      .bind(Date.now() + 60_000)
      .run();
    await expect(linkPreview(env, "workspace", "https://www.public-preview.org/another")).rejects.toMatchObject({
      status: 429,
      code: "preview_cache_full",
    });
    expect(fetcher).toHaveBeenCalledOnce();
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

  it("keeps previously fetched metadata through a transient refresh failure", async () => {
    const fetcher = vi.fn(
      async () => new Response("<title>Original title</title>", { headers: { "content-type": "text/html" } }),
    );
    vi.stubGlobal("fetch", fetcher);
    const first = await linkPreview(env, "workspace", pageUrl);
    await env.DB.prepare("UPDATE link_preview_cache SET expires_at = 1, refresh_until = ? WHERE id = ?")
      .bind(Date.now() + 30_000, first.id)
      .run();
    await pruneLinkPreviews(env);
    expect(await env.DB.prepare("SELECT id FROM link_preview_cache WHERE id = ?").bind(first.id).first()).toBeTruthy();
    expect((await linkPreview(env, "workspace", pageUrl)).title).toBe("Original title");
    expect(fetcher).toHaveBeenCalledOnce();
    await env.DB.prepare("UPDATE link_preview_cache SET refresh_until = 1 WHERE id = ?").bind(first.id).run();
    fetcher.mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
    const refreshed = await linkPreview(env, "workspace", pageUrl);
    expect(refreshed.title).toBe("Original title");
    expect(refreshed.expiresAt - Date.now()).toBeLessThanOrEqual(5 * 60 * 1000);
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
