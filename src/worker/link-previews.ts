import type { Env } from "./env";
import { HttpError, sha256 } from "./http";

const SUCCESS_TTL = 24 * 60 * 60 * 1000;
const FAILURE_TTL = 5 * 60 * 1000;
const MAX_HTML = 512 * 1024;
const MAX_IMAGE = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const FETCH_TIMEOUT = 10_000;
const REFRESH_LEASE = 30_000;
const MAX_WORKSPACE_PREVIEWS = 1_000;
const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

function rasterSignature(mime: string, bytes: Uint8Array) {
  if (mime === "image/png")
    return bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value);
  if (mime === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mime === "image/gif")
    return bytes.length >= 6 && new TextDecoder().decode(bytes.slice(0, 6)).match(/^GIF8[79]a$/) !== null;
  if (mime === "image/webp")
    return (
      bytes.length >= 12 &&
      new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" &&
      new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP"
    );
  return false;
}

type CacheRow = {
  id: string;
  workspace_id: string;
  canonical_url: string;
  title: string;
  description: string;
  site_name: string;
  image_key: string | null;
  image_mime: string | null;
  expires_at: number;
  fetched_at: number;
};

function publicUrl(value: string, base?: string): URL {
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    throw new HttpError(400, "preview_url_invalid", "Use a public HTTPS URL.");
  }
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !host.includes(".") ||
    host.length > 253 ||
    !/^[a-z0-9.-]+$/.test(host) ||
    host.split(".").some((part) => !part || part.startsWith("-") || part.endsWith("-")) ||
    /(^|\.)(localhost|local|internal|test|invalid|example)$/.test(host) ||
    /^\d+(?:\.\d+){3}$/.test(host) ||
    host.includes(":") ||
    url.href.length > 2_000
  ) {
    throw new HttpError(400, "preview_url_invalid", "Use a public HTTPS URL.");
  }
  url.hash = "";
  return url;
}

