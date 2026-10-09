import type { AiSource, AiSourceSnapshot } from "../shared/ai";
import { AI_MAX_CHARACTERS } from "../shared/ai";
import type { DiagramContentEnvelope, DocumentContentEnvelope, MemberContext, ProseMirrorJson } from "../shared/types";
import { documentBlocks } from "../shared/notion-blocks";
import { serializeDocument } from "../shared/document-projection";
import type { Env } from "./env";
import { HttpError, locationHint } from "./http";
import { correlationHeaders } from "./observability";
import { pageForMember, type PageRow } from "./page-access";
import { buildTableRowQuery, collectRowCells, stableTableSnapshot, tableRowBinds } from "./table-read";
import { seal, unseal } from "./ai-auth";

function sourceUrl(env: Env, pageId: string) {
  return `${new URL(env.BETTER_AUTH_URL).origin}/?page=${encodeURIComponent(pageId)}`;
}
export async function readRoomContent<T extends DocumentContentEnvelope | DiagramContentEnvelope>(
  env: Env,
  member: MemberContext,
  page: PageRow,
): Promise<T> {
  const hint = locationHint(member.workspace.locationHint ?? undefined);
  const response = await env.DOCUMENT.getByName(
    `${page.id}~${page.content_epoch}`,
    hint ? { locationHint: hint } : undefined,
  ).fetch(
    new Request("https://document.internal/content", {
      headers: { "x-notes-internal": env.BETTER_AUTH_SECRET, ...correlationHeaders() },
      signal: AbortSignal.timeout(20_000),
    }),
  );
  if (!response.ok) throw new HttpError(503, "content_unavailable", "Page content is temporarily unavailable.");
  const envelope = await response.json<T>();
  if (envelope.pageId !== page.id || envelope.contentEpoch !== page.content_epoch)
    throw new HttpError(409, "source_changed", "The page was restored. Reload its source.");
  const latest = await pageForMember(env, member, page.id);
  if (latest.content_epoch !== page.content_epoch)
    throw new HttpError(409, "source_changed", "The page was restored. Reload its source.");
  return envelope;
}
async function readTableChunk(
  env: Env,
  member: MemberContext,
  pageId: string,
  query: Record<string, string | undefined>,
) {
  const page = await pageForMember(env, member, pageId);
  if (page.kind !== "table") throw new HttpError(422, "table_required", "Choose a table page.");
  const { snapshot, revision, rowCount } = await stableTableSnapshot(env, pageId, true, async () => {
    const columns = await env.DB.prepare(
      "SELECT id,name,type,position FROM table_columns WHERE page_id=? ORDER BY position,id",
    )
      .bind(pageId)
      .all<{ id: string; name: string; type: "text" | "number" | "checkbox" | "date" | "select"; position: number }>();
    const options = await env.DB.prepare(
      "SELECT o.id,o.column_id,o.label,o.position FROM table_select_options o JOIN table_columns c ON c.id=o.column_id WHERE c.page_id=? ORDER BY o.position,o.id",
    )
      .bind(pageId)
      .all<{ id: string; column_id: string; label: string; position: number }>();
    const rowQuery = buildTableRowQuery(pageId, columns.results, query);
    const rows = await env.DB.prepare(
      `WITH page_rows AS (${rowQuery.sql}) SELECT page_rows.id row_id,page_rows.position row_position,cell.column_id,cell.text_value,cell.number_value,cell.boolean_value,cell.date_value,cell.select_value FROM page_rows LEFT JOIN table_cells cell ON cell.row_id=page_rows.id ORDER BY ${rowQuery.orderSql},cell.column_id`,
    )
      .bind(...tableRowBinds(rowQuery, rowQuery.limit + 1))
      .all<Record<string, unknown>>();
    return {
      columns: columns.results.map((column) => ({
        ...column,
        options: options.results
          .filter((option) => option.column_id === column.id)
          .map(({ id, label, position }) => ({ id, label, position })),
      })),
      rows: collectRowCells(rows.results),
      limit: rowQuery.limit,
    };
  });
  const latest = await pageForMember(env, member, pageId);
  if (latest.content_epoch !== page.content_epoch)
    throw new HttpError(409, "source_changed", "The table was restored during retrieval. Start the read again.");
  return {
    page,
    revision,
    rowCount: rowCount ?? 0,
    columns: snapshot.columns,
    rows: snapshot.rows.slice(0, snapshot.limit),
    hasMore: snapshot.rows.length > snapshot.limit,
  };
}
function bounded(text: string) {
  if (text.length > AI_MAX_CHARACTERS)
    throw new HttpError(
      413,
      "source_too_large",
      "This source is larger than the writing limit. Select fewer document blocks, filter table rows, or select fewer diagram nodes.",
    );
  return text;
}
export async function readAiSource(env: Env, member: MemberContext, source: AiSource): Promise<AiSourceSnapshot> {
  const page = await pageForMember(env, member, source.pageId);
  let text: string,
    sequence = 0,
    revision = page.revision;
  if (page.kind === "table") {
    if (source.scope.kind !== "page" && source.scope.kind !== "table")
      throw new HttpError(422, "invalid_source_scope", "Use a table filter for a table source.");
    const query: Record<string, string> = { limit: "500", q: source.scope.kind === "table" ? source.scope.filter : "" };
    const first = await readTableChunk(env, member, page.id, query);
    revision = first.revision;
    const rows = [...first.rows];
    text = bounded(JSON.stringify({ columns: first.columns, rows }));
    let chunk = first;
    while (chunk.hasMore) {
      const last = chunk.rows.at(-1)!;
      chunk = await readTableChunk(env, member, page.id, {
        ...query,
        afterId: last.id,
        afterPosition: String(last.position),
      });
      if (chunk.revision !== revision)
        throw new HttpError(
          409,
          "source_changed",
          "The table changed during retrieval. Retry with its current contents.",
        );
      rows.push(...chunk.rows);
      text = bounded(JSON.stringify({ columns: first.columns, rows }));
    }
  } else if (page.kind === "diagram") {
    if (source.scope.kind !== "page" && source.scope.kind !== "diagram")
      throw new HttpError(422, "invalid_source_scope", "Choose diagram nodes for a diagram source.");
    const envelope = await readRoomContent<DiagramContentEnvelope>(env, member, page);
    sequence = envelope.sequence;
    const ids = source.scope.kind === "diagram" ? new Set(source.scope.nodeIds) : null;
    if (ids && [...ids].some((id) => !envelope.nodes.some((node) => node.id === id)))
      throw new HttpError(
        409,
        "source_selection_lost",
        "Some selected diagram nodes no longer exist. Select them again.",
      );
    const nodes = envelope.nodes
      .filter((node) => !ids || ids.has(node.id))
      .map(({ id, type, label, notes, parentId, references, mentions }) => ({
        id,
        type,
        label,
        notes,
        parentId,
        references,
        mentions,
      }));
    const edges = envelope.edges
      .filter((edge) => !ids || (ids.has(edge.source) && ids.has(edge.target)))
      .map(({ id, source: edgeSource, target, label, arrow }) => ({ id, source: edgeSource, target, label, arrow }));
    text = bounded(JSON.stringify({ nodes, edges }));
  } else {
    const envelope = await readRoomContent<DocumentContentEnvelope>(env, member, page);
    sequence = envelope.sequence;
    let document = envelope.document;
    if (source.scope.kind === "blocks" || source.scope.kind === "selection") {
      if (source.scope.contentEpoch !== envelope.contentEpoch)
        throw new HttpError(409, "source_selection_lost", "The document was restored. Select its source again.");
      const ids = new Set(source.scope.blockIds);
      const blocks = documentBlocks(document);
      const found = new Set<string>();
      const pick = (items: typeof blocks): ProseMirrorJson[] =>
        items.flatMap((block) => {
          if (ids.has(block.internalId)) {
            found.add(block.internalId);
            return [
              {
                type: "blockContainer",
                attrs: { id: block.internalId },
                content: [
                  block.node,
                  ...(block.children.length ? [{ type: "blockGroup", content: pick(block.children) }] : []),
                ],
              },
            ];
          }
          return pick(block.children);
        });
      document = { type: "doc", content: [{ type: "blockGroup", content: pick(blocks) }] };
      if ([...ids].some((id) => !found.has(id)))
        throw new HttpError(
          409,
          "source_selection_lost",
          "Some selected document blocks no longer exist. Select them again.",
        );
    } else if (source.scope.kind !== "page")
      throw new HttpError(422, "invalid_source_scope", "Choose document text or blocks for a document source.");
    // The projection deliberately excludes attachment bytes. It has a larger
    // internal safety cap than the writing budget; never send a partial projection.
    const projection = serializeDocument(document, { pageHref: (id) => sourceUrl(env, id), mediaHref: () => null });
    if (projection.plainText.length >= 500_000)
      throw new HttpError(413, "source_too_large", "Select a smaller part of this document.");
    if (source.scope.kind === "selection") {
      if (!projection.plainText.includes(source.scope.text.replace(/\s+/g, " ").trim()))
        throw new HttpError(409, "source_selection_lost", "The selected text changed. Select it again.");
      text = bounded(source.scope.text);
    } else text = bounded(projection.markdown);
  }
  return {
    pageId: page.id,
    title: page.title,
    url: sourceUrl(env, page.id),
    kind: page.kind,
    revision,
    contentEpoch: page.content_epoch,
    sequence,
    text,
  };
}

