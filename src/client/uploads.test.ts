// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiClientError } from "./api";
import { resolveAttachmentUrl, uploadAttachment } from "./uploads";

vi.mock("./api", async (importOriginal) => {
  const original = await importOriginal<typeof import("./api")>();
  return { ...original, api: vi.fn() };
});

function fileOfSize(bytes: number, name = "clip.mp4", type = "video/mp4") {
  return new File([new Uint8Array(bytes)], name, { type });
}

describe("uploadAttachment", () => {
  beforeEach(() => {
    vi.mocked(api).mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends a small file in one request rather than negotiating a session", async () => {
    vi.mocked(api).mockResolvedValue({ attachment: { id: "a1", pageId: "p1", name: "n", mime: "m", size: 4 } });

    const attachment = await uploadAttachment("p1", fileOfSize(4, "small.png", "image/png"));

    expect(attachment.id).toBe("a1");
    expect(api).toHaveBeenCalledTimes(1);
    expect(api).toHaveBeenCalledWith("/api/pages/p1/attachments", expect.objectContaining({ method: "POST" }));
  });

  it("splits a large file into parts and completes the session", async () => {
    const partSize = 5 * 1024 * 1024;
    // Comfortably past SINGLE_SHOT_BYTES, or this would never reach the chunked path.
    const size = 9 * 1024 * 1024;
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === "/api/pages/p1/uploads") return { upload: { id: "u1", partSize, partCount: 2 } };
      if (path === "/api/uploads/u1/complete") {
        return { attachment: { id: "a2", pageId: "p1", name: "clip.mp4", mime: "video/mp4", size } };
      }
      return {};
    });

    const progress: number[] = [];
    const attachment = await uploadAttachment("p1", fileOfSize(size), (fraction) => progress.push(fraction));

    expect(attachment.id).toBe("a2");
    const paths = vi.mocked(api).mock.calls.map((call) => call[0]);
    expect(paths).toContain("/api/uploads/u1/parts/1");
    expect(paths).toContain("/api/uploads/u1/parts/2");
    expect(paths.at(-1)).toBe("/api/uploads/u1/complete");
    expect(progress.at(-1)).toBe(1);
  });

  it("releases the session when a part fails outright", async () => {
    const partSize = 5 * 1024 * 1024;
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === "/api/pages/p1/uploads") return { upload: { id: "u1", partSize, partCount: 2 } };
      // A 4xx is the caller's fault and is never retried, so this fails immediately.
      if (path.includes("/parts/")) throw new ApiClientError(415, "unsafe_file_type", "No.");
      return {};
    });

    await expect(uploadAttachment("p1", fileOfSize(9 * 1024 * 1024))).rejects.toThrow("No.");

    expect(vi.mocked(api).mock.calls.map((call) => call[0])).toContain("/api/uploads/u1");
  });

  it("reconciles a lost completion response from committed status", async () => {
    const size = 9 * 1024 * 1024;
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === "/api/pages/p1/uploads") {
        return { upload: { id: "u1", partSize: 5 * 1024 * 1024, partCount: 2 } };
      }
      if (path === "/api/uploads/u1/complete") throw new TypeError("Connection closed");
      if (path === "/api/uploads/u1") {
        return {
          status: "committed",
          attachment: { id: "u1", pageId: "p1", name: "clip.mp4", mime: "video/mp4", size },
        };
      }
      return {};
    });

    await expect(uploadAttachment("p1", fileOfSize(size))).resolves.toMatchObject({ id: "u1" });
    expect(vi.mocked(api).mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
  });

  it("retries completion while status reports the R2 object is complete", async () => {
    const size = 9 * 1024 * 1024;
    let completions = 0;
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === "/api/pages/p1/uploads") {
        return { upload: { id: "u1", partSize: 5 * 1024 * 1024, partCount: 2 } };
      }
      if (path === "/api/uploads/u1/complete") {
        completions += 1;
        if (completions === 1) throw new ApiClientError(503, "multipart_complete_failed", "Retry.");
        return { attachment: { id: "u1", pageId: "p1", name: "clip.mp4", mime: "video/mp4", size } };
      }
      if (path === "/api/uploads/u1") return { status: "r2_complete" };
      return {};
    });

    const uploaded = uploadAttachment("p1", fileOfSize(size));
    await vi.runAllTimersAsync();

    await expect(uploaded).resolves.toMatchObject({ id: "u1" });
    expect(completions).toBe(2);
  });

  it("preserves the session after retryable completion failures", async () => {
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === "/api/pages/p1/uploads") {
        return { upload: { id: "u1", partSize: 5 * 1024 * 1024, partCount: 2 } };
      }
      if (path === "/api/uploads/u1/complete") {
        throw new ApiClientError(503, "multipart_complete_failed", "Retry later.");
      }
      if (path === "/api/uploads/u1") return { status: "completing" };
      return {};
    });

    const uploaded = uploadAttachment("p1", fileOfSize(9 * 1024 * 1024));
    const rejected = uploaded.catch((error: unknown) => error);
    await vi.runAllTimersAsync();

    await expect(rejected).resolves.toMatchObject({ message: "Retry later." });
    expect(vi.mocked(api).mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
  });
});

describe("resolveAttachmentUrl", () => {
  it("passes a relative attachment url straight through", () => {
    expect(resolveAttachmentUrl("/api/attachments/abc")).toBe("/api/attachments/abc");
  });

  it("repairs an absolute same-origin url so it survives a domain change", () => {
    expect(resolveAttachmentUrl(`${window.location.origin}/api/attachments/abc`)).toBe("/api/attachments/abc");
  });

  it("leaves an external url alone", () => {
    expect(resolveAttachmentUrl("https://example.test/logo.png")).toBe("https://example.test/logo.png");
  });

  it("never throws on something that is not a url", () => {
    expect(resolveAttachmentUrl("not a url at all")).toBe("not a url at all");
  });
});
