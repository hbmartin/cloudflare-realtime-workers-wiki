import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpError, classifyError, errorResponse, safeHttpError, safeHttpErrorCode } from "./http";

describe("HTTP error handling", () => {
  afterEach(() => vi.restoreAllMocks());

  it("logs and returns a generic response for a revoked Proxy", async () => {
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const context = {
      req: {
        method: "GET",
        url: "https://example.test/private?token=omitted",
        header: () => undefined,
      },
      json: (body: unknown, status: number) => Response.json(body, { status }),
    } as unknown as Parameters<typeof errorResponse>[0];

    expect(classifyError(revocable.proxy).expected).toBe(false);
    const response = errorResponse(context, revocable.proxy);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: { code: "internal_error", message: "Something went wrong." },
    });
    expect(logged).toHaveBeenCalledWith(
      expect.objectContaining({
        schema: "notes.observability.v1",
        event: "http.request.unhandled_error",
        severity: "error",
        component: "http",
        message: "Unhandled request error",
        requestMethod: "GET",
        requestPath: "/private",
        requestRayId: null,
        errorName: null,
        errorMessage: null,
        errorStack: null,
        errorType: "object",
        errorValue: "[object omitted]",
      }),
    );
  });

  it("returns a generic classification when an error Proxy has a hostile status", () => {
    const error = new Proxy(new HttpError(409, "conflict", "Conflict"), {
      get(target, property, receiver) {
        if (property === "status") throw new Error("status is unavailable");
        return Reflect.get(target, property, receiver);
      },
    });

    expect(classifyError(error)).toEqual({
      expected: false,
      status: 500,
      body: { error: { code: "internal_error", message: "Something went wrong." } },
    });
  });

  it("handles an HttpError code without trusting hostile properties", () => {
    const error = new HttpError(409, "conflict", "Conflict");
    const hostileCode = new Proxy(error, {
      get(target, property, receiver) {
        if (property === "code") throw new Error("code is unavailable");
        return Reflect.get(target, property, receiver);
      },
    });

    expect(safeHttpErrorCode(error)).toBe("conflict");
    expect(safeHttpErrorCode(hostileCode)).toBeNull();
    expect(classifyError(hostileCode)).toEqual({
      expected: false,
      status: 500,
      body: { error: { code: "internal_error", message: "Something went wrong." } },
    });
    expect(safeHttpErrorCode(new Error("ordinary failure"))).toBeNull();
  });

  it("reconstructs only explicitly marked serialized HTTP errors", () => {
    const original = new HttpError(409, "import_upload_missing", "Upload the file again.");
    const transported = Object.assign(new Error(original.message), Object.fromEntries(Object.entries(original)));

    expect(safeHttpError(transported)).toEqual({
      status: 409,
      code: "import_upload_missing",
      message: "Upload the file again.",
    });
    expect(classifyError(transported)).toMatchObject({
      expected: true,
      status: 409,
      body: { error: { code: "import_upload_missing", message: "Upload the file again." } },
    });
    expect(safeHttpErrorCode({ status: 409, code: "import_upload_missing", message: original.message })).toBeNull();
    expect(
      safeHttpErrorCode({
        transportKind: "realtime-notes.http-error.v1",
        status: 418,
        code: "import_upload_missing",
        message: original.message,
      }),
    ).toBeNull();
  });

  it.each([
    { transportKind: "wrong", status: 409, code: "conflict", message: "Conflict" },
    { transportKind: "realtime-notes.http-error.v1", status: 409, code: "NOT_ALLOWED", message: "Conflict" },
    { transportKind: "realtime-notes.http-error.v1", status: 409, code: "conflict", message: "" },
    { transportKind: "realtime-notes.http-error.v1", status: 409, code: "conflict", message: "x".repeat(2_001) },
  ])("rejects malformed transported HTTP errors: $code", (error) => {
    expect(safeHttpError(error)).toBeNull();
    expect(classifyError(error).expected).toBe(false);
  });

  it("rejects a marked transport object with hostile getters", () => {
    const error = new Proxy(
      {
        transportKind: "realtime-notes.http-error.v1",
        status: 409,
        code: "conflict",
        message: "Conflict",
      },
      {
        get(target, property, receiver) {
          if (property === "code") throw new Error("code is unavailable");
          return Reflect.get(target, property, receiver);
        },
      },
    );

    expect(safeHttpError(error)).toBeNull();
    expect(classifyError(error).expected).toBe(false);
  });
});
