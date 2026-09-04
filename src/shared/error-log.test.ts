import { describe, expect, it } from "vitest";
import {
  LOG_TEXT_LIMIT,
  PERSISTED_ERROR_MESSAGE_LIMIT,
  errorLogFields,
  prefixedErrorLogFields,
  safeErrorMessage,
} from "./error-log";

const TRUNCATION_MARKER = "…[truncated]";

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
    expect(
      errorLogFields({
        message: "Remote failure",
        reason: "socket closed",
        errno: -5,
        syscall: "read",
        status: "503",
        code: 12,
      }),
    ).toEqual({
      errorName: null,
      errorMessage: "Remote failure",
      errorStack: null,
      errorType: "object",
      errorCode: "12",
      errorReason: "socket closed",
      errorErrno: -5,
      errorSyscall: "read",
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
    expect(safeErrorMessage(revocable.proxy, "Unknown failure")).toBe("Unknown failure");
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

    expect(fields.errorMessage).toBe(`${"x".repeat(LOG_TEXT_LIMIT - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`);
    expect(fields.errorMessage).toHaveLength(LOG_TEXT_LIMIT);
    expect(fields.errorValue).toBe(fields.errorMessage);
  });

  it("does not split a surrogate pair at the string limit", () => {
    const payloadLimit = LOG_TEXT_LIMIT - TRUNCATION_MARKER.length;
    const fields = errorLogFields(`${"x".repeat(payloadLimit - 1)}😀${"tail".repeat(100)}`);

    expect(fields.errorMessage).toBe(`${"x".repeat(payloadLimit - 1)}${TRUNCATION_MARKER}`);
    expect(fields.errorValue).toBe(fields.errorMessage);
  });

  it("uses a non-empty bounded fallback for persisted error messages", () => {
    expect(safeErrorMessage("  Thrown string failure \n", "Unknown failure")).toBe("Thrown string failure");
    expect(safeErrorMessage(" \n\t", "Unknown failure")).toBe("Unknown failure");
    expect(safeErrorMessage({ message: "" }, "Unknown failure")).toBe("Unknown failure");
    expect(safeErrorMessage({ message: " \n\t" }, "Unknown failure")).toBe("Unknown failure");
    expect(safeErrorMessage({ message: "  Remote failure \n" }, "Unknown failure")).toBe("Remote failure");
    expect(
      safeErrorMessage(
        { message: `${" ".repeat(PERSISTED_ERROR_MESSAGE_LIMIT + 1)}Remote failure` },
        "Unknown failure",
      ),
    ).toBe("Remote failure");
    expect(safeErrorMessage(new Error("x".repeat(2_000)), "Unknown failure")).toBe(
      `${"x".repeat(PERSISTED_ERROR_MESSAGE_LIMIT - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`,
    );
    expect(safeErrorMessage(new Error("x".repeat(2_000)), "Unknown failure")).toHaveLength(
      PERSISTED_ERROR_MESSAGE_LIMIT,
    );
  });

  it("truncates a trimmed persisted error without splitting a surrogate pair", () => {
    const payloadLimit = PERSISTED_ERROR_MESSAGE_LIMIT - TRUNCATION_MARKER.length;
    const message = `  ${"x".repeat(payloadLimit - 1)}😀${"tail".repeat(100)} \n`;

    expect(safeErrorMessage({ message }, "Unknown failure")).toBe(
      `${"x".repeat(payloadLimit - 1)}${TRUNCATION_MARKER}`,
    );
  });

  it("applies field-specific bounds and preserves non-finite numbers as strings", () => {
    const fields = errorLogFields({ name: "ordinary", code: "c".repeat(300), reason: "r".repeat(3_000), status: NaN });

    expect(fields.errorValue).toEqual({
      name: "ordinary",
      code: `${"c".repeat(200 - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`,
      reason: `${"r".repeat(LOG_TEXT_LIMIT - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`,
      status: "NaN",
    });
    expect(errorLogFields(NaN).errorValue).toBe("NaN");
    expect(errorLogFields(Infinity).errorValue).toBe("Infinity");
    expect(errorLogFields(-Infinity).errorValue).toBe("-Infinity");
  });
});
