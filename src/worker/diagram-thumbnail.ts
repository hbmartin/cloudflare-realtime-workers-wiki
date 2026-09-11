import { DIAGRAM_THUMBNAIL_HEIGHT, DIAGRAM_THUMBNAIL_WIDTH, renderEmptyDiagramSvg } from "../shared/diagram";
import { sha256Hex } from "../shared/import-integrity";
import type { Env } from "./env";
import { weakEtagMatches } from "./r2";

export type DiagramThumbnailPage = {
  id: string;
  content_epoch: number;
  title: string;
};

export async function diagramThumbnailResponse(
  env: Env,
  page: DiagramThumbnailPage,
  options: { cacheControl: string; validators: boolean; ifNoneMatch?: string },
) {
  const projection = await env.DB.prepare(
    `SELECT thumbnail_r2_key, thumbnail_hash FROM diagram_projections
      WHERE page_id = ? AND content_epoch = ?`,
  )
    .bind(page.id, page.content_epoch)
    .first<{ thumbnail_r2_key: string; thumbnail_hash: string }>();
  if (projection) {
    const etag = options.validators ? `"${projection.thumbnail_hash}"` : undefined;
    const headers = thumbnailHeaders(options.cacheControl, etag);
    if (
      etag &&
      options.ifNoneMatch &&
      weakEtagMatches(options.ifNoneMatch, etag) &&
      (await env.BUCKET.head(projection.thumbnail_r2_key))
    ) {
      return new Response(null, { status: 304, headers });
    }
    const thumbnail = await env.BUCKET.get(projection.thumbnail_r2_key);
    if (thumbnail) {
      return new Response(thumbnail.body, { headers });
    }
  }
  const placeholder = renderEmptyDiagramSvg({
    width: DIAGRAM_THUMBNAIL_WIDTH,
    height: DIAGRAM_THUMBNAIL_HEIGHT,
    title: page.title,
  });
  const etag = options.validators ? `"empty-${await sha256Hex(placeholder)}"` : undefined;
  const headers = thumbnailHeaders(options.cacheControl, etag);
  if (etag && options.ifNoneMatch && weakEtagMatches(options.ifNoneMatch, etag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(placeholder, { headers });
}

function thumbnailHeaders(cacheControl: string, etag?: string) {
  const headers = new Headers({
    "content-type": "image/svg+xml; charset=utf-8",
    "cache-control": cacheControl,
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
    "x-content-type-options": "nosniff",
  });
  if (etag) headers.set("etag", etag);
  return headers;
}
