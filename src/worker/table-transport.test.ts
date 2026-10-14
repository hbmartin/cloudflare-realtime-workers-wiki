import { describe, expect, it, vi } from "vitest";
import { decodeTableResponse, tableReadPages } from "./table-transport";

describe("internal table transport", () => {
  it("preserves valid typed errors and details without trusting malformed envelopes", async () => {
    await expect(
      decodeTableResponse(
        Response.json(
          {
            error: {
              code: "table_snapshot_changed",
              message: "Retry the capture.",
              details: { revision: 4 },
            },
          },
          { status: 409 },
        ),
      ),
    ).rejects.toMatchObject({
      status: 409,
      code: "table_snapshot_changed",
      message: "Retry the capture.",
      details: { revision: 4 },
    });
    await expect(
      decodeTableResponse(
        Response.json(
          {
            error: {
              code: "table_not_seeded",
              message: "Seed the table.",
            },
          },
          { status: 503 },
        ),
      ),
    ).rejects.toMatchObject({ status: 503, code: "table_not_seeded" });
    await expect(
      decodeTableResponse(Response.json({ error: { code: "table_not_seeded" } }, { status: 503 })),
    ).rejects.toMatchObject({
      status: 503,
      code: "table_not_seeded",
      message: "Table data is temporarily unavailable. Please retry shortly.",
    });
  });

  it.each([
    "",
    "upstream unavailable",
    "{",
    "null",
    "[]",
    '{"error":null}',
    '{"error":{"code":"table_not_seeded","message":4}}',
    '{"error":{"code":4,"message":"Retry"}}',
    '{"error":{"code":"INVALID_CODE","message":"Retry"}}',
  ])("maps an unreadable error body to the caller's safe retry response: %s", async (body) => {
    await expect(
      decodeTableResponse(new Response(body, { status: 503 }), {
        code: "deletion_evidence_unavailable",
        message: "Retry evidence capture.",
      }),
    ).rejects.toMatchObject({ status: 503, code: "deletion_evidence_unavailable", message: "Retry evidence capture." });
  });

  it("maps failed stream reads and malformed successful bodies to a retryable error", async () => {
    const broken = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error("broken"));
        },
      }),
      {
        status: 502,
      },
    );
    await expect(decodeTableResponse(broken)).rejects.toMatchObject({
      status: 503,
      code: "table_response_unavailable",
    });
    await expect(decodeTableResponse(new Response("{"))).rejects.toMatchObject({ status: 503 });
  });

  it("pins pagination to the first revision and stops at a completed cursor", async () => {
    const read = vi.fn(async (params: URLSearchParams) => ({
      revision: 7,
      rows: params.has("after") ? ["row-z"] : ["row-a"],
      nextCursor: params.has("after") ? null : "row-a",
    }));
    const chunks = [];
    for await (const chunk of tableReadPages(read)) chunks.push(chunk);
    expect(chunks.flatMap((chunk) => chunk.rows)).toEqual(["row-a", "row-z"]);
    expect(read.mock.calls.map(([params]) => params.toString())).toEqual(["", "after=row-a&revision=7"]);
  });

  it("does not yield a changed-revision page", async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce({ revision: 7, nextCursor: "row-a" })
      .mockResolvedValueOnce({ revision: 8, nextCursor: null });
    const pages = tableReadPages(read);
    await expect(pages.next()).resolves.toMatchObject({ done: false });
    await expect(pages.next()).rejects.toMatchObject({ status: 409, code: "table_snapshot_changed" });
  });

  it.each([
    { revision: -1, nextCursor: null },
    { revision: 1.5, nextCursor: null },
    { revision: 1, nextCursor: "" },
    { revision: 1, nextCursor: 4 },
  ])("rejects malformed page metadata", async (chunk) => {
    const read = vi.fn().mockResolvedValue(chunk);
    await expect(tableReadPages(read).next()).rejects.toMatchObject({ status: 503 });
  });

  it("rejects a repeated cursor instead of looping", async () => {
    const pages = tableReadPages(async () => ({ revision: 1, nextCursor: "row-a" }));
    await pages.next();
    await expect(pages.next()).rejects.toMatchObject({ status: 503 });
  });
});
