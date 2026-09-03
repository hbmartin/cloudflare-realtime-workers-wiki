import { describe, expect, it } from "vitest";
import { errorLogFields, prefixedErrorLogFields } from "./error-log";

describe("error log fields", () => {
  it("describes non-Error throw values without retaining their properties", () => {
    const thrown = { reason: "database unavailable" };

    expect(errorLogFields(thrown)).toEqual({
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
});