async function fetchPublic(url: URL, signal: AbortSignal): Promise<{ response: Response; url: URL }> {
  let current = url;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const response = await fetch(current.href, {
      redirect: "manual",
      signal,
      headers: { accept: "text/html,image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.1" },
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return { response, url: current };
    if (redirects === MAX_REDIRECTS) throw new Error("Too many preview redirects.");
    const location = response.headers.get("location");
    if (!location) throw new Error("Preview redirect has no location.");
    current = publicUrl(location, current.href);
    await response.body?.cancel();
  }
  throw new Error("Too many preview redirects.");
}

async function boundedBytes(response: Response, max: number): Promise<Uint8Array> {
  if (Number(response.headers.get("content-length") ?? 0) > max) throw new Error("Preview response is too large.");
  if (!response.body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let length = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > max) throw new Error("Preview response is too large.");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

const NAMED_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&nbsp;": " ",
  "&lsquo;": "‘",
  "&rsquo;": "’",
  "&ldquo;": "“",
  "&rdquo;": "”",
  "&mdash;": "—",
  "&ndash;": "–",
  "&hellip;": "…",
};

function decodeEntities(value: string) {
  return value.replace(
    /&(?:amp|lt|gt|quot|apos|nbsp|lsquo|rsquo|ldquo|rdquo|mdash|ndash|hellip|#(?:x[0-9a-f]+|[0-9]+));/gi,
    (entity) => {
      const replacement = NAMED_ENTITIES[entity.toLowerCase()];
      if (replacement) return replacement;
      const numeric = entity.slice(2, -1);
      const point = numeric[0]?.toLowerCase() === "x" ? Number.parseInt(numeric.slice(1), 16) : Number(numeric);
      return Number.isInteger(point) && point > 0 && point <= 0x10ffff && (point < 0xd800 || point > 0xdfff)
        ? String.fromCodePoint(point)
        : " ";
    },
  );
}

function decodeText(value: string) {
  return decodeEntities(value.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function metadata(html: string) {
  const properties = new Map<string, string>();
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attributes = new Map<string, string>();
    for (const attribute of match[0].matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      attributes.set(attribute[1]!.toLowerCase(), attribute[2] ?? attribute[3] ?? "");
    }
    const name = (attributes.get("property") ?? attributes.get("name") ?? "").toLowerCase();
    if (name && attributes.has("content")) properties.set(name, attributes.get("content")!);
  }
  const documentTitle = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "";
  const field = (value: string | undefined, max: number) => decodeText(value ?? "").slice(0, max);
  return {
    title: field(properties.get("og:title") || properties.get("twitter:title") || documentTitle, 200),
    description: field(properties.get("og:description") || properties.get("description"), 500),
    siteName: field(properties.get("og:site_name"), 100),
    image: decodeEntities(properties.get("og:image") || properties.get("twitter:image") || "") || null,
  };
}

function responsePreview(row: CacheRow) {
  return {
    id: row.id,
    url: row.canonical_url,
    title: row.title,
    description: row.description,
    siteName: row.site_name,
    imageUrl: row.image_key ? `/api/link-previews/${row.id}/image` : null,
    expiresAt: row.expires_at,
  };
}

async function waitForRefresh(env: Env, workspaceId: string, id: string) {
  const deadline = Date.now() + FETCH_TIMEOUT + 5_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const current = await env.DB.prepare("SELECT * FROM link_preview_cache WHERE id = ? AND workspace_id = ?")
      .bind(id, workspaceId)
      .first<CacheRow>();
    if (current && current.fetched_at >= 0 && current.expires_at > Date.now()) return responsePreview(current);
  }
  throw new HttpError(503, "preview_pending", "Link preview is still being fetched. Try again shortly.");
}

export async function linkPreview(env: Env, workspaceId: string, value: string, beforeFetch?: () => Promise<void>) {
  const url = publicUrl(value);
  const id = await sha256(`${workspaceId}\0${url.href}`);
  const existing = await env.DB.prepare("SELECT * FROM link_preview_cache WHERE id = ? AND workspace_id = ?")
    .bind(id, workspaceId)
    .first<CacheRow>();
  const now = Date.now();
  if (existing && existing.expires_at > now)
    return existing.fetched_at < 0 ? waitForRefresh(env, workspaceId, id) : responsePreview(existing);
  await beforeFetch?.();
  if (existing) {
    const claimed = await env.DB.prepare(
      "UPDATE link_preview_cache SET expires_at = ?, fetched_at = ? WHERE id = ? AND workspace_id = ? AND expires_at <= ?",
    )
      .bind(now + REFRESH_LEASE, -now, id, workspaceId, now)
      .run();
    if (!claimed.meta.changes) {
      const current = await env.DB.prepare("SELECT * FROM link_preview_cache WHERE id = ? AND workspace_id = ?")
        .bind(id, workspaceId)
        .first<CacheRow>();
      if (current) return current.fetched_at < 0 ? waitForRefresh(env, workspaceId, id) : responsePreview(current);
    }
  }
  if (!existing) {
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM link_preview_cache WHERE workspace_id = ? AND expires_at > ?",
    )
      .bind(workspaceId, now)
      .first<{ count: number }>();
    if ((count?.count ?? 0) >= MAX_WORKSPACE_PREVIEWS)
      throw new HttpError(429, "preview_cache_full", "This workspace has too many cached previews.");
    const claimed = await env.DB.prepare(
      `INSERT OR IGNORE INTO link_preview_cache
        (id,workspace_id,canonical_url,title,description,site_name,image_key,image_mime,expires_at,fetched_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`,
    )
      .bind(id, workspaceId, url.href, url.hostname, "", url.hostname, null, null, now + REFRESH_LEASE, -now)
      .run();
    if (!claimed.meta.changes) {
      const current = await env.DB.prepare("SELECT * FROM link_preview_cache WHERE id = ? AND workspace_id = ?")
        .bind(id, workspaceId)
        .first<CacheRow>();
      if (current) return current.fetched_at < 0 ? waitForRefresh(env, workspaceId, id) : responsePreview(current);
    }
  }

  let title = url.hostname;
  let description = "";
  let siteName = url.hostname;
  let imageKey: string | null = null;
  let imageMime: string | null = null;
  let succeeded = false;
  try {
    const signal = AbortSignal.timeout(FETCH_TIMEOUT);
    const page = await fetchPublic(url, signal);
    if (!page.response.ok || !/^text\/html(?:;|$)/i.test(page.response.headers.get("content-type") ?? "")) {
      throw new Error("Preview is not HTML.");
    }
    const parsed = metadata(new TextDecoder().decode(await boundedBytes(page.response, MAX_HTML)));
    title = parsed.title || title;
    description = parsed.description;
    siteName = parsed.siteName || siteName;
    succeeded = true;
    if (parsed.image) {
      try {
        const image = await fetchPublic(publicUrl(parsed.image, page.url.href), signal);
        const mime = image.response.headers.get("content-type")?.split(";", 1)[0]?.toLowerCase() ?? "";
        if (image.response.ok && IMAGE_MIMES.has(mime)) {
          const bytes = await boundedBytes(image.response, MAX_IMAGE);
          if (rasterSignature(mime, bytes)) {
            const key = `link-previews/${workspaceId}/${id}/${crypto.randomUUID()}`;
            // Reserve the key for cleanup before writing R2; D1 and R2 cannot commit atomically.
            await env.DB.prepare("INSERT OR IGNORE INTO link_preview_image_gc (image_key,queued_at) VALUES (?,?)")
              .bind(key, Date.now() + 60_000)
              .run();
            await env.BUCKET.put(key, bytes, { httpMetadata: { contentType: mime } });
            imageKey = key;
            imageMime = mime;
          }
        }
      } catch {
        // Image retrieval is optional; the text preview and durable link remain usable.
      }
    }
  } catch {
    // A failed external request is a short-lived plain link card.
  }
  if (!succeeded && existing && existing.fetched_at > 0) {
    title = existing.title;
    description = existing.description;
    siteName = existing.site_name;
    imageKey = existing.image_key;
    imageMime = existing.image_mime;
  }
  const expiresAt = Date.now() + (succeeded ? SUCCESS_TTL : FAILURE_TTL);
  const save = env.DB.prepare(
    `INSERT INTO link_preview_cache
      (id,workspace_id,canonical_url,title,description,site_name,image_key,image_mime,expires_at,fetched_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title,description=excluded.description,
        site_name=excluded.site_name,image_key=excluded.image_key,image_mime=excluded.image_mime,
        expires_at=excluded.expires_at,fetched_at=excluded.fetched_at`,
  ).bind(id, workspaceId, url.href, title, description, siteName, imageKey, imageMime, expiresAt, Date.now());
  const statements: D1PreparedStatement[] = [];
  if (existing?.image_key && existing.image_key !== imageKey)
    statements.push(
      env.DB.prepare("INSERT OR IGNORE INTO link_preview_image_gc (image_key,queued_at) VALUES (?,?)").bind(
        existing.image_key,
        Date.now(),
      ),
    );
  statements.push(save);
  if (imageKey && imageKey !== existing?.image_key)
    statements.push(env.DB.prepare("DELETE FROM link_preview_image_gc WHERE image_key = ?").bind(imageKey));
  try {
    await env.DB.batch(statements);
  } catch (cause) {
    // A failed R2 delete leaves the staged key in D1 for the scheduled cleanup.
    if (imageKey && imageKey !== existing?.image_key) await env.BUCKET.delete(imageKey).catch(() => {});
    throw cause;
  }
  return responsePreview({
    id,
    workspace_id: workspaceId,
    canonical_url: url.href,
    title,
    description,
    site_name: siteName,
    image_key: imageKey,
    image_mime: imageMime,
    expires_at: expiresAt,
    fetched_at: Date.now(),
  });
}

export async function linkPreviewImage(env: Env, workspaceId: string, id: string) {
  if (!/^[0-9a-f]{64}$/.test(id)) throw new HttpError(404, "preview_not_found", "Preview image not found.");
  const row = await env.DB.prepare(
    "SELECT image_key,image_mime FROM link_preview_cache WHERE id = ? AND workspace_id = ? AND expires_at > ?",
  )
    .bind(id, workspaceId, Date.now())
    .first<{ image_key: string | null; image_mime: string | null }>();
  if (!row?.image_key || !row.image_mime || !IMAGE_MIMES.has(row.image_mime)) {
    throw new HttpError(404, "preview_not_found", "Preview image not found.");
  }
  const object = await env.BUCKET.get(row.image_key);
  if (!object) throw new HttpError(404, "preview_not_found", "Preview image not found.");
  return new Response(object.body, {
    headers: {
      "content-type": row.image_mime,
      "content-length": String(object.size),
      "cache-control": "private, max-age=300",
      "x-content-type-options": "nosniff",
    },
  });
}

export async function pruneLinkPreviews(env: Env) {
  const now = Date.now();
  const expired = "SELECT id FROM link_preview_cache WHERE expires_at <= ? ORDER BY expires_at LIMIT 100";
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO link_preview_image_gc (image_key,queued_at)
       SELECT image_key, ? FROM link_preview_cache WHERE id IN (${expired}) AND image_key IS NOT NULL`,
    ).bind(now, now),
    env.DB.prepare(`DELETE FROM link_preview_cache WHERE id IN (${expired})`).bind(now),
  ]);
  const rows = await env.DB.prepare(
    "SELECT image_key FROM link_preview_image_gc WHERE queued_at <= ? ORDER BY queued_at LIMIT 100",
  )
    .bind(Date.now())
    .all<{ image_key: string }>();
  const keys = rows.results.map((row) => row.image_key);
  if (!keys.length) return;
  await env.BUCKET.delete(keys);
  await env.DB.prepare(`DELETE FROM link_preview_image_gc WHERE image_key IN (${keys.map(() => "?").join(",")})`)
    .bind(...keys)
    .run();
}
