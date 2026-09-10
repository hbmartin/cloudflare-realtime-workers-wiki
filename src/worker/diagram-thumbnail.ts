import { renderDiagramSvg } from "../shared/diagram";
import { sha256Hex } from "../shared/import-integrity";
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
  if (projection) {
    const etag = `"${projection.thumbnail_hash}"`;
    const headers = thumbnailHeaders(options.cacheControl, etag);
    if (options.ifNoneMatch === etag && (await env.BUCKET.head(projection.thumbnail_r2_key))) {
      return new Response(null, { status: 304, headers });
    }
    const thumbnail = await env.BUCKET.get(projection.thumbnail_r2_key);
    if (thumbnail) {
      return new Response(thumbnail.body, { headers });
    }
  }
  const empty: DiagramContentEnvelope = {
    schemaVersion: 1,
    pageId: page.id,
    contentEpoch: page.content_epoch,
    sequence: 0,
    nodes: [],
    edges: [],
  };
  const placeholder = renderDiagramSvg(empty, { width: 960, height: 540, title: page.title });
  const etag = `"empty-${await sha256Hex(placeholder)}"`;
  const headers = thumbnailHeaders(options.cacheControl, etag);
  if (options.ifNoneMatch === etag) return new Response(null, { status: 304, headers });
  return new Response(placeholder, { headers });
}

function thumbnailHeaders(cacheControl: string, etag: string) {
  return new Headers({
    "content-type": "image/svg+xml; charset=utf-8",
    "cache-control": cacheControl,
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
    "x-content-type-options": "nosniff",
    etag,
  });
}
