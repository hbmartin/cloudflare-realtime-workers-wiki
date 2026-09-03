import { describe, expect, it } from "vitest";
import { errorLogFields, prefixedErrorLogFields } from "./error-log";

describe("error log fields", () => {
  it("preserves non-Error throw values", () => {
    const thrown = { reason: "database unavailable" };

    expect(errorLogFields(thrown)).toEqual({
      errorName: null,
      errorMessage: null,
      errorStack: null,
      errorType: "object",
      errorValue: thrown,
    });
  });

  it("flattens an Error cause one level deep", () => {
    const cause = new SyntaxError("invalid JSON");
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
    });
  });
});
