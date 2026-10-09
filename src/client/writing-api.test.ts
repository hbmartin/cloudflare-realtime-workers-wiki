// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { onApiUnauthorized } from "./api";
import { streamWriting } from "./writing-api";
import type { AiGenerate } from "../shared/ai";
const input: AiGenerate = {
  operationId: "operation",
  pageId: "page",
  action: "rewrite",
  prompt: "",
  funding: "api",
  quality: "fast",
  sources: [{ pageId: "page", scope: { kind: "page" } }],
};
afterEach(() => vi.unstubAllGlobals());
describe("writing authentication failures", () => {
  it.each([401, 424, 502, 503])("only HTTP 401 (%i) invokes application authentication handling", async (status) => {
    const handler = vi.fn(),
      unsubscribe = onApiUnauthorized(handler);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { error: { code: status === 424 ? "chatgpt_reconnect" : "failed", message: "Try again" } },
          { status },
        ),
      ),
    );
    try {
      await expect(streamWriting(input, new AbortController().signal, vi.fn())).rejects.toMatchObject({ status });
      expect(handler).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
    } finally {
      unsubscribe();
    }
  });
  it("routes in-stream session revocation through application authentication handling", async () => {
    const handler = vi.fn(),
      unsubscribe = onApiUnauthorized(handler),
      event = { type: "error", code: "challenge_required", message: "Sign in", status: 401 };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(`data: ${JSON.stringify(event)}\n\n`)),
    );
    try {
      const onEvent = vi.fn();
      await streamWriting(input, new AbortController().signal, onEvent);
      expect(handler).toHaveBeenCalledOnce();
      expect(onEvent).toHaveBeenCalledWith(event);
    } finally {
      unsubscribe();
    }
  });
});
