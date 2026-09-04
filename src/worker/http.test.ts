import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpError, classifyError, errorResponse, safeHttpErrorCode } from "./http";

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
    expect(logged).toHaveBeenCalledWith("Unhandled request error", {
      requestMethod: "GET",
      requestPath: "/private",
      requestRayId: null,
      errorName: null,
      errorMessage: null,
      errorStack: null,
      errorType: "object",
      errorValue: "[object omitted]",
    });
  });

  it("returns a generic classification when an error Proxy has a hostile property trap", () => {
    const error = new Proxy(new HttpError(409, "conflict", "Conflict"), {
      get(target, property, receiver) {
        if (property === "status" || property === "code") throw new Error(`${String(property)} is unavailable`);
        return Reflect.get(target, property, receiver);
      },
    });

    expect(classifyError(error)).toEqual({
      expected: false,
      status: 500,
      body: { error: { code: "internal_error", message: "Something went wrong." } },
    });
    expect(safeHttpErrorCode(error)).toBeNull();
  });
});