type Cursor = {
  offset?: number;
  position?: number;
  rowId?: string;
  revision: number;
  epoch: number;
  sequence?: number;
  expiresAt: number;
};
async function decodeCursor(env: Env, binding: string, cursor?: string): Promise<Cursor | null> {
  if (!cursor) return null;
  try {
    const value = await unseal<Cursor>(env.BETTER_AUTH_SECRET, binding, cursor);
    if (value.expiresAt <= Date.now()) throw new Error("Expired cursor.");
    return value;
  } catch {
    throw new HttpError(
      422,
      "invalid_source_cursor",
      "This cursor expired or belongs to a different source, query, or connection. Read the first page again.",
    );
  }
}
export async function fetchTableSource(
  env: Env,
  member: MemberContext,
  actor: string,
  input: {
    page_id: string;
    filter?: string | undefined;
    column_ids?: string[] | undefined;
    cursor?: string | undefined;
  },
) {
  const binding = `table:${member.workspace.id}:${member.user.id}:${actor}:${input.page_id}:${input.filter ?? ""}:${JSON.stringify(input.column_ids ?? [])}`;
  const cursor = await decodeCursor(env, binding, input.cursor);
  const chunk = await readTableChunk(env, member, input.page_id, {
    q: input.filter ?? "",
    limit: "50",
    ...(cursor ? { afterId: cursor.rowId, afterPosition: String(cursor.position) } : {}),
  });
  if (cursor && (cursor.revision !== chunk.revision || cursor.epoch !== chunk.page.content_epoch))
    throw new HttpError(409, "source_changed", "The table changed between pages. Start the read again.");
  const ids = input.column_ids ? new Set(input.column_ids) : null;
  if (ids && [...ids].some((id) => !chunk.columns.some((column) => column.id === id)))
    throw new HttpError(422, "invalid_column", "A requested column does not belong to this table.");
  const columns = chunk.columns.filter((column) => !ids || ids.has(column.id));
  const rows = [];
  let bytes = new TextEncoder().encode(JSON.stringify(columns)).length;
  if (bytes > 48_000) throw new HttpError(413, "table_schema_too_large", "Choose fewer column_ids to read this table.");
  for (const row of chunk.rows) {
    const value = {
      id: row.id,
      position: row.position,
      cells: Object.fromEntries(Object.entries(row.cells).filter(([id]) => !ids || ids.has(id))),
    };
    const size = new TextEncoder().encode(JSON.stringify(value)).length;
    if (bytes + size > 48_000) break;
    rows.push(value);
    bytes += size;
  }
  if (!rows.length && chunk.rows.length)
    throw new HttpError(413, "table_row_too_large", "A row is too large for one response. Choose fewer column_ids.");
  const hasMore = chunk.hasMore || rows.length < chunk.rows.length;
  const last = rows.at(-1);
  return {
    id: chunk.page.id,
    title: chunk.page.title,
    url: sourceUrl(env, chunk.page.id),
    revision: chunk.revision,
    contentEpoch: chunk.page.content_epoch,
    columns,
    rows,
    totalRows: chunk.rowCount,
    complete: !hasMore,
    filter: input.filter ?? "",
    nextCursor:
      hasMore && last
        ? await seal(env.BETTER_AUTH_SECRET, binding, {
            revision: chunk.revision,
            epoch: chunk.page.content_epoch,
            position: last.position,
            rowId: last.id,
            expiresAt: Date.now() + 15 * 60_000,
          } satisfies Cursor)
        : null,
  };
}
export async function fetchDiagramSource(
  env: Env,
  member: MemberContext,
  actor: string,
  input: { page_id: string; cursor?: string | undefined },
) {
  const binding = `diagram:${member.workspace.id}:${member.user.id}:${actor}:${input.page_id}`;
  const cursor = await decodeCursor(env, binding, input.cursor);
  const page = await pageForMember(env, member, input.page_id);
  if (page.kind !== "diagram") throw new HttpError(422, "diagram_required", "Choose a diagram page.");
  const envelope = await readRoomContent<DiagramContentEnvelope>(env, member, page);
  if (
    cursor &&
    (cursor.revision !== page.revision || cursor.epoch !== page.content_epoch || cursor.sequence !== envelope.sequence)
  )
    throw new HttpError(409, "source_changed", "The diagram changed between pages. Start the read again.");
  const entities = [
    ...envelope.nodes.map(({ id, type, label, notes, parentId, references, mentions }) => ({
      entity: "node" as const,
      id,
      type,
      label,
      notes,
      parentId,
      references,
      mentions,
    })),
    ...envelope.edges.map(({ id, source, target, label, arrow }) => ({
      entity: "edge" as const,
      id,
      source,
      target,
      label,
      arrow,
    })),
  ];
  const items: typeof entities = [];
  let bytes = 0;
  for (const entity of entities.slice(cursor?.offset ?? 0, (cursor?.offset ?? 0) + 250)) {
    const size = new TextEncoder().encode(JSON.stringify(entity)).length;
    if (bytes + size > 48_000) break;
    items.push(entity);
    bytes += size;
  }
  const offset = (cursor?.offset ?? 0) + items.length;
  if (!items.length && offset < entities.length)
    throw new HttpError(413, "diagram_entity_too_large", "A diagram entity exceeds the response budget.");
  const complete = offset >= entities.length;
  return {
    id: page.id,
    title: page.title,
    url: sourceUrl(env, page.id),
    revision: page.revision,
    contentEpoch: page.content_epoch,
    sequence: envelope.sequence,
    items,
    totalNodes: envelope.nodes.length,
    totalEdges: envelope.edges.length,
    complete,
    nextCursor: complete
      ? null
      : await seal(env.BETTER_AUTH_SECRET, binding, {
          revision: page.revision,
          epoch: page.content_epoch,
          sequence: envelope.sequence,
          offset,
          expiresAt: Date.now() + 15 * 60_000,
        } satisfies Cursor),
  };
}
