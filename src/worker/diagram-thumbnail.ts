import { renderDiagramSvg } from "../shared/diagram";
import type { DiagramContentEnvelope } from "../shared/types";
import type { Env } from "./env";

export type DiagramThumbnailPage = {
  id: string;
  content_epoch: number;
  title: string;
};

export async function diagramThumbnailResponse(
  env: Env,
  page: DiagramThumbnailPage,
  options: { cacheControl: string; ifNoneMatch?: string },
) {
  const projection = await env.DB.prepare(
    `SELECT thumbnail_r2_key, thumbnail_hash FROM diagram_projections
      WHERE page_id = ? AND content_epoch = ?`,
  )
    .bind(page.id, page.content_epoch)
    .first<{ thumbnail_r2_key: string; thumbnail_hash: string }>();
  const etag = `"${projection?.thumbnail_hash ?? `empty-${page.content_epoch}`}"`;
  const headers = new Headers({
    "content-type": "image/svg+xml; charset=utf-8",
    "cache-control": options.cacheControl,
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
    "x-content-type-options": "nosniff",
    etag,
  });
  if (options.ifNoneMatch === etag) return new Response(null, { status: 304, headers });
  if (projection) {
    const thumbnail = await env.BUCKET.get(projection.thumbnail_r2_key);
    if (thumbnail) return new Response(thumbnail.body, { headers });
  }
  const empty: DiagramContentEnvelope = {
    schemaVersion: 1,
    pageId: page.id,
    contentEpoch: page.content_epoch,
    sequence: 0,
    nodes: [],
    edges: [],
  };
  return new Response(renderDiagramSvg(empty, { width: 960, height: 540, title: page.title }), { headers });
}
