import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex } from "../../src/shared/import-integrity.ts";
import { AmbiguousWriteError, createClient, validateBaseURL } from "./api-client.mjs";

vi.mock("../../src/shared/retry.ts", () => ({ jitteredBackoff: () => 0 }));

const json = (body, init = {}) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });

function authenticatedFetch(...later) {
  const mock = vi
    .fn()
    .mockResolvedValueOnce(json({ initialized: true }))
    .mockResolvedValueOnce(
      json(
        { user: { id: "user" } },
        { headers: { "set-cookie": "better-auth.session_token=token; Path=/; HttpOnly" } },
      ),
    )
    .mockResolvedValueOnce(json({ role: "owner", workspace: { id: "workspace" } }));
  for (const response of later) mock.mockResolvedValueOnce(response);
  return mock;
}

const temporaryDirectories = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("createClient", () => {
  it("checks the install response before parsing it", async () => {
    const fetch = vi.fn(async () => new Response("upstream failure", { status: 502 }));
    vi.stubGlobal("fetch", fetch);

    await expect(
      createClient({ baseURL: "https://notes.example.test", email: "owner@example.test", password: "password" }),
    ).rejects.toThrow(/did not answer \/api\/install \(502\)/);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("retries deterministic page creation after a server failure", async () => {
    const fetch = authenticatedFetch(
      json({ error: { code: "failed" } }, { status: 503 }),
      json({ pages: [{ id: "page-1" }], replayed: true }),
    );
    vi.stubGlobal("fetch", fetch);
    const client = await createClient({
      baseURL: "https://notes.example.test",
      email: "owner@example.test",
      password: "password",
      requestsPerSecond: 1_000_000,
    });

    await expect(client.createPages([{ id: "page-1", title: "Page" }])).resolves.toEqual([{ id: "page-1" }]);
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it("rejects non-HTTPS remote origins and all URL credentials or paths", () => {
    expect(() => validateBaseURL("http://notes.example.test")).toThrow(/must use HTTPS/);
    expect(() => validateBaseURL("https://user:secret@notes.example.test")).toThrow(/credentials/);
    expect(() => validateBaseURL("https://notes.example.test/app")).toThrow(/origin without a path/);
    expect(validateBaseURL("http://127.0.0.1:4173")).toBe("http://127.0.0.1:4173");
  });

  it("sends deterministic content metadata on a single-shot attachment", async () => {
    const content = new TextEncoder().encode("hello");
    const contentSha256 = await sha256Hex(content);
    const fetch = authenticatedFetch(
      json({
        attachment: {
          id: "asset-1",
          pageId: "page-1",
          name: "hello.txt",
          mime: "text/plain",
          size: content.byteLength,
          contentSha256,
        },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const client = await createClient({
      baseURL: "https://notes.example.test",
      email: "owner@example.test",
      password: "password",
      requestsPerSecond: 1_000_000,
    });

    await client.uploadAttachment("page-1", "hello.txt", "text/plain", content, {
      attachmentId: "asset-1",
      contentSha256,
    });
    const init = fetch.mock.calls[3][1];
    expect(init.redirect).toBe("error");
    expect(init.body.get("attachmentId")).toBe("asset-1");
    expect(init.body.get("contentSha256")).toBe(contentSha256);
    expect(init.body.get("requestHash")).toMatch(/^[a-f\d]{64}$/);
  });

  it("streams a large attachment in bounded resumable parts", async () => {
    const directory = mkdtempSync(join(tmpdir(), "notion-upload-test-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "large.bin");
    const content = Buffer.alloc(8 * 1024 * 1024 + 1, 7);
    writeFileSync(path, content);
    const contentSha256 = await sha256Hex(content);
    const upload = {
      id: "asset-large",
      pageId: "page-1",
      name: "large.bin",
      mime: "application/octet-stream",
      size: content.length,
      contentSha256,
      partSize: 5 * 1024 * 1024,
      partCount: 2,
    };
    const attachment = { ...upload };
    const fetch = authenticatedFetch(
      json({ error: { code: "upload_not_found" } }, { status: 404 }),
      json({ status: "active", upload, replayed: false }, { status: 201 }),
      json({ part: { partNumber: 1 } }),
      json({ part: { partNumber: 2 } }),
      json({ status: "committed", attachment }),
    );
    vi.stubGlobal("fetch", fetch);
    const client = await createClient({
      baseURL: "https://notes.example.test",
      email: "owner@example.test",
      password: "password",
      requestsPerSecond: 1_000_000,
    });

    await expect(
      client.uploadAttachment(
        "page-1",
        "large.bin",
        "application/octet-stream",
        { path, size: content.length },
        { attachmentId: "asset-large", contentSha256 },
      ),
    ).resolves.toMatchObject({ id: "asset-large", contentSha256 });
    const partCalls = fetch.mock.calls.filter(
      ([url, init]) => init.method === "PUT" && url.pathname.includes("/parts/"),
    );
    expect(partCalls.map(([, init]) => init.body.byteLength)).toEqual([5 * 1024 * 1024, 3 * 1024 * 1024 + 1]);
  });

  it("replays multipart completion after a committed response body is lost", async () => {
    const directory = mkdtempSync(join(tmpdir(), "notion-upload-response-loss-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "large.bin");
    const content = Buffer.alloc(8 * 1024 * 1024 + 1, 3);
    writeFileSync(path, content);
    const contentSha256 = await sha256Hex(content);
    const upload = {
      id: "asset-response-loss",
      pageId: "page-1",
      name: "large.bin",
      mime: "application/octet-stream",
      size: content.length,
      contentSha256,
      partSize: 5 * 1024 * 1024,
      partCount: 2,
    };
    const malformedSuccess = new Response("{", {
      status: 201,
      headers: { "content-type": "application/json" },
    });
    const fetch = authenticatedFetch(
      json({ error: { code: "upload_not_found" } }, { status: 404 }),
      json({ status: "active", upload, replayed: false }, { status: 201 }),
      json({ part: { partNumber: 1 } }),
      json({ part: { partNumber: 2 } }),
      malformedSuccess,
      json({ status: "committed", attachment: upload, replayed: true }),
    );
    vi.stubGlobal("fetch", fetch);
    const client = await createClient({
      baseURL: "https://notes.example.test",
      email: "owner@example.test",
      password: "password",
      requestsPerSecond: 1_000_000,
    });

    await expect(
      client.uploadAttachment(
        "page-1",
        "large.bin",
        "application/octet-stream",
        { path, size: content.length },
        { attachmentId: upload.id, contentSha256 },
      ),
    ).resolves.toMatchObject({ id: upload.id, contentSha256 });
    expect(
      fetch.mock.calls.filter(([url, init]) => init.method === "POST" && url.pathname.endsWith("/complete")),
    ).toHaveLength(2);
  });

  it("retries a bulk write carrying an idempotency key", async () => {
    const fetch = authenticatedFetch(
      json({ error: { code: "failed" } }, { status: 503 }),
      json({ revision: 2, replayed: true }, { status: 201 }),
    );
    vi.stubGlobal("fetch", fetch);
    const client = await createClient({
      baseURL: "https://notes.example.test",
      email: "owner@example.test",
      password: "password",
      requestsPerSecond: 1_000_000,
    });

    await expect(
      client.bulkTableWrite("page", {
        leaseToken: "lease",
        expectedRevision: 1,
        clientRequestId: "database#0",
        columns: [],
        rows: [{}],
      }),
    ).resolves.toMatchObject({ revision: 2, replayed: true });
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it("retries an unreadable success only for a replay-safe write", async () => {
    const malformed = new Response("{", { status: 201, headers: { "content-type": "application/json" } });
    const fetch = authenticatedFetch(malformed, json({ pages: [{ id: "page-1" }], replayed: true }));
    vi.stubGlobal("fetch", fetch);
    const client = await createClient({
      baseURL: "https://notes.example.test",
      email: "owner@example.test",
      password: "password",
      requestsPerSecond: 1_000_000,
    });

    await expect(client.createPages([{ id: "page-1", title: "Page" }])).resolves.toEqual([{ id: "page-1" }]);
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it("does not retry an unprotected POST and reports an unreadable success as ambiguous", async () => {
    const malformed = new Response("{", { status: 201, headers: { "content-type": "application/json" } });
    const fetch = authenticatedFetch(malformed);
    vi.stubGlobal("fetch", fetch);
    const client = await createClient({
      baseURL: "https://notes.example.test",
      email: "owner@example.test",
      password: "password",
      requestsPerSecond: 1_000_000,
    });

    await expect(client.request("/api/unprotected", { method: "POST", body: "{}" })).rejects.toBeInstanceOf(
      AmbiguousWriteError,
    );
    expect(fetch).toHaveBeenCalledTimes(4);
  });
});
