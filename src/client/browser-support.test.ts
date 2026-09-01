import { describe, expect, it, vi } from "vitest";
import { browserSupportsRequiredFeatures } from "./browser-support";

const supportedCapabilities = {
  any: vi.fn(),
  timeout: vi.fn(),
  prototype: { throwIfAborted: vi.fn() },
};

describe("browserSupportsRequiredFeatures", () => {
  it("accepts a runtime with every required AbortSignal capability", () => {
    expect(browserSupportsRequiredFeatures(supportedCapabilities)).toBe(true);
  });

  it.each([
    ["AbortSignal", null],
    ["AbortSignal.any", { ...supportedCapabilities, any: undefined }],
    ["AbortSignal.timeout", { ...supportedCapabilities, timeout: undefined }],
    ["AbortSignal.throwIfAborted", { ...supportedCapabilities, prototype: {} }],
  ])("rejects a runtime without %s", (_label, capabilities) => {
    expect(browserSupportsRequiredFeatures(capabilities)).toBe(false);
  });
});
