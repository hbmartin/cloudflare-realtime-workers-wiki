import { describe, expect, it } from "vitest";
import { assertSupportedNode } from "./node-version.mjs";

describe("node version guard", () => {
  it("accepts versions in the repository's supported Node ranges", () => {
    for (const version of ["22.18.0", "24.2.0", "25.0.0"]) {
      expect(() => assertSupportedNode(version)).not.toThrow();
    }
  });

  it("rejects versions outside the repository's supported Node ranges and reports the detected runtime", () => {
    for (const version of ["22.17.9", "23.6.0", "24.1.0", "20.11.0"]) {
      expect(() => assertSupportedNode(version)).toThrow(`this is Node ${version}`);
    }
    expect(() => assertSupportedNode("22.17.9")).toThrow(/Node 22\.18\+.*Node 24\.2\+/);
  });
});
