import { HttpError, safeHttpError, type HttpErrorStatus } from "./http";

const TABLE_UNAVAILABLE = {
  code: "table_response_unavailable",
  message: "Table data is temporarily unavailable. Please retry shortly.",
};

/** Internal responses may be interrupted or replaced by a non-JSON infrastructure error. */
export async function decodeTableResponse<T>(response: Response, unavailable = TABLE_UNAVAILABLE): Promise<T> {
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok && typeof body === "object" && body !== null && "error" in body) {
    const value = body.error;
    if (
      typeof value === "object" &&
      value !== null &&
      "code" in value &&
      typeof value.code === "string" &&
      (!("message" in value) || typeof value.message === "string")
    ) {
      const error = new HttpError(
        response.status as HttpErrorStatus,
        value.code,
        "message" in value ? (value.message as string) : unavailable.message,
        "details" in value ? value.details : undefined,
      );
      if (safeHttpError(error)) throw error;
    }
  }
  if (!response.ok || body === undefined) throw new HttpError(503, unavailable.code, unavailable.message);
  return body as T;
}

/** Every page is read at the first page's revision, using the endpoint's public cursor. */
export async function* tableReadPages<T extends { revision: number; nextCursor: string | null }>(
  read: (params: URLSearchParams) => Promise<T>,
) {
  let after: string | null = null;
  let revision: number | undefined;
  const cursors = new Set<string>();
  do {
    const params = new URLSearchParams();
    if (after !== null) params.set("after", after);
    if (revision !== undefined) params.set("revision", String(revision));
    const chunk = await read(params);
    if (
      !chunk ||
      !Number.isSafeInteger(chunk.revision) ||
      chunk.revision < 0 ||
      (chunk.nextCursor !== null &&
        (typeof chunk.nextCursor !== "string" || !chunk.nextCursor || cursors.has(chunk.nextCursor)))
    )
      throw new HttpError(503, TABLE_UNAVAILABLE.code, TABLE_UNAVAILABLE.message);
    if (revision !== undefined && chunk.revision !== revision)
      throw new HttpError(409, "table_snapshot_changed", "The table changed while its snapshot was captured. Retry.");
    revision = chunk.revision;
    after = chunk.nextCursor;
    if (after !== null) cursors.add(after);
    yield chunk;
  } while (after !== null);
}
