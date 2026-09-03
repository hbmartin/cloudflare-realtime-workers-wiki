import { describe, expect, it } from "vitest";
import { errorLogFields, prefixedErrorLogFields } from "./error-log";

describe("error log fields", () => {
  it("retains bounded allowlisted fields from non-Error throw values", () => {
    const thrown: { reason: string; secret: string; self?: unknown } = {
      reason: "database unavailable",
      secret: "do not log this",
    };
    thrown.self = thrown;

    expect(errorLogFields(thrown)).toEqual({
      errorName: null,
      errorMessage: null,
      errorStack: null,
      errorType: "object",
      errorValue: { reason: "database unavailable" },
    });
  });

  it("does not classify an ordinary object from its name alone", () => {
    expect(errorLogFields({ name: "primary", reason: "not selected" })).toEqual({
      errorName: null,
      errorMessage: null,
      errorStack: null,
      errorType: "object",
      errorValue: { name: "primary", reason: "not selected" },
    });
  });

  it("retains stable fields from message-only and stack-only throw values", () => {
    expect(errorLogFields({ message: "Remote failure" })).toEqual({
      errorName: null,
      errorMessage: "Remote failure",
      errorStack: null,
      errorType: "object",
    });
    expect(errorLogFields({ stack: "remote:1" })).toEqual({
      errorName: null,
      errorMessage: null,
      errorStack: "remote:1",
      errorType: "object",
    });
  });

  it("does not throw while describing a revoked Proxy", () => {
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();

    expect(errorLogFields(revocable.proxy)).toEqual({
      errorName: null,
      errorMessage: null,
      errorStack: null,
      errorType: "object",
      errorValue: "[object omitted]",
    });
  });

  it("flattens an Error cause and its safe metadata one level deep", () => {
    const cause = Object.assign(new SyntaxError("invalid JSON"), { status: 503, code: "receipt_unavailable" });
    const error = new Error("receipt decode failed", { cause });

    expect(prefixedErrorLogFields("receiptError", error)).toEqual({
      receiptErrorName: "Error",
      receiptErrorMessage: "receipt decode failed",
      receiptErrorStack: expect.any(String),
      receiptErrorType: "object",
      receiptErrorCauseName: "SyntaxError",
      receiptErrorCauseMessage: "invalid JSON",
      receiptErrorCauseStack: expect.any(String),
      receiptErrorCauseType: "object",
      receiptErrorCauseStatus: 503,
      receiptErrorCauseCode: "receipt_unavailable",
    });
  });

  it("does not read cause when cause fields are disabled", () => {
    let causeReads = 0;
    const error = {
      name: "RemoteError",
      message: "Remote failure",
      get cause() {
        causeReads += 1;
        return new Error("nested failure");
      },
    };

    expect(prefixedErrorLogFields("error", error, false)).toEqual({
      errorName: "RemoteError",
      errorMessage: "Remote failure",
      errorStack: null,
      errorType: "object",
    });
    expect(causeReads).toBe(0);
  });

  it("recognizes DOMException and cross-realm-shaped errors", () => {
    const timeout = new DOMException("The operation timed out.", "TimeoutError");
    const shaped = { name: "RemoteError", message: "Remote failure", stack: "remote:1" };

    expect(errorLogFields(timeout)).toMatchObject({
      errorName: "TimeoutError",
      errorMessage: "The operation timed out.",
      errorType: "object",
    });
    expect(errorLogFields(shaped)).toEqual({
      errorName: "RemoteError",
      errorMessage: "Remote failure",
      errorStack: "remote:1",
      errorType: "object",
    });
  });

  it("bounds logged strings", () => {
    const fields = errorLogFields("x".repeat(3_000));

    expect(fields.errorMessage).toMatch(/^x{2000}…\[truncated\]$/);
    expect(fields.errorValue).toBe(fields.errorMessage);
  });

  it("does not split a surrogate pair at the string limit", () => {
    const fields = errorLogFields(`${"x".repeat(1_999)}😀tail`);

    expect(fields.errorMessage).toBe(`${"x".repeat(1_999)}…[truncated]`);
    expect(fields.errorValue).toBe(fields.errorMessage);
  });

  it("applies field-specific bounds and omits non-finite numbers consistently", () => {
    const fields = errorLogFields({ name: "ordinary", code: "c".repeat(300), reason: "r".repeat(3_000), status: NaN });

    expect(fields.errorValue).toEqual({
      name: "ordinary",
      code: `${"c".repeat(200)}…[truncated]`,
      reason: `${"r".repeat(2_000)}…[truncated]`,
    });
    expect(errorLogFields(Infinity).errorValue).toBe("[number omitted]");
  });
});
