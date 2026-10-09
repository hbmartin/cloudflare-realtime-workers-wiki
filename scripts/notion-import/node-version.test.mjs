import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SUPPORTED_NODE_RANGE, assertSupportedNode } from "./node-version.mjs";

const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));

describe("node version guard", () => {
  it("matches the repository's declared Node engine range", () => {
    expect(packageJson.engines.node).toBe(SUPPORTED_NODE_RANGE);
  });

  it("accepts versions in the repository's supported Node ranges", () => {
    for (const version of ["22.22.2", "22.22.3", "22.23.0", "24.15.0", "24.21.0", "26.0.0", "27.0.0"]) {
      expect(() => assertSupportedNode(version)).not.toThrow();
    }
  });

  it("rejects versions outside the repository's supported Node ranges and reports the detected runtime", () => {
    for (const version of ["22.22.1", "22.21.9", "23.6.0", "24.14.9", "25.0.0", "20.11.0"]) {
      expect(() => assertSupportedNode(version)).toThrow(`this is Node ${version}`);
    }
    expect(() => assertSupportedNode("22.22.1")).toThrow(`Node ${SUPPORTED_NODE_RANGE}`);
  });
});
