import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient } from "./api-client.mjs";

vi.mock("../../src/shared/retry.ts", () => ({ jitteredBackoff: () => 0 }));

const json = (body, init = {}) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });

function authenticatedFetch(...later) {
  return vi
    .fn()
    .mockResolvedValueOnce(json({ initialized: true }))
    .mockResolvedValueOnce(
      json(
        { user: { id: "user" } },
        { headers: { "set-cookie": "better-auth.session_token=token; Path=/; HttpOnly" } },
      ),
    )
    .mockResolvedValueOnce(json({ role: "owner", workspace: { id: "workspace" } }))
    .mockResolvedValueOnce(later[0])
    .mockResolvedValueOnce(later[1]);
}

afterEach(() => {
  vi.unstubAllGlobals();
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

  it("does not retry page creation after a server failure", async () => {
    const fetch = authenticatedFetch(json({ error: { code: "failed" } }, { status: 503 }));
    vi.stubGlobal("fetch", fetch);
    const client = await createClient({
      baseURL: "https://notes.example.test",
      email: "owner@example.test",
      password: "password",
      requestsPerSecond: 1_000_000,
    });

    await expect(client.createPages([{ title: "Page" }])).rejects.toMatchObject({ status: 503 });
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
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
});
