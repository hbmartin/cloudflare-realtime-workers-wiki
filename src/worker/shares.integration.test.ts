import { abortAllDurableObjects, applyD1Migrations, env, reset, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

function authenticated(cookie: string, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("cookie", cookie);
  headers.set("origin", "http://example.test");
  return SELF.fetch(new Request(`http://example.test${path}`, { ...init, headers }));
}

async function bootstrap() {
  const response = await SELF.fetch("http://example.test/api/install/bootstrap", {
    method: "POST",
    headers: { origin: "http://example.test", "content-type": "application/json" },
    body: JSON.stringify({
      bootstrapToken: "worker-bootstrap-token",
      workspaceName: "Public Share Test",
      name: "Owner",
      email: "owner@example.test",
      password: "password123",
    }),
  });
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  const me = await (
    await authenticated(cookie, "/api/me")
  ).json<{
    user: { id: string };
    workspace: { id: string };
  }>();
  const tree = await (await authenticated(cookie, "/api/pages/tree")).json<{ pages: Array<{ id: string }> }>();
  return { cookie, pageId: tree.pages[0]!.id, userId: me.user.id, workspaceId: me.workspace.id };
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
});

describe("public page shares", () => {
  it("keeps a stable key, resolves descendants dynamically, honors indexing, and revokes immediately", async () => {
    const installed = await bootstrap();
    const childResponse = await authenticated(installed.cookie, "/api/pages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "document", parentId: installed.pageId, title: "Public child" }),
    });
    const child = (await childResponse.json<{ page: { id: string } }>()).page;
    const diagramResponse = await authenticated(installed.cookie, "/api/pages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "diagram", parentId: installed.pageId, title: "Internal diagram" }),
    });
    const diagram = (await diagramResponse.json<{ page: { id: string } }>()).page;
    const nestedResponse = await authenticated(installed.cookie, "/api/pages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "document", parentId: diagram.id, title: "Public nested document" }),
    });
    const nested = (await nestedResponse.json<{ page: { id: string } }>()).page;
    const published = await authenticated(installed.cookie, `/api/pages/${installed.pageId}/share`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(published.status).toBe(201);
    const share = (await published.json<{ share: { url: string } }>()).share;
    const key = new URL(share.url).pathname.split("/").at(-1)!;

    const root = await SELF.fetch(`http://example.test/share/${key}`);
    expect(root.status).toBe(200);
    expect(root.headers.get("cache-control")).toBe("no-store");
    expect(await root.text()).toContain("noindex,nofollow");
    expect((await SELF.fetch(`http://example.test/share/${key}/pages/${child.id}`)).status).toBe(404);

    const second = await authenticated(installed.cookie, `/api/pages/${installed.pageId}/share`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect((await second.json<{ share: { url: string } }>()).share.url).toBe(share.url);
    const updated = await authenticated(installed.cookie, `/api/pages/${installed.pageId}/share`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ includeSubpages: true, allowIndexing: true }),
    });
    expect(updated.status).toBe(200);
    const indexedRoot = await SELF.fetch(`http://example.test/share/${key}`);
    expect(indexedRoot.status).toBe(200);
    const indexedHtml = await indexedRoot.text();
    expect(indexedHtml).toContain('<meta name="robots" content="index,follow">');
    expect(indexedHtml).not.toContain("Internal diagram");
    expect(indexedHtml).toContain("Public nested document");
    expect((await SELF.fetch(`http://example.test/share/${key}/pages/${child.id}`)).status).toBe(200);
    expect((await SELF.fetch(`http://example.test/share/${key}/pages/${diagram.id}`)).status).toBe(404);
    expect((await SELF.fetch(`http://example.test/share/${key}/pages/${nested.id}`)).status).toBe(200);
    expect(
      (
        await SELF.fetch(
          `http://example.test/share/${key}/diagram-thumbnails/${diagram.id}.svg?source=${installed.pageId}`,
        )
      ).status,
    ).toBe(404);
    const sitemap = await SELF.fetch(`http://example.test/share/${key}/sitemap.xml`);
    expect(sitemap.status).toBe(200);
    const sitemapXml = await sitemap.text();
    expect(sitemapXml).toContain(child.id);
    expect(sitemapXml).toContain(nested.id);
    expect(sitemapXml).not.toContain(diagram.id);

    await authenticated(installed.cookie, `/api/pages/${installed.pageId}/share`, { method: "DELETE" });
    expect((await SELF.fetch(`http://example.test/share/${key}`)).status).toBe(404);
  });

  it("serves only diagram thumbnails explicitly linked from a shared document", async () => {
    const installed = await bootstrap();
    const createPage = async (kind: "diagram" | "document", title: string, parentId: string | null) => {
      const response = await authenticated(installed.cookie, "/api/pages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind, parentId, title }),
      });
      return (await response.json<{ page: { id: string } }>()).page;
    };
    const linkedDiagram = await createPage("diagram", "Linked system map", installed.pageId);
    const transcludedDiagram = await createPage("diagram", "Transcluded system map", installed.pageId);
    const unrelatedDiagram = await createPage("diagram", "Unrelated internal map", installed.pageId);
    const sourcePage = await createPage("document", "Synced source", installed.pageId);
    const outsideDiagram = await createPage("diagram", "Outside system map", null);
    const outsideSource = await createPage("document", "Outside source", null);
    const diagramAttachmentId = crypto.randomUUID();
    const diagramAttachmentKey = `assets/${installed.workspaceId}/${diagramAttachmentId}/private`;
    const thumbnailKey = `diagrams/${linkedDiagram.id}/epochs/1/thumbnail.svg`;
    const thumbnailSvg = '<svg xmlns="http://www.w3.org/2000/svg"><text>Projection node label</text></svg>';
    await Promise.all([
      env.BUCKET.put(diagramAttachmentKey, "private diagram attachment"),
      env.BUCKET.put(thumbnailKey, thumbnailSvg),
    ]);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO attachments
        (id, workspace_id, page_id, r2_key, name, mime, size, created_by, created_at)
       VALUES (?, ?, ?, ?, 'private.txt', 'text/plain', 26, ?, ?)`,
      ).bind(
        diagramAttachmentId,
        installed.workspaceId,
        linkedDiagram.id,
        diagramAttachmentKey,
        installed.userId,
        Date.now(),
      ),
      env.DB.prepare(
        `INSERT INTO diagram_projections
          (page_id, content_epoch, sequence, schema_version, r2_key, content_hash, byte_size,
           thumbnail_r2_key, thumbnail_hash, thumbnail_byte_size, updated_at)
         VALUES (?, 1, 1, 1, ?, 'content-hash', 1, ?, 'thumbnail-hash', ?, ?)`,
      ).bind(
        linkedDiagram.id,
        `diagrams/${linkedDiagram.id}/epochs/1/projection.json`,
        thumbnailKey,
        thumbnailSvg.length,
        Date.now(),
      ),
    ]);

    const source = new Y.Doc();
    const linked = new Y.XmlElement("linkedDiagram");
    linked.setAttribute("pageId", linkedDiagram.id);
    linked.setAttribute("title", "Linked system map");
    const reference = new Y.XmlElement("syncedBlockReference");
    reference.setAttribute("sourcePageId", sourcePage.id);
    reference.setAttribute("blockId", "system-map-source");
    source.getXmlFragment("document-store").insert(0, [linked, reference]);
    await env.BUCKET.put(`documents/${installed.pageId}/epochs/1/current.bin`, Y.encodeStateAsUpdate(source));

    const transclusionSource = new Y.Doc();
    const sourceGroup = new Y.XmlElement("blockGroup");
    const sourceContainer = new Y.XmlElement("blockContainer");
    sourceContainer.setAttribute("id", "system-map-container");
    const sourceMarker = new Y.XmlElement("syncedBlockSource");
    sourceMarker.setAttribute("blockId", "system-map-source");
    const sourceContent = new Y.XmlElement("blockGroup");
    const transcludedLink = new Y.XmlElement("linkedDiagram");
    transcludedLink.setAttribute("pageId", transcludedDiagram.id);
    transcludedLink.setAttribute("title", "Transcluded system map");
    sourceContent.insert(0, [transcludedLink]);
    sourceContainer.insert(0, [sourceMarker, sourceContent]);
    sourceGroup.insert(0, [sourceContainer]);
    transclusionSource.getXmlFragment("document-store").insert(0, [sourceGroup]);
    await env.BUCKET.put(`documents/${sourcePage.id}/epochs/1/current.bin`, Y.encodeStateAsUpdate(transclusionSource));

    const published = await authenticated(installed.cookie, `/api/pages/${installed.pageId}/share`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const share = (await published.json<{ share: { url: string } }>()).share;
    const key = new URL(share.url).pathname.split("/").at(-1)!;
    const linkedThumbnailUrl = `/share/${key}/diagram-thumbnails/${linkedDiagram.id}.svg?source=${installed.pageId}`;
    const transcludedThumbnailUrl = `/share/${key}/diagram-thumbnails/${transcludedDiagram.id}.svg?source=${sourcePage.id}`;

    const rootOnly = await SELF.fetch(`http://example.test/share/${key}`);
    expect(rootOnly.status).toBe(200);
    expect(await rootOnly.text()).not.toContain("diagram-thumbnails");
    const expanded = await authenticated(installed.cookie, `/api/pages/${installed.pageId}/share`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ includeSubpages: true }),
    });
    expect(expanded.status).toBe(200);

    const root = await SELF.fetch(`http://example.test/share/${key}`);
    expect(root.status).toBe(200);
    const rootHtml = await root.text();
    expect(rootHtml).toContain(`src="${linkedThumbnailUrl}"`);
    expect(rootHtml).toContain(`src="${transcludedThumbnailUrl}"`);

    const thumbnail = await SELF.fetch(`http://example.test${linkedThumbnailUrl}`);
    expect(thumbnail.status).toBe(200);
    expect(thumbnail.headers.get("content-type")).toContain("image/svg+xml");
    expect(thumbnail.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await thumbnail.text()).toContain("Projection node label");
    await expect(
      env.DB.prepare(
        `SELECT 1 linked
           FROM linked_diagram_references reference JOIN pages page ON page.id = reference.source_page_id
          WHERE reference.source_page_id = ? AND reference.target_page_id = ?
            AND reference.projection_seq = page.indexed_seq`,
      )
        .bind(installed.pageId, linkedDiagram.id)
        .first(),
    ).resolves.toEqual({ linked: 1 });
    expect((await SELF.fetch(`http://example.test${transcludedThumbnailUrl}`)).status).toBe(200);

    expect(
      (await SELF.fetch(`http://example.test/share/${key}/diagram-thumbnails/${linkedDiagram.id}.svg`)).status,
    ).toBe(404);
    expect(
      (
        await SELF.fetch(
          `http://example.test/share/${key}/diagram-thumbnails/${unrelatedDiagram.id}.svg?source=${installed.pageId}`,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await SELF.fetch(
          `http://example.test/share/${key}/diagram-thumbnails/${outsideDiagram.id}.svg?source=${installed.pageId}`,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await SELF.fetch(
          `http://example.test/share/${key}/diagram-thumbnails/${linkedDiagram.id}.svg?source=${outsideSource.id}`,
        )
      ).status,
    ).toBe(404);
    expect(
      (await SELF.fetch(`http://example.test/share/${key}/assets/${diagramAttachmentId}?page=${linkedDiagram.id}`))
        .status,
    ).toBe(404);

    await env.BUCKET.put(`documents/${installed.pageId}/epochs/1/current.bin`, Y.encodeStateAsUpdate(new Y.Doc()));
    await env.DB.prepare(`DELETE FROM linked_diagram_references WHERE source_page_id = ?`).bind(installed.pageId).run();
    await abortAllDurableObjects();
    expect((await SELF.fetch(`http://example.test${linkedThumbnailUrl}`)).status).toBe(404);
    expect((await SELF.fetch(`http://example.test${transcludedThumbnailUrl}`)).status).toBe(200);
  });

  it("limits public tables to 500 rows and tells the reader when truncated", async () => {
    const installed = await bootstrap();
    const pageResponse = await authenticated(installed.cookie, "/api/pages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "table", parentId: null, title: "Large table" }),
    });
    expect(pageResponse.status).toBe(201);
    const page = (await pageResponse.json<{ page: { id: string } }>()).page;
    const columnId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO table_columns (id, page_id, name, type, position) VALUES (?, ?, 'Name', 'text', 0)`,
    )
      .bind(columnId, page.id)
      .run();
    const timestamp = Date.now();
    for (let start = 0; start < 501; start += 50) {
      await env.DB.batch(
        Array.from({ length: Math.min(50, 501 - start) }, (_, offset) => {
          const index = start + offset;
          return env.DB.prepare(
            `INSERT INTO table_rows (id, page_id, position, created_by, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          ).bind(crypto.randomUUID(), page.id, index, installed.userId, timestamp, timestamp);
        }),
      );
    }
    const published = await authenticated(installed.cookie, `/api/pages/${page.id}/share`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const key = new URL((await published.json<{ share: { url: string } }>()).share.url).pathname.split("/").at(-1)!;

    const response = await SELF.fetch(`http://example.test/share/${key}`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html.match(/<tr>/g) ?? []).toHaveLength(501);
    expect(html).toContain("limited to the first 500 rows");
  });

  it("forces non-inline public attachments to download with a safe filename", async () => {
    const installed = await bootstrap();
    const attachmentId = crypto.randomUUID();
    const key = `assets/${installed.workspaceId}/${attachmentId}/test`;
    await env.BUCKET.put(key, new Uint8Array([1, 2, 3]));
    await env.DB.prepare(
      `INSERT INTO attachments
        (id, workspace_id, page_id, r2_key, name, mime, size, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, 'application/x-custom', 3, ?, ?)`,
    )
      .bind(
        attachmentId,
        installed.workspaceId,
        installed.pageId,
        key,
        'unsafe"\r\nname.bin',
        installed.userId,
        Date.now(),
      )
      .run();
    const published = await authenticated(installed.cookie, `/api/pages/${installed.pageId}/share`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const shareKey = new URL((await published.json<{ share: { url: string } }>()).share.url).pathname
      .split("/")
      .at(-1)!;

    const response = await SELF.fetch(`http://example.test/share/${shareKey}/assets/${attachmentId}`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-disposition")).toContain("attachment;");
    expect(response.headers.get("content-disposition")).not.toMatch(/[\r\n]/);
  });
});
