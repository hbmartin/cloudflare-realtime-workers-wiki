import { describe, expect, it } from "vitest";
import { errorMessageKey } from "./error-messages";

describe("errorMessageKey", () => {
  it("keeps punctuation-only messages distinct instead of returning an empty key", () => {
    expect(errorMessageKey(".")).toBe(".");
    expect(errorMessageKey("!!!")).toBe("!!!");
  });
});
