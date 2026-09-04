import { describe, expect, it } from "vitest";
import { assertSupportedNode } from "./node-version.mjs";

describe("node version guard", () => {
  it("accepts versions that strip TypeScript types natively", () => {
    expect(() => assertSupportedNode("22.18.0")).not.toThrow();
    expect(() => assertSupportedNode("24.2.0")).not.toThrow();
    expect(() => assertSupportedNode("25.0.0")).not.toThrow();
  });

  it("rejects versions that would fail on the shared TypeScript imports", () => {
    expect(() => assertSupportedNode("22.17.9")).toThrow(/Node 22\.18\+.*Node 24\.2\+/);
    expect(() => assertSupportedNode("23.5.0")).toThrow(/Node 22\.18\+.*Node 24\.2\+/);
    expect(() => assertSupportedNode("24.1.0")).toThrow(/Node 22\.18\+.*Node 24\.2\+/);
    expect(() => assertSupportedNode("20.11.0")).toThrow(/Node 22\.18\+.*Node 24\.2\+/);
  });
});
