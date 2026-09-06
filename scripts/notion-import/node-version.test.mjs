import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SUPPORTED_NODE_RANGE, assertSupportedNode } from "./node-version.mjs";

const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));

describe("node version guard", () => {
  it("matches the repository's declared Node engine range", () => {
    expect(packageJson.engines.node).toBe(SUPPORTED_NODE_RANGE);
  });

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
