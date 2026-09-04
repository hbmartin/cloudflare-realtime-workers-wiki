import { describe, expect, it } from "vitest";
import { assertNodeSupportsTypeStripping } from "./node-version.mjs";

describe("node version guard", () => {
  it("accepts versions with TypeScript type stripping enabled by default", () => {
    for (const version of ["22.18.0", "23.6.0", "24.0.0", "25.0.0"]) {
      expect(() => assertNodeSupportsTypeStripping(version)).not.toThrow();
    }
  });

  it("rejects older versions and reports the detected runtime", () => {
    for (const version of ["22.17.9", "23.5.0", "20.11.0"]) {
      expect(() => assertNodeSupportsTypeStripping(version)).toThrow(`this is Node ${version}`);
    }
    expect(() => assertNodeSupportsTypeStripping("22.17.9")).toThrow(/Node 22\.18\+.*Node 23\.6\+.*Node 24\+/);
  });
});
